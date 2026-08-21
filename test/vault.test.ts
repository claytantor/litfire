import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject, unplacedSituations} from '../source/core/project.js';
import {parseDocument, stringifyDocument} from '../source/vault/frontmatter.js';
import {findBlocks, upsertBlock} from '../source/vault/markers.js';
import {VAULT} from '../source/vault/paths.js';
import {writeProjections} from '../source/ledger/projections.js';
import {recordConsent} from '../source/vault/config.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

describe('frontmatter', () => {
	it('round-trips data and body', () => {
		const text = stringifyDocument({
			data: {id: 'protagonist', level: 3},
			body: '# Protagonist\n',
		});
		const parsed = parseDocument(text);

		expect(parsed.data).toEqual({id: 'protagonist', level: 3});
		expect(parsed.body).toBe('# Protagonist\n');
	});

	it('treats a file with no frontmatter as pure body', () => {
		expect(parseDocument('# Just prose\n')).toEqual({data: {}, body: '# Just prose\n'});
	});

	it('treats an unterminated fence as prose rather than failing', () => {
		expect(parseDocument('---\nid: x\n').data).toEqual({});
	});

	it('normalises CRLF', () => {
		expect(parseDocument('---\r\nid: carl\r\n---\r\n\r\nbody\r\n').data).toEqual({
			id: 'carl',
		});
	});
});

describe('markers', () => {
	const doc = [
		'Author prose above.',
		'',
		'<!-- litrpg:status char=carl at=sit-042 -->',
		'old block',
		'<!-- /litrpg:status -->',
		'',
		'Author prose below.',
	].join('\n');

	it('parses name and attributes', () => {
		const [block] = findBlocks(doc);

		expect(block?.name).toBe('status');
		expect(block?.attributes).toEqual({char: 'carl', at: 'sit-042'});
		expect(block?.content).toBe('old block');
	});

	it('replaces only the marked span, preserving surrounding prose', () => {
		const next = upsertBlock(
			doc,
			'status',
			{char: 'protagonist', at: 'sit-050'},
			'new block',
		);

		expect(next).toContain('Author prose above.');
		expect(next).toContain('Author prose below.');
		expect(next).toContain('new block');
		expect(next).not.toContain('old block');
		expect(next).toContain('at=sit-050');
	});

	it('appends when the block is absent', () => {
		expect(upsertBlock('# Page\n', 'status', {char: 'carl'}, 'body')).toContain(
			'<!-- litrpg:status char=carl -->',
		);
	});

	it('ignores an unclosed marker instead of swallowing the file', () => {
		expect(findBlocks('<!-- litrpg:status char=carl -->\nno close')).toHaveLength(0);
	});
});

