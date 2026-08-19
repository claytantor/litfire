import type {Project} from '../core/project.js';
import type {ChatMessage, Provider} from '../llm/index.js';
import {buildEditorContext} from './corpus.js';
import {EDITOR_PERSONA} from './prompts.js';
import type {EditorTurn} from './types.js';

export type EditorSessionOptions = {
	readonly root: string;
	readonly project: Project;
	readonly provider: Provider;
	/** Tone guidance from the genre profile, so the editor speaks the vault's idiom. */
	readonly register: string;
};

/**
 * The conversation half of `/editor`.
 *
 * Grounding is rebuilt per question rather than once per session: the corpus map
 * always ships, but which files' full text comes with it depends on what was
 * just asked. A session that grounded once would answer its fifth question with
 * the files that mattered to its first.
 */
export class EditorSession {
	readonly #options: EditorSessionOptions;
	#turns: EditorTurn[] = [];

	constructor(options: EditorSessionOptions) {
		this.#options = options;
	}

	get turns(): readonly EditorTurn[] {
		return this.#turns;
	}

	async messagesFor(question: string): Promise<ChatMessage[]> {
		const {root, project, register} = this.#options;
		const context = await buildEditorContext(root, project, question);

		const system = [
			EDITOR_PERSONA,
			'',
			register === '' ? '' : `Register: ${register}`,
			'',
			'# The corpus',
			'',
			context,
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

	/**
	 * Streams one reply, recording the exchange only once it completes.
	 *
	 * A partial reply is never recorded — the next question must not be grounded
	 * on half an answer the author never saw finish. When a stream fails or is
	 * cancelled the caller records the failure instead, so the question itself
	 * still survives in the history.
	 */
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
			{role: 'editor', text: reply},
		];
	}

	/** Records a turn the session did not generate, e.g. a correction-pass summary. */
	note(text: string): void {
		this.#turns = [...this.#turns, {role: 'editor', text}];
	}

	/**
	 * Records a question whose reply never arrived.
	 *
	 * The partial text is deliberately discarded, but the question is not: losing
	 * it would leave the author looking at a conversation that does not show what
	 * they just typed.
	 */
	recordFailure(question: string, message: string): void {
		this.#turns = [
			...this.#turns,
			{role: 'author', text: question},
			{role: 'editor', text: message},
		];
	}
}
