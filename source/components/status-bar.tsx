import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import type {ChatStatus} from '../types.js';
import {theme} from '../theme.js';

type Props = {
	readonly status: ChatStatus;
	readonly error: string | undefined;
	readonly engineName: string;
	readonly columns: number;
};

export function StatusBar({status, error, engineName, columns}: Props) {
	return (
		<Box justifyContent="space-between" paddingX={1}>
			<Box>
				{status === 'streaming' && (
					<Text color={theme.color.brand}>
						<Spinner type="dots" />
						<Text dimColor> streaming — esc to cancel</Text>
					</Text>
				)}
				{status === 'idle' && <Text dimColor>enter send · esc cancel · ctrl+c quit</Text>}
				{status === 'error' && (
					<Text color={theme.color.error}>
						{theme.symbol.error} {error ?? 'unknown error'}
					</Text>
				)}
			</Box>
			<Text dimColor>
				{engineName} · {columns}c
			</Text>
		</Box>
	);
}
