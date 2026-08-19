import {Text} from 'ink';
import type {Line} from '../commands/types.js';

type Props = {
	readonly line: Line;
};

/**
 * Renders one command-output line. Commands emit plain data rather than Ink
 * elements so they stay unit-testable without a renderer.
 */
export function LineView({line}: Props) {
	// An empty <Text> collapses, so a blank line needs a space to hold height.
	if (line.text === '') {
		return <Text> </Text>;
	}

	return (
		<Text color={line.color} dimColor={line.dim} bold={line.bold}>
			{line.text}
		</Text>
	);
}
