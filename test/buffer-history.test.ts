import {describe, expect, it} from 'vitest';
import {createBuffer, insert, backspace, toText, move} from '../source/editor/buffer.js';
import {
	canRedo,
	canUndo,
	createHistory,
	MAX_STEPS,
	record,
	redo,
	seal,
	undo,
} from '../source/editor/history.js';

/** Types `text` one character at a time, the way the buffer component does. */
function type(history: ReturnType<typeof createHistory>, text: string) {
	let current = history;
	for (const character of text) {
		current = record(current, insert(current.present, character), true);
	}
	return current;
}

describe('history', () => {
	it('starts with nothing to undo', () => {
		const history = createHistory(createBuffer('one'));

		expect(canUndo(history)).toBe(false);
		expect(canRedo(history)).toBe(false);
		expect(undo(history)).toBe(history);
	});

	it('coalesces a run of typing into a single step', () => {
		const history = type(createHistory(createBuffer('')), 'hello');

		expect(toText(history.present)).toBe('hello');
		// Not five steps: an undo that gives back one character at a time is, for
		// prose, the same as having no undo.
		expect(toText(undo(history).present)).toBe('');
	});

	it('breaks the run on an edit that is not typing', () => {
		let history = type(createHistory(createBuffer('')), 'hello');
		history = record(history, backspace(history.present));
		history = type(history, '!');

		expect(toText(history.present)).toBe('hell!');
		expect(toText(undo(history).present)).toBe('hell');
		expect(toText(undo(undo(history)).present)).toBe('hello');
	});

	it('breaks the run when the cursor moves away', () => {
		let history = type(createHistory(createBuffer('')), 'ab');
		history = seal({...history, present: move(history.present, 'home')});
		history = type(history, 'X');

		expect(toText(history.present)).toBe('Xab');
		// Only the second run comes back, because moving sealed the first.
		expect(toText(undo(history).present)).toBe('ab');
	});

	it('redoes what it undid, and forgets it once something new is typed', () => {
		const history = type(createHistory(createBuffer('')), 'draft');
		const back = undo(history);

		expect(canRedo(back)).toBe(true);
		expect(toText(redo(back).present)).toBe('draft');

		const diverged = type(back, 'other');
		expect(canRedo(diverged)).toBe(false);
		expect(toText(diverged.present)).toBe('other');
	});

	it('caps the stack rather than retaining every version of a long scene', () => {
		let history = createHistory(createBuffer(''));
		for (let index = 0; index <= MAX_STEPS + 20; index++) {
			history = record(history, insert(history.present, 'x'));
		}

		expect(history.past.length).toBe(MAX_STEPS);
	});
});

describe('prose motions', () => {
	it('walks by word, treating punctuation inside a word as part of it', () => {
		// `don't` and `sit-014` are one word each in prose; a code editor's notion
		// of a word would stop the cursor inside both.
		const buffer = createBuffer("don't stop sit-014");
		const atStop = move(buffer, 'word-right');

		expect(atStop.cursor.column).toBe(6);
		expect(move(atStop, 'word-right').cursor.column).toBe(11);
		expect(move(move(atStop, 'word-right'), 'word-left').cursor.column).toBe(6);
	});

	it('crosses the line break rather than stalling on it', () => {
		const buffer = createBuffer('one\ntwo');
		const endOfFirst = move(buffer, 'end');

		expect(move(endOfFirst, 'word-right').cursor).toEqual({line: 1, column: 0});
		expect(move({...buffer, cursor: {line: 1, column: 0}}, 'word-left').cursor).toEqual({
			line: 0,
			column: 3,
		});
	});

	it('pages by the viewport height it is given', () => {
		const buffer = createBuffer(
			Array.from({length: 40}, (_, i) => `line ${i}`).join('\n'),
		);
		const down = move(buffer, 'page-down', 12);

		expect(down.cursor.line).toBe(12);
		expect(move(down, 'page-up', 12).cursor.line).toBe(0);
		// Clamped at the ends rather than running off.
		expect(move(buffer, 'page-up', 12).cursor.line).toBe(0);
		expect(move(buffer, 'page-down', 999).cursor.line).toBe(39);
	});
});
