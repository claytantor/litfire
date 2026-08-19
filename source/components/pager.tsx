import {Box, Text, useInput} from 'ink';
import {useState} from 'react';
import type {Line} from '../commands/types.js';
import {
	contentWidth,
	rowsFor,
	splitRow,
	useWrappedLines,
	viewportHeight,
} from '../hooks/use-viewport.js';
import {theme} from '../theme.js';
import {LineView} from './line-view.js';

type Props = {
	readonly title: string;
	readonly lines: readonly Line[];
	readonly rows: number;
	readonly columns: number;
	readonly onClose: () => void;
};

const HINT = '↑↓ scroll · space page · g/G ends · q close';

/**
 * A windowed pager (§10): anything taller than the viewport renders here rather
 * than in the dynamic region, so Ink never clear-and-redraws a screenful.
 *
 * The window is measured in terminal rows, not in lines of command output — a
 * path or a rationale that wraps costs the viewport every row it takes, and
 * counting them as one is what used to push the hint bar off a narrow terminal.
 */
export function Pager({title, lines, rows, columns, onClose}: Props) {
	const width = contentWidth(columns);
	const wrapped = useWrappedLines(lines, width);

	// Chrome is measured, not assumed: at 40 columns the hint alone takes two
	// rows, and a title that wraps takes another.
	const total = wrapped.length;
	// The widest the counter can ever get, so the header's height does not
	// depend on the offset it is about to describe.
	const widestCounter = `${total}–${total} of ${total}`;
	const header = splitRow(title, widestCounter, width);
	const chrome = 2 + header.rows + rowsFor(HINT, width);
	const height = viewportHeight(rows, chrome);

	const [offset, setOffset] = useState(0);
	const maxOffset = Math.max(0, total - height);
	// Clamped at render: a resize changes `height` underneath a stored offset,
	// so a value clamped in state would be stale by the next frame.
	const clamped = Math.min(offset, maxOffset);

	useInput((input, key) => {
		if (key.escape || input === 'q') {
			onClose();
			return;
		}
		if (key.downArrow || input === 'j') {
			setOffset(current => Math.min(maxOffset, current + 1));
		}
		if (key.upArrow || input === 'k') {
			setOffset(current => Math.max(0, current - 1));
		}
		if (key.pageDown || input === ' ') {
			setOffset(current => Math.min(maxOffset, current + height));
		}
		if (key.pageUp) {
			setOffset(current => Math.max(0, current - height));
		}
		if (input === 'g') {
			setOffset(0);
		}
		if (input === 'G') {
			setOffset(maxOffset);
		}
	});

	const window = wrapped.slice(clamped, clamped + height);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.color.border}>
			<Box
				paddingX={1}
				flexDirection={header.stacked ? 'column' : 'row'}
				justifyContent="space-between"
			>
				<Text bold color={theme.color.brand}>
					{title}
				</Text>
				<Text dimColor>
					{clamped + 1}–{Math.min(total, clamped + height)} of {total}
				</Text>
			</Box>

			<Box flexDirection="column" paddingX={1}>
				{window.map((line, index) => (
					<LineView key={`${clamped + index}`} line={line} />
				))}
			</Box>

			<Box paddingX={1}>
				<Text dimColor>{HINT}</Text>
			</Box>
		</Box>
	);
}
