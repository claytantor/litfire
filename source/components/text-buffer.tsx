import {Box, Text, useInput} from 'ink';
import {useState} from 'react';
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
} from '../editor/buffer.js';
import {contentWidth, rowsFor, splitRow, viewportHeight} from '../hooks/use-viewport.js';
import {theme} from '../theme.js';

type Props = {
	readonly contents: string;
	readonly path: string;
	/** Terminal rows this buffer may occupy in total, chrome included. */
	readonly height: number;
	readonly columns: number;
	readonly onSave: (text: string) => void;
	readonly onCancel: () => void;
	readonly onExternal?: () => void;
};

/**
 * The native prose buffer (§10). Editing inline keeps the review gate's frame —
 * path, decision, diff stat — on screen while the author types, so the ruling
 * and the text it rules on are never separated by another process (P3).
 *
 * $EDITOR stays one chord away for the edits a one-screen buffer is the wrong
 * shape for.
 */
export function TextBuffer({
	contents,
	path,
	height,
	columns,
	onSave,
	onCancel,
	onExternal,
}: Props) {
	// Seeded once. Re-seeding from a changed `contents` would throw away whatever
	// the author has typed since, which is the one thing an editor must not do.
	const [buffer, setBuffer] = useState(() => createBuffer(contents));
	const [top, setTop] = useState(0);

	const width = contentWidth(columns);
	const hint = `^s save · esc cancel · ^k kill line · ↑↓←→ move${
		onExternal ? ' · ^e $EDITOR' : ''
	}`;
	// The counter at its widest — the last line, and a column at the end of the
	// longest one — so the header's height does not change as the cursor moves.
	const widestLine = buffer.lines.reduce((most, line) => Math.max(most, line.length), 0);
	const header = splitRow(
		`editing ${path}`,
		`ln ${String(buffer.lines.length)}/${String(buffer.lines.length)} · col ${String(widestLine + 1)}`,
		width,
	);
	// The header, the two `marginTop` gaps, and however many rows the hint takes
	// once it wraps. Prose lines are never truncated, so the body is what gives
	// way — see `visible` below for how a wrapped line spends its budget.
	const body = viewportHeight(height, header.rows + 2 + rowsFor(hint, width));

	const apply = (next: Buffer) => {
		setBuffer(next);
		// Scroll by the least that keeps the cursor visible: walking a line at a
		// time should move one row, not re-centre the whole viewport.
		setTop(current =>
			next.cursor.line < current
				? next.cursor.line
				: next.cursor.line >= current + body
					? next.cursor.line - body + 1
					: current,
		);
	};

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.ctrl && input === 's') {
			onSave(toText(buffer));
			return;
		}
		if (key.ctrl && input === 'e' && onExternal) {
			onExternal();
			return;
		}
		if (key.ctrl && input === 'k') {
			apply(killLine(buffer));
			return;
		}
		if (key.return) {
			apply(newline(buffer));
			return;
		}
		if (key.backspace) {
			apply(backspace(buffer));
			return;
		}
		if (key.delete) {
			apply(deleteForward(buffer));
			return;
		}
		if (key.leftArrow) {
			apply(move(buffer, 'left'));
			return;
		}
		if (key.rightArrow) {
			apply(move(buffer, 'right'));
			return;
		}
		if (key.upArrow) {
			apply(move(buffer, 'up'));
			return;
		}
		if (key.downArrow) {
			apply(move(buffer, 'down'));
			return;
		}
		if (key.home) {
			apply(move(buffer, 'home'));
			return;
		}
		if (key.end) {
			apply(move(buffer, 'end'));
			return;
		}
		// Unclaimed chords would otherwise insert their letter as text.
		if (key.ctrl || key.meta || key.tab || input === '') {
			return;
		}
		apply(insert(buffer, input));
	});

	const {cursor} = buffer;
	const gutter = String(buffer.lines.length).length;
	const first = Math.max(0, Math.min(top, cursor.line));
	const current = buffer.lines[cursor.line] ?? '';

	/**
	 * Fills the body by *rendered* rows rather than by buffer lines.
	 *
	 * A prose line longer than the terminal wraps onto several rows, and taking
	 * `body` lines regardless is what used to push `^s save` off the bottom —
	 * leaving the author in an editor with no visible way out. The cursor's line
	 * is always admitted, however wide it is, so typing never scrolls it away.
	 */
	const visible: number[] = [];
	let spent = 0;
	for (let index = first; index < buffer.lines.length; index++) {
		const cost = rowsFor(`${' '.repeat(gutter + 1)}${buffer.lines[index] ?? ''}`, width);
		if (spent + cost > body && visible.length > 0 && index !== cursor.line) {
			break;
		}
		visible.push(index);
		spent += cost;
		if (spent >= body) {
			break;
		}
	}

	return (
		<Box flexDirection="column">
			<Box
				flexDirection={header.stacked ? 'column' : 'row'}
				justifyContent="space-between"
			>
				<Text dimColor>editing {path}</Text>
				<Text dimColor>
					ln {cursor.line + 1}/{buffer.lines.length} · col {cursor.column + 1}
				</Text>
			</Box>

			<Box flexDirection="column" marginTop={1}>
				{visible.map(number => {
					const line = buffer.lines[number] ?? '';
					return (
						<Text key={`${number}`}>
							<Text color={theme.color.muted}>
								{String(number + 1).padStart(gutter)}{' '}
							</Text>
							{number === cursor.line ? (
								<Text>
									{current.slice(0, cursor.column)}
									{/* The cursor is drawn as the character it sits on, inverted;
									    past the end of the line that character is a space. */}
									<Text inverse>{current[cursor.column] ?? ' '}</Text>
									{current.slice(cursor.column + 1)}
								</Text>
							) : (
								<Text>{line}</Text>
							)}
						</Text>
					);
				})}
			</Box>

			<Box marginTop={1}>
				<Text dimColor>{hint}</Text>
			</Box>
		</Box>
	);
}
