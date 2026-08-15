import {Box, Text} from 'ink';
import {theme} from '../theme.js';

type Props = {
	readonly version: string;
};

export function Header({version}: Props) {
	return (
		<Box marginBottom={1}>
			<Text color={theme.color.brand} bold>
				litfire{' '}
			</Text>
			<Text dimColor>v{version}</Text>
		</Box>
	);
}
