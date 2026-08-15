import {Box, Text} from 'ink';
import type {Role} from '../types.js';
import {roleColor, roleSymbol} from '../theme.js';

type Props = {
	readonly role: Role;
	readonly content: string;
	/** Renders the gutter symbol dim while a reply is still arriving. */
	readonly pending?: boolean;
};

export function MessageView({role, content, pending = false}: Props) {
	return (
		<Box flexDirection="row" marginBottom={1}>
			<Box width={2} flexShrink={0}>
				<Text color={roleColor[role]} dimColor={pending}>
					{roleSymbol[role]}
				</Text>
			</Box>
			<Box flexGrow={1}>
				<Text wrap="wrap">{content}</Text>
			</Box>
		</Box>
	);
}
