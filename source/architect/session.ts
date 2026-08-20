import type {Project} from '../core/project.js';
import {buildReviewerContext} from '../reviewer/corpus.js';
import type {ConversationTurn} from '../conversation/types.js';
import type {ChatMessage, Provider} from '../llm/index.js';
import {ARCHITECT_PERSONA} from './prompts.js';
import {buildRawContext, renderRawContext} from './raw.js';
import {
	DIRECTIVE_LINE,
	MAX_ROUNDS,
	openFiles,
	parsePlan,
	parseRequest,
	renderOpened,
} from './open.js';

export type ArchitectSessionOptions = {
	readonly root: string;
	readonly project: Project;
	readonly provider: Provider;
	/** Tone guidance from the genre profile, so it speaks the vault's idiom. */
	readonly register: string;
};

/**
 * The conversation half of `/architect`.
 *
 * It sees both halves of the vault, which is the whole point: `/reviewer` reads
 * the corpus and cannot tell you what the transcript said, and an extraction
 * reads the transcript and cannot tell you what the corpus already holds. The
 * questions worth asking here — did this interview establish two systems? is
 * anything in the raw material that never reached a page? — need both open at
 * once.
 *
 * Grounding is rebuilt per question, the same as `ReviewerSession`: a session that
 * grounded once would answer its fifth question with the files that mattered to
 * its first.
 */
export class ArchitectSession {
	readonly #options: ArchitectSessionOptions;
	#turns: ConversationTurn[] = [];
	/**
	 * What the last reply asked to have planned, if anything.
	 *
	 * Read by the caller after `ask` finishes, and cleared when the next one
	 * starts, so a plan directive can never outlive the reply that made it.
	 */
	#plan: string | undefined;

	constructor(options: ArchitectSessionOptions) {
		this.#options = options;
	}

	get turns(): readonly ConversationTurn[] {
		return this.#turns;
	}

	get pendingPlan(): string | undefined {
		return this.#plan;
	}

	async messagesFor(
		question: string,
		opened: readonly string[] = [],
	): Promise<ChatMessage[]> {
		const {root, project, register} = this.#options;
		const [corpus, raw] = await Promise.all([
			buildReviewerContext(root, project, question),
			buildRawContext(root, question),
		]);

		const system = [
			ARCHITECT_PERSONA,
			'',
			register === '' ? '' : `Register: ${register}`,
			'',
			'# The corpus',
			'',
			corpus,
			'',
			'# The raw material',
			'',
			renderRawContext(raw),
		]
			.filter(part => part !== '')
			.join('\n');

		return [
			{role: 'system', content: system},
			...this.#turns.map((turn): ChatMessage => ({
				role: turn.role === 'author' ? 'user' : 'assistant',
				content: turn.text,
			})),
			{role: 'user', content: question},
			// Appended as user turns rather than folded into the system prompt, so
			// the model reads them as an answer to what it just asked for.
			...opened.map((content): ChatMessage => ({role: 'user', content})),
		];
	}

	/**
	 * Answers, opening files it asks for along the way.
	 *
	 * The architect is given a map of the whole corpus and the full text of
	 * whatever scored highest against the question, which is a guess made before
	 * it has read anything. It routinely discovers mid-reasoning that it needs a
	 * page the guess missed — and the honest thing it did then was refuse to
	 * rewrite a file it could not see and ask the author to paste it. That is
	 * correct behaviour and a terrible experience.
	 *
	 * So it can ask. A reply that begins `READ:` is intercepted rather than
	 * shown, the files are opened, and the question is put again with them
	 * attached. The author sees a status line and the eventual answer, never the
	 * request.
	 */
	async *ask(question: string, signal: AbortSignal): AsyncGenerator<string> {
		const opened: string[] = [];
		let reply = '';
		this.#plan = undefined;

		for (let round = 0; ; round++) {
			const messages = await this.messagesFor(question, opened);

			/**
			 * Streamed a line at a time, holding each until its newline arrives so
			 * a `READ:` line can be swallowed without swallowing the reasoning
			 * around it. The author sees why it wants a file; they never see the
			 * request itself, and never a request that nothing acted on.
			 */
			let pending = '';
			let directed = false;
			const canRead = round < MAX_ROUNDS;
			reply = '';

			for await (const delta of this.#options.provider.chat(messages, signal)) {
				reply += delta;

				if (!canRead) {
					yield delta;
					continue;
				}

				// Once a directive starts, nothing more reaches the screen: it often
				// wraps onto a second line, and half a path list is worse to look at
				// than none of it. There is nothing to say after one anyway.
				if (directed) {
					continue;
				}

				pending += delta;
				let ending = pending.indexOf('\n');
				while (ending !== -1) {
					const line = pending.slice(0, ending + 1);
					pending = pending.slice(ending + 1);
					if (DIRECTIVE_LINE.test(line)) {
						directed = true;
						pending = '';
						break;
					}
					yield line;
					ending = pending.indexOf('\n');
				}
			}

			// The last line has no newline to close it.
			if (canRead && !directed && pending !== '') {
				if (DIRECTIVE_LINE.test(pending)) {
					directed = true;
				} else {
					yield pending;
				}
			}

			// Reading comes first when a reply asks for both: files are what the
			// plan would be written from.
			const wanted = directed ? parseRequest(reply) : undefined;
			if (wanted === undefined || wanted.length === 0) {
				break;
			}

			const files = await openFiles(this.#options.root, wanted);
			opened.push(renderOpened(files));
		}

		this.#plan = parsePlan(reply);
		this.#turns = [
			...this.#turns,
			{role: 'author', text: question},
			{role: 'agent', text: reply},
		];
	}

	/** Records a turn the session did not generate, e.g. a plan summary. */
	note(text: string): void {
		this.#turns = [...this.#turns, {role: 'agent', text}];
	}

	recordFailure(question: string, message: string): void {
		this.#turns = [
			...this.#turns,
			{role: 'author', text: question},
			{role: 'agent', text: message},
		];
	}
}
