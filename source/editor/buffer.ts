export type Cursor = {readonly line: number; readonly column: number};

export type Buffer = {readonly lines: readonly string[]; readonly cursor: Cursor};

const NEWLINE = /\r\n?|\n/g;

const lineAt = (lines: readonly string[], index: number): string => lines[index] ?? '';

/**
 * The one constructor. Routing every edit through it is what guarantees the
 * cursor can never address a character that isn't there — callers get to state
 * intent ("column 40") without also proving the line is that long.
 */
function place(lines: readonly string[], cursor: Cursor): Buffer {
	const line = Math.min(Math.max(cursor.line, 0), Math.max(0, lines.length - 1));
	const column = Math.min(Math.max(cursor.column, 0), lineAt(lines, line).length);
	return {lines, cursor: {line, column}};
}

/**
 * Splitting on '\n' alone — never trimming — is what makes `toText(createBuffer(s))`
 * exactly `s`. A trailing newline survives as a final empty line, which is also
 * how an author reads it: a last line they can put the cursor on. The buffer
 * edits YAML frontmatter, where one gained or lost newline corrupts a proposal.
 */
export function createBuffer(contents: string): Buffer {
	return place(contents.split('\n'), {line: 0, column: 0});
}

export function toText(buffer: Buffer): string {
	return buffer.lines.join('\n');
}

export function insert(buffer: Buffer, text: string): Buffer {
	if (text === '') {
		return place(buffer.lines, buffer.cursor);
	}

	const {line, column} = buffer.cursor;
	const current = lineAt(buffer.lines, line);
	const before = current.slice(0, column);
	const after = current.slice(column);

	// A paste arrives from Ink as one string, and terminals send CR rather than
	// LF for the line breaks inside it. Both count as breaks or a pasted block
	// lands as a single line with control characters baked into it.
	const segments = text.replace(NEWLINE, '\n').split('\n');
	const first = segments[0] ?? '';
	const last = segments.at(-1) ?? '';
	const replacement =
		segments.length === 1
			? [before + first + after]
			: [before + first, ...segments.slice(1, -1), last + after];

	return place(
		[...buffer.lines.slice(0, line), ...replacement, ...buffer.lines.slice(line + 1)],
		{
			line: line + segments.length - 1,
			column: segments.length === 1 ? before.length + first.length : last.length,
		},
	);
}

export function newline(buffer: Buffer): Buffer {
	return insert(buffer, '\n');
}

export function backspace(buffer: Buffer): Buffer {
	const {line, column} = buffer.cursor;

	if (column > 0) {
		const current = lineAt(buffer.lines, line);
		return place(
			buffer.lines.map((text, index) =>
				index === line ? current.slice(0, column - 1) + current.slice(column) : text,
			),
			{line, column: column - 1},
		);
	}

	if (line === 0) {
		return place(buffer.lines, buffer.cursor);
	}

	const previous = lineAt(buffer.lines, line - 1);
	return place(
		[
			...buffer.lines.slice(0, line - 1),
			previous + lineAt(buffer.lines, line),
			...buffer.lines.slice(line + 1),
		],
		{line: line - 1, column: previous.length},
	);
}

export function deleteForward(buffer: Buffer): Buffer {
	const {line, column} = buffer.cursor;
	const current = lineAt(buffer.lines, line);

	if (column < current.length) {
		return place(
			buffer.lines.map((text, index) =>
				index === line ? current.slice(0, column) + current.slice(column + 1) : text,
			),
			buffer.cursor,
		);
	}

	if (line >= buffer.lines.length - 1) {
		return place(buffer.lines, buffer.cursor);
	}

	return place(
		[
			...buffer.lines.slice(0, line),
			current + lineAt(buffer.lines, line + 1),
			...buffer.lines.slice(line + 2),
		],
		buffer.cursor,
	);
}

export function move(
	buffer: Buffer,
	to: 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'top' | 'bottom',
): Buffer {
	const {lines, cursor} = buffer;
	const last = Math.max(0, lines.length - 1);

	switch (to) {
		case 'left': {
			if (cursor.column > 0) {
				return place(lines, {line: cursor.line, column: cursor.column - 1});
			}
			if (cursor.line === 0) {
				return place(lines, cursor);
			}
			return place(lines, {
				line: cursor.line - 1,
				column: lineAt(lines, cursor.line - 1).length,
			});
		}

		case 'right': {
			if (cursor.column < lineAt(lines, cursor.line).length) {
				return place(lines, {line: cursor.line, column: cursor.column + 1});
			}
			if (cursor.line >= last) {
				return place(lines, cursor);
			}
			return place(lines, {line: cursor.line + 1, column: 0});
		}

		// `place` clamps the column against the target line, so crossing a short
		// line shortens the cursor for good. A goal column that survives the
		// crossing would need somewhere to live, and Buffer is the whole state.
		case 'up': {
			return place(lines, {line: cursor.line - 1, column: cursor.column});
		}

		case 'down': {
			return place(lines, {line: cursor.line + 1, column: cursor.column});
		}

		case 'home': {
			return place(lines, {line: cursor.line, column: 0});
		}

		case 'end': {
			return place(lines, {line: cursor.line, column: lineAt(lines, cursor.line).length});
		}

		case 'top': {
			return place(lines, {line: 0, column: 0});
		}

		case 'bottom': {
			return place(lines, {line: last, column: lineAt(lines, last).length});
		}
	}
}

/**
 * Emacs' ^K, because that is what the muscle memory expects: kill to the end of
 * the line, and only once the line is already empty kill the break itself.
 */
export function killLine(buffer: Buffer): Buffer {
	const {line, column} = buffer.cursor;
	const current = lineAt(buffer.lines, line);

	if (column < current.length) {
		return place(
			buffer.lines.map((text, index) =>
				index === line ? current.slice(0, column) : text,
			),
			buffer.cursor,
		);
	}

	return deleteForward(buffer);
}
