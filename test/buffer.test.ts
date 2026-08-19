import {describe, expect, it} from 'vitest';
import {
	backspace,
	createBuffer,
	deleteForward,
	insert,
	killLine,
	move,
	newline,
	toText,
	type Buffer,
} from '../source/editor/buffer.js';

/** Places the cursor without going through the keyboard. */
const at = (buffer: Buffer, line: number, column: number): Buffer => {
	let placed = move(buffer, 'top');
	for (let index = 0; index < line; index++) {
		placed = move(placed, 'down');
	}
	placed = move(placed, 'home');
	for (let index = 0; index < column; index++) {
		placed = move(placed, 'right');
	}
	return placed;
};

const FRONTMATTER = '---\nid: a\n---\n\n# A\n';

describe('buffer round trip', () => {
	it('returns the exact text it was given, trailing newline and all', () => {
		expect(toText(createBuffer(FRONTMATTER))).toBe(FRONTMATTER);
	});

	it('returns the exact text it was given without a trailing newline', () => {
		const withoutTrailing = '---\nid: a\n---\n\n# A';
		expect(toText(createBuffer(withoutTrailing))).toBe(withoutTrailing);
	});

	it('distinguishes one trailing newline from two', () => {
		expect(toText(createBuffer('a\n'))).toBe('a\n');
		expect(toText(createBuffer('a\n\n'))).toBe('a\n\n');
	});

	it('round-trips the empty document', () => {
		const buffer = createBuffer('');
		expect(buffer.lines).toEqual(['']);
		expect(toText(buffer)).toBe('');
	});

	it('models a trailing newline as a final empty line the cursor can reach', () => {
		const buffer = createBuffer('a\n');
		expect(buffer.lines).toEqual(['a', '']);
		expect(move(buffer, 'bottom').cursor).toEqual({line: 1, column: 0});
	});

	it('starts at the top of the document', () => {
		expect(createBuffer(FRONTMATTER).cursor).toEqual({line: 0, column: 0});
	});
});

describe('buffer insert', () => {
	it('inserts at the cursor and carries it along', () => {
		const buffer = insert(createBuffer('ac\n'), 'b');
		expect(toText(buffer)).toBe('bac\n');
		expect(buffer.cursor).toEqual({line: 0, column: 1});
	});

	it('inserts mid-line', () => {
		const buffer = insert(at(createBuffer('ac\n'), 0, 1), 'b');
		expect(toText(buffer)).toBe('abc\n');
		expect(buffer.cursor).toEqual({line: 0, column: 2});
	});

	it('splices a multi-line paste and lands at the end of it', () => {
		const buffer = insert(at(createBuffer('ad\n'), 0, 1), 'b\nxx\nc');
		expect(toText(buffer)).toBe('ab\nxx\ncd\n');
		expect(buffer.cursor).toEqual({line: 2, column: 1});
	});

	it('treats CRLF and lone CR in a paste as line breaks', () => {
		expect(toText(insert(createBuffer(''), 'a\r\nb\rc'))).toBe('a\nb\nc');
	});

	it('keeps a paste that ends in a newline as a trailing empty line', () => {
		const buffer = insert(createBuffer(''), 'a\n');
		expect(toText(buffer)).toBe('a\n');
		expect(buffer.cursor).toEqual({line: 1, column: 0});
	});

	it('is a no-op for empty text', () => {
		const buffer = createBuffer('a\n');
		expect(insert(buffer, '')).toEqual(buffer);
	});

	it('leaves the buffer it was given untouched', () => {
		const buffer = createBuffer('a\n');
		insert(buffer, 'zzz');
		expect(toText(buffer)).toBe('a\n');
		expect(buffer.cursor).toEqual({line: 0, column: 0});
	});
});

describe('buffer newline', () => {
	it('splits the line at the cursor', () => {
		const buffer = newline(at(createBuffer('ab\n'), 0, 1));
		expect(toText(buffer)).toBe('a\nb\n');
		expect(buffer.cursor).toEqual({line: 1, column: 0});
	});

	it('opens a line without disturbing the trailing newline', () => {
		expect(toText(newline(createBuffer('a\n')))).toBe('\na\n');
	});
});

