import {appendFile, mkdir} from 'node:fs/promises';
import type {ChatMessage, Provider} from '../llm/index.js';
import {resolve, VAULT} from '../vault/paths.js';
import {composeSystemPrompt, type InterviewKind} from './prompts.js';
import {
	transcriptId,
	type Exchange,
	type Transcript,
	type TranscriptStatus,
} from './transcript.js';

/**
 * The minimum viable set, per the spec's exit-ramp requirement: "Every
 * interview has a minimum viable set — when you have it, say so plainly."
 * Below this the interviewer keeps going; at or above it the UI offers to wrap.
 */
const MINIMUM_EXCHANGES: Readonly<Record<InterviewKind, number>> = {
	system: 6,
	character: 6,
	moment: 6,
	arc: 5,
	place: 4,
	// A scene needs a cast, a place, a moment and an arc. Four answers is a
	// complete one, and pressing past that is where an interviewer starts
	// asking the author to dictate prose it must not touch.
	situation: 4,
	faction: 5,
	artifact: 4,
	theme: 5,
	chapter: 4,
	timeline: 6,
	themes: 5,
};

/** The spec's "target 8–15 exchanges"; past this the UI nudges toward wrapping. */
const TARGET_EXCHANGES = 15;

const KICKOFF =
	'Begin the interview. Ask your first question — one question, nothing else.';

/**
 * A flattening answer is the spec's other stop signal: "Never continue past the
 * point where their answers get shorter and flatter." Two consecutive answers
 * under this length, after the minimum, counts as flattening.
 */
const FLAT_ANSWER_CHARS = 40;

export type SessionOptions = {
	readonly root: string;
	readonly kind: InterviewKind;
	readonly provider: Provider;
	readonly grounding: string;
	readonly focus?: string | undefined;
	/** Profile overlay appended to the base brief (multi-genre §5). */
	readonly overlay?: string;
	/**
	 * Restores an unfinished interview. The exchanges are replayed into the
	 * message list, so the model sees the whole prior conversation and continues
	 * it rather than restarting — and the same transcript file keeps being
	 * written, so resuming twice does not litter `raw/interviews/`.
	 */
	readonly resumeFrom?: Transcript;
	/** Injected so transcripts and metrics are reproducible in tests. */
	readonly now?: Date;
};

export type SessionStatus = {
	readonly exchanges: number;
	readonly minimum: number;
	/** True once the interview has enough to be worth extracting. */
	readonly minimumReached: boolean;
	/** True when the author's answers are trailing off, or we are past target. */
	readonly shouldOfferExit: boolean;
};

export type QuestionMetric = {
	readonly index: number;
	readonly question: string;
	readonly answerChars: number;
};

/**
 * Drives one interview: composes the prompt, streams each question, records
 * answers, and tracks when it is fair to stop.
 *
 * It deliberately owns no UI and no disk writes beyond metrics — the caller
 * renders the stream and decides when to persist the transcript.
 */
export class InterviewSession {
	readonly kind: InterviewKind;
	readonly id: string;
	readonly startedAt: string;
	readonly focus: string | undefined;

	readonly #provider: Provider;
	readonly #systemPrompt: string;
	readonly #root: string;
	readonly #exchanges: Exchange[] = [];
	#pendingQuestion: string | undefined;
	#resumedWith = 0;

	#status: TranscriptStatus = 'in-progress';

