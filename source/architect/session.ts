import type {Project} from '../core/project.js';
import {buildReviewerContext} from '../reviewer/corpus.js';
import type {ConversationTurn} from '../conversation/types.js';
import type {ChatMessage, Provider} from '../llm/index.js';
import {ARCHITECT_PERSONA} from './prompts.js';
import {buildRawContext, renderRawContext} from './raw.js';
import {
	MAX_ROUNDS,
	openFiles,
	parseRequest,
	renderOpened,
	REQUEST_PREFIX,
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

	constructor(options: ArchitectSessionOptions) {
		this.#options = options;
	}

	get turns(): readonly ConversationTurn[] {
		return this.#turns;
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

		for (let round = 0; ; round++) {
			const messages = await this.messagesFor(question, opened);

			/**
			 * Held back until it is clear whether this is an answer or a request:
			 * `READ:` is the shortest prefix that settles it, so the delay costs a
			 * few characters rather than the whole reply.
			 *
			 * A request is consumed to the end rather than abandoned early — the
			 * paths are what the round is for, and stopping at the prefix leaves
			 * nothing to open.
			 */
			let head = '';
			let mode: 'deciding' | 'answering' | 'reading' =
				round < MAX_ROUNDS ? 'deciding' : 'answering';
			reply = '';

			for await (const delta of this.#options.provider.chat(messages, signal)) {
				reply += delta;

				if (mode === 'answering') {
					yield delta;
					continue;
				}
				if (mode === 'reading') {
					continue;
				}

				head += delta;
				if (head.length < REQUEST_PREFIX.length) {
					continue;
				}
				if (head.trimStart().toUpperCase().startsWith(REQUEST_PREFIX)) {
					mode = 'reading';
					continue;
				}
				mode = 'answering';
				yield head;
			}

			// A reply that finished inside the lookahead was never flushed.
			if (mode === 'deciding' && head !== '') {
				yield head;
			}

			const wanted = mode === 'reading' ? parseRequest(reply) : undefined;
			if (wanted === undefined || wanted.length === 0) {
				break;
			}

			const files = await openFiles(this.#options.root, wanted);
			opened.push(renderOpened(files));
		}

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
