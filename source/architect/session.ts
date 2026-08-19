import type {Project} from '../core/project.js';
import {buildReviewerContext} from '../reviewer/corpus.js';
import type {ConversationTurn} from '../conversation/types.js';
import type {ChatMessage, Provider} from '../llm/index.js';
import {ARCHITECT_PERSONA} from './prompts.js';
import {buildRawContext, renderRawContext} from './raw.js';

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

	async messagesFor(question: string): Promise<ChatMessage[]> {
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
		];
	}

	async *ask(question: string, signal: AbortSignal): AsyncGenerator<string> {
		const messages = await this.messagesFor(question);

		let reply = '';
		for await (const delta of this.#options.provider.chat(messages, signal)) {
			reply += delta;
			yield delta;
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
