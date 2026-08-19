import {Box, Text, useInput} from 'ink';
import {useState} from 'react';
import {rowsFor} from '../hooks/use-viewport.js';
import {theme} from '../theme.js';

export type SelectItem = {
	readonly value: string;
	readonly label: string;
	readonly hint?: string;
};

type Props = {
	readonly items: readonly SelectItem[];
	readonly onSelect: (value: string) => void;
	/** Terminal rows the list may occupy; longer lists scroll within them. */
	readonly height?: number;
	/** Content width, so an item that wraps is charged for every row it takes. */
	readonly width?: number;
	readonly isActive?: boolean;
};

/**
 * Keyboard-driven list with a scrolling window, so a provider returning 50+
 * models does not blow past the viewport (§10 keeps tall output off Ink's
 * clear-and-redraw path).
 */
export function SelectList({
	items,
	onSelect,
	height = 8,
	width = 80,
	isActive = true,
}: Props) {
	const [cursor, setCursor] = useState(0);

	/**
	 * How an item is laid out at this width, and what that costs in rows.
	 *
	 * Label and hint are two `<Text>`s in one row, so Yoga shrinks *both* when
	 * they no longer fit and a provider label comes out shredded across three
	 * ragged rows. Stacking the hint under its label keeps each readable and
	 * makes the cost knowable, which is what the row budget below is spending.
	 */
	const layout = (index: number): {readonly stacked: boolean; readonly rows: number} => {
		const item = items[index];
		if (item === undefined) {
			return {stacked: false, rows: 1};
		}
		const label = `  ${item.label}`;
		const hint = item.hint === undefined ? '' : ` ${item.hint}`;
		if (hint === '' || label.length + hint.length <= width) {
			return {stacked: false, rows: rowsFor(label + hint, width)};
		}
		return {stacked: true, rows: rowsFor(label, width) + rowsFor(hint, width)};
	};

	// A model id long enough to wrap costs two rows, and the "n/m · ↑↓ to scroll"
	// footer costs one more whenever the list is scrolling, so the number of
	// items shown is derived from the row budget rather than fixed.
	const cost = (index: number): number => layout(index).rows;

	const budget = Math.max(1, height - (items.length > 1 ? 1 : 0));

	// Keep the cursor roughly centred until the list runs out at either end,
	// then fill forwards from there by rows.
	const start = (() => {
		let first = cursor;
		let spent = cost(cursor);
		// Walk backwards while there is room, so the rows above the cursor are
		// shown rather than a window that always begins at the selection.
		while (first > 0) {
			const next = cost(first - 1);
			if (spent + next > budget) {
				break;
			}
			first -= 1;
			spent += next;
		}
		return first;
	})();

	const shown: number[] = [];
	let spent = 0;
	for (let index = start; index < items.length; index++) {
		const next = cost(index);
		if (spent + next > budget && shown.length > 0) {
			break;
		}
		shown.push(index);
		spent += next;
	}

	useInput(
		(input, key) => {
			if (items.length === 0) {
				return;
			}
			if (key.upArrow || input === 'k') {
				setCursor(current => (current - 1 + items.length) % items.length);
			}
			if (key.downArrow || input === 'j') {
				setCursor(current => (current + 1) % items.length);
			}
			if (key.return) {
				const item = items[cursor];
				if (item) {
					onSelect(item.value);
				}
			}
		},
		{isActive},
	);

	if (items.length === 0) {
		return <Text dimColor> (nothing to choose)</Text>;
	}

	return (
		<Box flexDirection="column">
			{shown.map(index => {
				const item = items[index];
				if (item === undefined) {
					return null;
				}
				const selected = index === cursor;
				return (
					<Box key={item.value} flexDirection={layout(index).stacked ? 'column' : 'row'}>
						<Text color={selected ? theme.color.brand : undefined}>
							{selected ? '❯ ' : '  '}
							{item.label}
						</Text>
						{item.hint !== undefined && <Text dimColor> {item.hint}</Text>}
					</Box>
				);
			})}
			{items.length > shown.length && (
				<Text dimColor>
					{'  '}
					{cursor + 1}/{items.length} · ↑↓ to scroll
				</Text>
			)}
		</Box>
	);
}