	constructor(options: SessionOptions) {
		const now = options.now ?? new Date();
		const prior = options.resumeFrom;

		this.kind = options.kind;
		this.focus = options.focus;
		this.id = prior?.id ?? transcriptId(options.kind, now, options.focus);
		this.startedAt = prior?.startedAt ?? now.toISOString();

		if (prior) {
			this.#exchanges.push(...prior.exchanges);
			this.#resumedWith = prior.exchanges.length;
		}
		this.#provider = options.provider;
		this.#root = options.root;
		this.#systemPrompt = composeSystemPrompt(
			options.kind,
			options.grounding,
			options.overlay ?? '',
		);
	}

	get systemPrompt(): string {
		return this.#systemPrompt;
	}

	get exchanges(): readonly Exchange[] {
		return this.#exchanges;
	}

	get resumed(): boolean {
		return this.#resumedWith > 0;
	}

	/** How many exchanges were already on disk when this session opened. */
	get resumedWith(): number {
		return this.#resumedWith;
	}

	/** Marks the interview finished so it stops offering itself for resume. */
	complete(): void {
		this.#status = 'complete';
	}

	/** The exact message list sent to the provider for the next question. */
	buildMessages(): ChatMessage[] {
		const messages: ChatMessage[] = [
			{role: 'system', content: this.#systemPrompt},
			{role: 'user', content: KICKOFF},
		];

		for (const exchange of this.#exchanges) {
			messages.push({role: 'assistant', content: exchange.question});
			messages.push({role: 'user', content: exchange.answer});
		}

		return messages;
	}

	/**
	 * Streams the next question. Deltas are yielded as they arrive — the spec
	 * calls streaming more important here than anywhere else in the app, because
	 * a pause before every question kills the conversational feel.
	 */
	async *ask(signal: AbortSignal): AsyncIterable<string> {
		let buffer = '';
		for await (const delta of this.#provider.chat(this.buildMessages(), signal)) {
			buffer += delta;
			yield delta;
		}

		const question = buffer.trim();
		// A cancelled turn leaves nothing pending, so the next ask() re-asks
		// rather than pairing an answer with half a question.
		this.#pendingQuestion = question === '' ? undefined : question;
	}

	get pendingQuestion(): string | undefined {
		return this.#pendingQuestion;
	}

	/** Pairs the author's answer with the question that earned it. */
	async recordAnswer(answer: string): Promise<void> {
		const question = this.#pendingQuestion;
		if (question === undefined) {
			throw new Error('no question is pending');
		}

		const trimmed = answer.trim();
		this.#exchanges.push({question, answer: trimmed});
		this.#pendingQuestion = undefined;
		await this.#recordMetric(question, trimmed.length);
	}

	status(): SessionStatus {
		const count = this.#exchanges.length;
		const minimum = MINIMUM_EXCHANGES[this.kind];
		const minimumReached = count >= minimum;

		const recent = this.#exchanges.slice(-2);
		const flattening =
			recent.length === 2 &&
			recent.every(exchange => exchange.answer.length < FLAT_ANSWER_CHARS);

		return {
			exchanges: count,
			minimum,
			minimumReached,
			shouldOfferExit: minimumReached && (flattening || count >= TARGET_EXCHANGES),
		};
	}

	toTranscript(): Transcript {
		return {
			id: this.id,
			kind: this.kind,
			startedAt: this.startedAt,
			...(this.focus === undefined ? {} : {focus: this.focus}),
			status: this.#status,
			exchanges: [...this.#exchanges],
		};
	}

	/** Questions ranked by how much the author wrote in reply. */
	metrics(): QuestionMetric[] {
		return this.#exchanges
			.map((exchange, index) => ({
				index: index + 1,
				question: exchange.question,
				answerChars: exchange.answer.length,
			}))
			.toSorted((a, b) => b.answerChars - a.answerChars);
	}

	/**
	 * Appends one metric line to `.litrpg/`. The spec asks for this explicitly:
	 * prompt quality is the product here, so which questions earn long answers
	 * is evidence for tuning. It lives in the cache because it is derived and
	 * disposable (DoD 11).
	 */
	async #recordMetric(question: string, answerChars: number): Promise<void> {
		try {
			await mkdir(resolve(this.#root, VAULT.meta), {recursive: true});
			const line = JSON.stringify({
				interview: this.id,
				kind: this.kind,
				exchange: this.#exchanges.length,
				answer_chars: answerChars,
				question: question.slice(0, 300),
			});
			await appendFile(
				resolve(this.#root, `${VAULT.meta}/interview-metrics.jsonl`),
				`${line}\n`,
				'utf8',
			);
		} catch {
			// Instrumentation must never break an interview in progress.
		}
	}
}

export {MINIMUM_EXCHANGES, TARGET_EXCHANGES};
