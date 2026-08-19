import type {Buffer} from './buffer.js';

/**
 * Undo/redo for the prose buffer.
 *
 * Cheap because `Buffer` is already immutable — every operation in `buffer.ts`
 * returns a new one, so a history is a list of values that were going to exist
 * anyway rather than a log of reversible edits.
 *
 * An author writing a scene will type a sentence, dislike it, and want it gone
 * in one stroke. That is why typing coalesces: an undo stack that gives back
 * one character per press is, for prose, the same as having no undo.
 */
export type History = {
	readonly past: readonly Buffer[];
	readonly present: Buffer;
	readonly future: readonly Buffer[];
	/**
	 * Whether the newest step is still absorbing typed characters. Cleared by
	 * anything that is not a contiguous insertion, which is what makes a run of
	 * typing one undo step and a deletion its own.
	 */
	readonly open: boolean;
};

/**
 * Steps kept before the oldest is dropped.
 *
 * A cap rather than unbounded: a long writing session in a large scene would
 * otherwise retain every intermediate version of the whole text, and the value
 * of the thousandth-oldest undo is not worth the memory.
 */
export const MAX_STEPS = 200;

export function createHistory(present: Buffer): History {
	return {past: [], present, future: [], open: false};
}

/**
 * Records an edit.
 *
 * `coalesce` marks an edit that may merge into the previous one — a typed
 * character. Anything else (a deletion, a newline, a paste) closes the run, so
 * the next undo stops at the boundary the author would expect.
 */
export function record(history: History, next: Buffer, coalesce = false): History {
	if (coalesce && history.open) {
		return {...history, present: next, future: []};
	}

	const past = [...history.past, history.present].slice(-MAX_STEPS);
	return {past, present: next, future: [], open: coalesce};
}

/** Closes the current run without recording, so the next keystroke starts a step. */
export function seal(history: History): History {
	return history.open ? {...history, open: false} : history;
}

export function canUndo(history: History): boolean {
	return history.past.length > 0;
}

export function canRedo(history: History): boolean {
	return history.future.length > 0;
}

export function undo(history: History): History {
	const previous = history.past.at(-1);
	if (previous === undefined) {
		return history;
	}

	return {
		past: history.past.slice(0, -1),
		present: previous,
		future: [history.present, ...history.future],
		open: false,
	};
}

export function redo(history: History): History {
	const [next, ...rest] = history.future;
	if (next === undefined) {
		return history;
	}

	return {
		past: [...history.past, history.present],
		present: next,
		future: rest,
		open: false,
	};
}
