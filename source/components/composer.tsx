import {Box, Text, useInput} from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import {useRef, useState} from 'react';
import {theme} from '../theme.js';

type Props = {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onSubmit: (value: string) => void;
	readonly disabled: boolean;
	readonly placeholder?: string;
	readonly busyLabel?: string;
	/** Previously submitted lines, oldest first. Arrow up walks backwards. */
	readonly history?: readonly string[];
};

const NEWLINE = /[\r\n]/;

export function Composer({
	value,
	onChange,
	onSubmit,
	disabled,
	placeholder = '/help for commands',
	busyLabel = 'working…',
	history = [],
}: Props) {
	// How far back we have walked; undefined means "not browsing, this is the
	// author's own draft".
	const [browsing, setBrowsing] = useState<number | undefined>(undefined);
	// The draft set aside when browsing began, so arrowing back down returns the
	// half-typed line rather than an empty box.
	const stashed = useRef('');

	/**
	 * `ink-text-input` returns early on up/down (its own `useInput` ignores them
	 * explicitly), so claiming them here cannot fight the cursor.
	 */
	useInput(
		(_input, key) => {
			if (key.upArrow) {
				if (history.length === 0) {
					return;
				}
				const next =
					browsing === undefined ? history.length - 1 : Math.max(0, browsing - 1);
				if (browsing === undefined) {
					stashed.current = value;
				}
				setBrowsing(next);
				onChange(history[next] ?? '');
				return;
			}

			if (key.downArrow && browsing !== undefined) {
				const next = browsing + 1;
				if (next > history.length - 1) {
					// Past the newest entry is the draft we interrupted, the way a
					// shell hands back the line you were typing.
					setBrowsing(undefined);
					onChange(stashed.current);
					return;
				}
				setBrowsing(next);
				onChange(history[next] ?? '');
			}
		},
		{isActive: !disabled},
	);
	/**
	 * Ink hands a pasted or piped chunk to `useInput` as a single event, so
	 * `ink-text-input` never sees `key.return` — it just splices the whole
	 * string, newline and all, into the value. Without this, pasting text that
	 * ends in a newline silently fails to send.
	 *
	 * The first newline is the submit boundary; anything after it stays queued
	 * as the next draft. A multi-line paste therefore sends its first line,
	 * which is the honest behaviour for a single-line composer.
	 */
	const handleChange = (next: string) => {
		// Typing takes ownership of the line: what was a recalled command is now
		// the author's own draft, and arrowing down should not snatch it back.
		setBrowsing(undefined);

		const breakAt = next.search(NEWLINE);
		if (breakAt === -1) {
			onChange(next);
			return;
		}

		const line = next.slice(0, breakAt);
		const rest = next.slice(breakAt + 1).replace(/^\n/, '');

		// Submit first: the parent clears the draft on submit, so the remainder
		// has to be written afterwards to survive the same batched update.
		onSubmit(line);
		onChange(rest);
	};

	const handleSubmit = (line: string) => {
		setBrowsing(undefined);
		stashed.current = '';
		onSubmit(line);
	};

	return (
		<Box
			borderStyle="round"
			borderColor={disabled ? theme.color.muted : theme.color.border}
			paddingX={1}
		>
			<Text color={disabled ? theme.color.muted : theme.color.brand}>
				{theme.symbol.user}{' '}
			</Text>
			{disabled ? (
				// The spinner is the only moving thing on screen while a model is
				// answering, and every wait in this tool runs through here. Without
				// it a request that takes ninety seconds — which an extraction
				// routinely does — is indistinguishable from a hang.
				<Text dimColor>
					<Text color={theme.color.brand}>
						<Spinner type="dots" />
					</Text>{' '}
					{busyLabel}
				</Text>
			) : (
				<TextInput
					value={value}
					onChange={handleChange}
					onSubmit={handleSubmit}
					placeholder={placeholder}
					showCursor
				/>
			)}
		</Box>
	);
}