describe('buffer backspace', () => {
	it('deletes the character before the cursor', () => {
		const buffer = backspace(at(createBuffer('abc'), 0, 2));
		expect(toText(buffer)).toBe('ac');
		expect(buffer.cursor).toEqual({line: 0, column: 1});
	});

	it('joins onto the previous line at column 0', () => {
		const buffer = backspace(at(createBuffer('ab\ncd\n'), 1, 0));
		expect(toText(buffer)).toBe('abcd\n');
		expect(buffer.cursor).toEqual({line: 0, column: 2});
	});

	it('is a no-op at the start of the document', () => {
		const buffer = createBuffer('ab\n');
		expect(backspace(buffer)).toEqual(buffer);
	});

	it('leaves the buffer it was given untouched', () => {
		const buffer = at(createBuffer('ab\n'), 0, 2);
		backspace(buffer);
		expect(toText(buffer)).toBe('ab\n');
	});
});

describe('buffer deleteForward', () => {
	it('deletes the character under the cursor', () => {
		const buffer = deleteForward(at(createBuffer('abc'), 0, 1));
		expect(toText(buffer)).toBe('ac');
		expect(buffer.cursor).toEqual({line: 0, column: 1});
	});

	it('pulls the next line up at the end of a line', () => {
		const buffer = deleteForward(at(createBuffer('ab\ncd'), 0, 2));
		expect(toText(buffer)).toBe('abcd');
		expect(buffer.cursor).toEqual({line: 0, column: 2});
	});

	it('is a no-op at the end of the document', () => {
		const buffer = move(createBuffer('ab\ncd'), 'bottom');
		expect(deleteForward(buffer)).toEqual(buffer);
	});
});

describe('buffer move', () => {
	const three = createBuffer('long line\nab\nanother long line');

	it('walks left and right within a line', () => {
		expect(move(three, 'right').cursor).toEqual({line: 0, column: 1});
		expect(move(move(three, 'right'), 'left').cursor).toEqual({line: 0, column: 0});
	});

	it('wraps right onto the next line and left onto the previous one', () => {
		const end = move(three, 'end');
		expect(move(end, 'right').cursor).toEqual({line: 1, column: 0});
		expect(move(move(end, 'right'), 'left').cursor).toEqual({line: 0, column: 9});
	});

	it('is a no-op left at the start and right at the end', () => {
		expect(move(three, 'left').cursor).toEqual({line: 0, column: 0});
		const last = move(three, 'bottom');
		expect(move(last, 'right').cursor).toEqual(last.cursor);
	});

	it('keeps the column when the target line is long enough', () => {
		const buffer = at(createBuffer('long line\nalso long line'), 0, 7);
		expect(move(buffer, 'down').cursor).toEqual({line: 1, column: 7});
		expect(move(move(buffer, 'down'), 'up').cursor).toEqual({line: 0, column: 7});
	});

	it('clamps the column onto a short line and does not restore it after', () => {
		const buffer = at(three, 0, 7);
		const short = move(buffer, 'down');
		expect(short.cursor).toEqual({line: 1, column: 2});
		expect(move(short, 'down').cursor).toEqual({line: 2, column: 2});
	});

	it('is a no-op up on the first line and down on the last', () => {
		expect(move(three, 'up').cursor).toEqual({line: 0, column: 0});
		const last = at(three, 2, 3);
		expect(move(last, 'down').cursor).toEqual({line: 2, column: 3});
	});

	it('goes home and end within the line', () => {
		const buffer = at(three, 1, 1);
		expect(move(buffer, 'home').cursor).toEqual({line: 1, column: 0});
		expect(move(buffer, 'end').cursor).toEqual({line: 1, column: 2});
	});

	it('goes to the start of the document and the end of the last line', () => {
		expect(move(at(three, 2, 5), 'top').cursor).toEqual({line: 0, column: 0});
		expect(move(three, 'bottom').cursor).toEqual({line: 2, column: 17});
	});

	it('never changes the text', () => {
		for (const to of [
			'left',
			'right',
			'up',
			'down',
			'home',
			'end',
			'top',
			'bottom',
		] as const) {
			expect(toText(move(at(three, 1, 1), to))).toBe(toText(three));
		}
	});
});

describe('buffer killLine', () => {
	it('kills to the end of the line', () => {
		const buffer = killLine(at(createBuffer('keep this\nnext\n'), 0, 4));
		expect(toText(buffer)).toBe('keep\nnext\n');
		expect(buffer.cursor).toEqual({line: 0, column: 4});
	});

	it('kills the line break once the cursor is already at the end', () => {
		const buffer = killLine(at(createBuffer('a\nb\n'), 0, 1));
		expect(toText(buffer)).toBe('ab\n');
	});

	it('empties a line without removing it', () => {
		expect(toText(killLine(createBuffer('a\nb\n')))).toBe('\nb\n');
	});

	it('is a no-op at the end of the document', () => {
		const buffer = move(createBuffer('a\nb'), 'bottom');
		expect(killLine(buffer)).toEqual(buffer);
	});
});
