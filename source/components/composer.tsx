import {Box, Text} from 'ink';
import TextInput from 'ink-text-input';
import {theme} from '../theme.js';

type Props = {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onSubmit: (value: string) => void;
	readonly disabled: boolean;
};

const NEWLINE = /[\r\n]/;

export function Composer({value, onChange, onSubmit, disabled}: Props) {
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
				<Text dimColor>waiting for the current reply…</Text>
			) : (
				<TextInput
					value={value}
					onChange={handleChange}
					onSubmit={onSubmit}
					placeholder="Ask something, or /help"
					showCursor
				/>
			)}
		</Box>
	);
}
