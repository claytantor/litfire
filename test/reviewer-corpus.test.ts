import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject} from '../source/core/project.js';
import {
	buildCorpusMap,
	buildReviewerContext,
	renderCorpusMap,
	selectRelevant,
} from '../source/reviewer/corpus.js';
import {stringifyDocument} from '../source/vault/frontmatter.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

const write = async (relative: string, data: Record<string, unknown>, body = '\n') => {
	const file = resolve(root, relative);
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, stringifyDocument({data, body}), 'utf8');
};

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-corpus-'));
	await scaffoldVault(root, 'arcane');
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

describe('buildCorpusMap', () => {
	it('includes situations, characters, and themes; excludes ledger/ and raw/', async () => {
		await write(path.join(VAULT.characters, 'nyx.md'), {
			id: 'nyx',
			name: 'Nyx',
			level: 4,
		});
		await write(path.join(VAULT.themes, 'debt.md'), {id: 'debt', name: 'Debt'});
		await write(path.join(VAULT.situations, 'sit-901.md'), {
			id: 'sit-901',
			title: 'The Duel',
		});

		const project = await computeProject(root);
		const map = await buildCorpusMap(root, project);
		const paths = map.entries.map(entry => entry.path);

		expect(paths).toContain(path.join(VAULT.characters, 'nyx.md'));
		expect(paths).toContain(path.join(VAULT.themes, 'debt.md'));
		expect(paths).toContain(path.join(VAULT.situations, 'sit-901.md'));
		expect(paths.some(p => p.startsWith('ledger/'))).toBe(false);
		expect(paths.some(p => p.startsWith('raw/'))).toBe(false);
	});

	/**
	 * The bug this guards, same as interview/grounding.ts: `/init` seeds
	 * placeholders so the vault opens as a connected Obsidian graph. A reviewer
	 * that cites them discusses a character the author never invented.
	 */
	it('excludes example: true scaffold files and counts them', async () => {
		const project = await computeProject(root);
		const map = await buildCorpusMap(root, project);
		const paths = map.entries.map(entry => entry.path);

		expect(paths).not.toContain(path.join(VAULT.characters, 'protagonist.md'));
		expect(paths).not.toContain(path.join(VAULT.themes, 'commodification.md'));
		expect(paths).not.toContain(path.join(VAULT.arcs, 'arc-01.md'));
		expect(map.examplesSkipped).toBeGreaterThan(0);
	});

	it('surfaces open questions from project.questions', async () => {
		await write(path.join(VAULT.situations, 'sit-901.md'), {
			id: 'sit-901',
			themes: ['ghost-theme'],
		});

		const project = await computeProject(root);
		const map = await buildCorpusMap(root, project);

		expect(map.openQuestions.length).toBeGreaterThan(0);
		expect(map.openQuestions.some(line => line.includes('ghost-theme'))).toBe(true);
	});
});

describe('renderCorpusMap', () => {
	it('stays compact: no file body text leaks into the rendered map', async () => {
		const distinctive = 'The quick zeppelin descends over the smoldering harbor at dusk.';
		await write(
			path.join(VAULT.situations, 'sit-901.md'),
			{id: 'sit-901', title: 'The Duel'},
			`\n${distinctive}\n`,
		);

		const project = await computeProject(root);
		const map = await buildCorpusMap(root, project);
		const rendered = renderCorpusMap(map);

		expect(rendered).toContain(path.join(VAULT.situations, 'sit-901.md'));
		expect(rendered).not.toContain(distinctive);
	});

	it('includes an open questions section', async () => {
		await write(path.join(VAULT.situations, 'sit-901.md'), {
			id: 'sit-901',
			themes: ['ghost-theme'],
		});

		const project = await computeProject(root);
		const map = await buildCorpusMap(root, project);
		const rendered = renderCorpusMap(map);

		expect(rendered).toContain('## Open questions');
		expect(rendered).toContain('ghost-theme');
	});
});

describe('selectRelevant', () => {
	it('ranks an exact id match above a partial keyword match', async () => {
		await write(
			path.join(VAULT.situations, 'sit-901.md'),
			{id: 'sit-901', title: 'The Harbor Duel'},
			'\nTwo rivals meet at dawn.\n',
		);
		await write(path.join(VAULT.situations, 'sit-902.md'), {
			id: 'sit-902',
			notes: 'harbor duel rumors circulate at dawn',
		});

		const project = await computeProject(root);
		const map = await buildCorpusMap(root, project);

		const result = selectRelevant(
			map,
			'What happened at sit-901, the harbor duel at dawn?',
			100_000,
		);

		expect(result[0]).toBe(path.join(VAULT.situations, 'sit-901.md'));
		expect(result).toContain(path.join(VAULT.situations, 'sit-902.md'));
	});

	it('returns empty for a question matching nothing', async () => {
		await write(path.join(VAULT.situations, 'sit-901.md'), {
			id: 'sit-901',
			title: 'The Harbor Duel',
		});

		const project = await computeProject(root);
		const map = await buildCorpusMap(root, project);

		expect(selectRelevant(map, 'xyzzy quux wobblesnort', 100_000)).toEqual([]);
	});

	it('respects the budget and stops rather than overflowing', async () => {
		await write(
			path.join(VAULT.situations, 'sit-901.md'),
			{id: 'sit-901', title: 'Zeppelin Harbor'},
			`\n${'x'.repeat(500)}\n`,
		);
		await write(
			path.join(VAULT.situations, 'sit-902.md'),
			{id: 'sit-902', title: 'Zeppelin Harbor Redux'},
			`\n${'y'.repeat(500)}\n`,
		);

		const project = await computeProject(root);
		const map = await buildCorpusMap(root, project);

		const full = selectRelevant(map, 'zeppelin harbor', 100_000);
		expect(full.length).toBe(2);

		const topEntry = map.entries.find(
			entry => entry.path === path.join(VAULT.situations, 'sit-901.md'),
		);
		expect(topEntry).toBeDefined();

		const tight = selectRelevant(map, 'zeppelin harbor', topEntry!.chars);
		expect(tight).toEqual([path.join(VAULT.situations, 'sit-901.md')]);
	});
});

describe('buildReviewerContext', () => {
	it('always includes the map even when the full-text budget is 0', async () => {
		await write(path.join(VAULT.characters, 'nyx.md'), {
			id: 'nyx',
			name: 'Nyx',
			level: 4,
		});

		const project = await computeProject(root);
		const context = await buildReviewerContext(root, project, 'Tell me about nyx', {
			budget: 0,
		});

		expect(context).toContain('## Corpus map');
		expect(context).toContain(path.join(VAULT.characters, 'nyx.md'));
		expect(context).not.toContain('## Full text');
	});

	it('includes the full text of a selected file when the budget allows', async () => {
		await write(
			path.join(VAULT.situations, 'sit-901.md'),
			{id: 'sit-901', title: 'The Harbor Duel'},
			'\nTwo rivals meet at dawn on the harbor.\n',
		);

		const project = await computeProject(root);
		const context = await buildReviewerContext(root, project, 'sit-901 harbor duel');

		expect(context).toContain('## Full text');
		expect(context).toContain('Two rivals meet at dawn on the harbor.');
	});
});