describe('scaffold + compute', () => {
	// DoD 1
	it('scaffolds a vault whose pages are connected by wikilinks', async () => {
		const result = await scaffoldVault(root);

		expect(result.created).toContain(VAULT.index);
		expect(result.created).toContain(VAULT.formulas);

		const index = await readFile(path.join(root, VAULT.index), 'utf8');
		for (const link of [
			'[[protagonist]]',
			'[[arc-01]]',
			'[[system-01]]',
			'[[commodification]]',
		]) {
			expect(index).toContain(link);
		}
	});

	it('never overwrites an existing file', async () => {
		await scaffoldVault(root);
		const second = await scaffoldVault(root);

		expect(second.created).toHaveLength(0);
		expect(second.skipped).toContain(VAULT.index);
	});

	// DoD 2 — a stat system with a JS formula, evaluated.
	it('computes level from the scaffolded formula', async () => {
		await scaffoldVault(root);
		const project = await computeProject(root, {
			consentedFormulaHash: (await computeProject(root)).formulaHash,
		});

		expect(project.formulasSkipped).toBe(false);
		// Seed situation grants carl 450 xp → level 2 under xp-for-level.
		expect(project.replay.state.characters['protagonist']?.level).toBe(2);
		expect(project.vault.issues).toEqual([]);
	});

	// §6.4 first-run consent
	it('skips formula evaluation without consent', async () => {
		await scaffoldVault(root);
		const project = await computeProject(root);

		expect(project.formulasSkipped).toBe(true);
		// No curve applied, so the seeded starting level stands.
		expect(project.replay.state.characters['protagonist']?.level).toBe(1);
	});

	// DoD 11
	it('loses nothing but cache when .litrpg is deleted', async () => {
		await scaffoldVault(root);
		const before = await computeProject(root);
		await rm(path.join(root, VAULT.meta), {recursive: true, force: true});
		const after = await computeProject(root);

		expect(after.replay.state).toEqual(before.replay.state);
		expect(after.formulaHash).toBe(before.formulaHash);
	});

	// DoD 4 — placed and unplaced coexist.
	it('treats inbox situations as unplaced', async () => {
		await scaffoldVault(root);
		// `/init` no longer creates the inbox — only a vault written before D19
		// has one, which is exactly what this asserts still loads.
		await mkdir(path.join(root, VAULT.inbox), {recursive: true});
		await writeFile(
			path.join(root, VAULT.inbox, 'sit-900-loose.md'),
			stringifyDocument({
				data: {
					id: 'sit-900',
					title: 'Loose',
					events: [{actor: 'protagonist', type: 'xp', value: 9999}],
				},
				body: 'Unplaced.\n',
			}),
			'utf8',
		);

		const project = await computeProject(root);

		expect(unplacedSituations(project)).toContain('sit-900');
		// Unplaced situations contribute nothing to ledger state (§5).
		expect(project.replay.state.characters['protagonist']?.xp).toBe(450);
	});

	it('reports a malformed file as an issue rather than throwing', async () => {
		await scaffoldVault(root);
		await writeFile(
			path.join(root, VAULT.characters, 'broken.md'),
			'---\nid: 123-NOT-VALID\nlevel: "not a number"\n---\n',
			'utf8',
		);

		const project = await computeProject(root);

		expect(project.vault.issues.length).toBeGreaterThan(0);
		expect(project.replay.state.characters['protagonist']).toBeDefined();
	});
});

describe('projections', () => {
	it('writes state and open-questions as generated files', async () => {
		await scaffoldVault(root);
		const project = await computeProject(root);
		const written = await writeProjections(project);

		expect(written).toContain(VAULT.state);
		expect(written).toContain(VAULT.openQuestions);

		const state = await readFile(path.join(root, VAULT.state), 'utf8');
		expect(state).toContain('generated: true');
		expect(state).toContain('[[protagonist]]');
		expect(state).toContain('Generated file');

		const questions = await readFile(path.join(root, VAULT.openQuestions), 'utf8');
		expect(questions).toContain('milestone_drift');
	});

	it('is a no-op on a second write, so the watcher cannot loop', async () => {
		await scaffoldVault(root);
		const project = await computeProject(root);

		await writeProjections(project);
		expect(await writeProjections(project)).toEqual([]);
	});

	it('regeneration wins over a hand edit', async () => {
		await scaffoldVault(root);
		const project = await computeProject(root);
		await writeProjections(project);

		await writeFile(path.join(root, VAULT.state), 'I hand-edited this\n', 'utf8');
		expect(await writeProjections(project)).toContain(VAULT.state);
		expect(await readFile(path.join(root, VAULT.state), 'utf8')).toContain(
			'[[protagonist]]',
		);
	});
});

describe('formula consent', () => {
	it('persists across sessions and is withdrawn when a formula changes', async () => {
		await scaffoldVault(root);

		const first = await computeProject(root);
		expect(first.formulasSkipped).toBe(true);

		await recordConsent(root, first.formulaHash);
		const second = await computeProject(root);
		expect(second.formulasSkipped).toBe(false);
		expect(second.replay.state.characters['protagonist']?.level).toBe(2);

		// Editing a formula changes the hash, so stored consent no longer applies.
		const formulas = path.join(root, VAULT.formulas);
		const edited = (await readFile(formulas, 'utf8')).replace('100 * level', '1 * level');
		await writeFile(formulas, edited, 'utf8');

		const third = await computeProject(root);
		expect(third.formulasSkipped).toBe(true);
	});
});
