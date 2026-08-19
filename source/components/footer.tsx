import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import type {ReactNode} from 'react';
import type {Project} from '../core/project.js';
import {unplacedSituations} from '../core/project.js';
import type {ProjectStatus} from '../hooks/use-project.js';
import {theme} from '../theme.js';

type Props = {
	readonly project: Project | undefined;
	readonly status: ProjectStatus;
	readonly activeCharacter: string | undefined;
	readonly columns: number;
	readonly providerLabel?: string | undefined;
	readonly projectLabel?: string | undefined;
};

/**
 * One status field.
 *
 * `<Text>` is created with `flexShrink: 1`, so in a row that has run out of
 * width Yoga shrinks *every* field and `no character` comes out as `no chara` /
 * `cter` across two ragged rows. Boxing each field at `flexShrink={0}` makes the
 * row wrap between fields instead of through them.
 */
function Field({children}: {readonly children: ReactNode}) {
	return <Box flexShrink={0}>{children}</Box>;
}

/**
 * The persistent status region from §10: active character, current level, open
 * question count, unplaced situation count.
 *
 * Both halves wrap rather than truncate, so a narrow terminal costs the footer
 * a row of height instead of costing the author a field they can still read.
 */
export function Footer({
	project,
	status,
	activeCharacter,
	columns,
	providerLabel,
	projectLabel,
}: Props) {
	const character = activeCharacter
		? project?.replay.state.characters[activeCharacter]
		: undefined;
	const open = project?.questions.filter(q => q.status === 'open').length ?? 0;
	const unplaced = project ? unplacedSituations(project).length : 0;

	return (
		<Box justifyContent="space-between" paddingX={1} flexWrap="wrap">
			<Box columnGap={2} flexWrap="wrap">
				{projectLabel !== undefined && (
					<Field>
						<Text color={theme.color.brand}>{projectLabel}</Text>
					</Field>
				)}
				{character ? (
					<Field>
						<Text color={theme.color.assistant}>
							{character.id} L{character.level}
						</Text>
					</Field>
				) : (
					<Field>
						<Text dimColor>no character</Text>
					</Field>
				)}
				<Field>
					<Text color={open > 0 ? '#e0af68' : undefined} dimColor={open === 0}>
						{open} open
					</Text>
				</Field>
				<Field>
					<Text dimColor>{unplaced} unplaced</Text>
				</Field>
			</Box>

			<Box columnGap={1} flexWrap="wrap">
				{status === 'computing' && (
					<Field>
						<Text color={theme.color.brand}>
							<Spinner type="dots" />
						</Text>
					</Field>
				)}
				{project?.formulasSkipped === true && (
					<Field>
						<Text color="#e0af68">formulas off</Text>
					</Field>
				)}
				<Field>
					<Text dimColor>{providerLabel ?? 'no provider'}</Text>
				</Field>
				<Field>
					<Text dimColor>{columns}c</Text>
				</Field>
			</Box>
		</Box>
	);
}
