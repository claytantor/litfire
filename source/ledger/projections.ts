import {readFile, writeFile} from 'node:fs/promises';
import {stringify} from 'yaml';
import type {Project} from '../core/project.js';
import {stringifyDocument} from '../vault/frontmatter.js';
import {resolve, VAULT} from '../vault/paths.js';

const BANNER =
	'> [!warning] Generated file\n> Written by litfire. Hand edits are overwritten on the next recompute.';

function renderState(project: Project): string {
	const characters = Object.values(project.replay.state.characters).toSorted((a, b) =>
		a.id.localeCompare(b.id),
	);

	const sections = characters.map(character => {
		const stats = Object.entries(character.stats)
			.toSorted(([a], [b]) => a.localeCompare(b))
			.map(([id, value]) => `| ${id} | ${value} |`)
			.join('\n');

		const items = Object.entries(character.items).filter(([, qty]) => qty > 0);

		return [
			`## [[${character.id}]]`,
			'',
			`- level **${character.level}**`,
			`- xp **${character.xp}**`,
			`- skills: ${
				character.skills.length > 0
					? character.skills.map(skill => `[[${skill}]]`).join(', ')
					: '_none_'
			}`,
			items.length > 0
				? `- items: ${items.map(([id, qty]) => `${id} ×${qty}`).join(', ')}`
				: '- items: _none_',
			'',
			stats === '' ? '' : `| stat | value |\n| --- | --- |\n${stats}`,
			'',
		].join('\n');
	});

	const flags = Object.entries(project.replay.state.flags);

	return [
		'# Ledger state',
		'',
		BANNER,
		'',
		`Replayed from ${project.replay.sequence.length} step(s). Back to [[index]].`,
		'',
		...sections,
		flags.length > 0
			? `## Flags\n\n${flags.map(([key, value]) => `- \`${key}\` = ${String(value)}`).join('\n')}\n`
			: '',
	].join('\n');
}

function renderOpenQuestions(project: Project): string {
	const open = project.questions.filter(question => question.status === 'open');

	const body = [
		'# Open questions',
		'',
		BANNER,
		'',
		'Nothing here blocks writing. Contradictions are surfaced, never adjudicated.',
		'',
		open.length === 0
			? '_No open questions._'
			: '```yaml\n' +
				stringify(
					open.map(question => ({
						id: question.id,
						kind: question.kind,
						detail: question.detail,
						where: question.where,
						...(question.actor === undefined ? {} : {actor: question.actor}),
						source: question.source,
						status: question.status,
					})),
					{lineWidth: 0},
				) +
				'```',
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return body;
}

/**
 * Writes the derived projections (D2). Content is compared first: without that
 * the watcher would see our own write, recompute, and write again forever.
 */
async function writeIfChanged(file: string, contents: string): Promise<boolean> {
	const existing = await readFile(file, 'utf8').catch(() => undefined);
	if (existing === contents) {
		return false;
	}
	await writeFile(file, contents, 'utf8');
	return true;
}

export async function writeProjections(project: Project): Promise<string[]> {
	const written: string[] = [];

	const state = stringifyDocument({
		data: {generated: true},
		body: `\n${renderState(project)}`,
	});
	const questions = stringifyDocument({
		data: {generated: true},
		body: `\n${renderOpenQuestions(project)}`,
	});

	if (await writeIfChanged(resolve(project.vault.root, VAULT.state), state)) {
		written.push(VAULT.state);
	}
	if (await writeIfChanged(resolve(project.vault.root, VAULT.openQuestions), questions)) {
		written.push(VAULT.openQuestions);
	}

	return written;
}
