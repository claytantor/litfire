import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject} from '../source/core/project.js';
import {hashFormulas} from '../source/system/sandbox.js';
import {loadVault} from '../source/vault/load.js';
import {evaluationOrder} from '../source/ledger/derived.js';
import {systemSchema} from '../source/domain/schema.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-derived-'));
	await scaffoldVault(root, 'arcane');
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

/**
 * Formulas are gated on the author consenting to a hash of the source they
 * read, so a vault nobody has consented to has no runner and no derived stat
 * is computed at all. That is the correct default and it has to be stepped
 * over deliberately here.
 */
async function consented() {
	const vault = await loadVault(root);
	return computeProject(root, {consentedFormulaHash: hashFormulas(vault.formulas)});
}

async function file(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), {recursive: true});
	await writeFile(target, contents, 'utf8');
}

/** A system whose max-hp is computed, and a character under it. */
async function derivedVault(extraStats = '', formulas = '') {
	await file(
		`${VAULT.systems}/core.md`,
		[
			'---',
			'id: core',
			'name: Core',
			'stats:',
			'  - id: constitution',
			'    default: 10',
			'  - id: carry',
			'    formula: carry',
			extraStats,
			'---',
			'',
			'```js id=carry',
			'({constitution, level}) => 50 + constitution * 8 + level * 12;',
			'```',
			formulas,
			'',
		]
			.filter(line => line !== '')
			.join('\n'),
	);
	await file(
		`${VAULT.characters}/carl.md`,
		'---\nid: carl\nsystem: core\nlevel: 1\nstats:\n  constitution: 12\n---\n\nHim.\n',
	);
	await rm(path.join(root, VAULT.systems, 'system-01.md'), {force: true});
}

describe('a stat the system computes', () => {
	it('is evaluated from the rest of the state', async () => {
		await derivedVault();
		const project = await consented();

		// 50 + 12*8 + 1*12
		expect(project.replay.state.characters['carl']?.stats['carry']).toBe(158);
	});

	/**
	 * The point of a derived stat: it is a fact about a scene, not about a
	 * character sheet. When the story moves the input, the output moves with it.
	 */
	it('moves when the stat it reads moves', async () => {
		await derivedVault();
		await file(
			`${VAULT.situations}/sit-900.md`,
			'---\nid: sit-900\ntitle: The Change\narc: arc-01\norder: 5\nevents:\n  - {actor: carl, type: stat, stat: constitution, delta: 5}\n---\n\nProse.\n',
		);
		const project = await consented();

		// constitution 17 → 50 + 136 + 12
		expect(project.replay.state.characters['carl']?.stats['carry']).toBe(198);
	});

	it('is reported when a scene tries to change it directly', async () => {
		await derivedVault();
		await file(
			`${VAULT.situations}/sit-901.md`,
			'---\nid: sit-901\ntitle: Contradiction\narc: arc-01\norder: 5\nevents:\n  - {actor: carl, type: stat, stat: carry, delta: 40}\n---\n\nProse.\n',
		);
		const project = await consented();

		const finding = project.questions.find(q => q.kind === 'derived_stat_driven');
		expect(finding?.detail).toContain('carry');
		expect(finding?.detail).toContain('overwrites it');
	});
});

describe('evaluation order', () => {
	const system = (stats: {id: string; formula?: string}[]) =>
		systemSchema.parse({id: 'core', stats});

	it('puts a stat after the ones its formula reads', () => {
		const {order} = evaluationOrder(
			system([
				{id: 'tier', formula: 'tier'},
				{id: 'power', formula: 'power'},
			]),
			id => (id === 'tier' ? '({power}) => power / 10' : '({level}) => level * 2'),
		);

		expect(order).toEqual(['power', 'tier']);
	});

	/**
	 * Two stats deriving from each other have no answer. Picking a starting
	 * point would produce a number, and a number that looks computed but is an
	 * artefact of evaluation order is worse than none.
	 */
	it('reports a cycle rather than choosing a starting point', () => {
		const {order, cycle} = evaluationOrder(
			system([
				{id: 'tier', formula: 'tier'},
				{id: 'rank', formula: 'rank'},
			]),
			id => (id === 'tier' ? '({rank}) => rank + 1' : '({tier}) => tier + 1'),
		);

		expect(order).toEqual([]);
		expect(cycle).toEqual(['rank', 'tier']);
	});

	it('does not mistake a longer name for the stat it starts with', () => {
		// `tier` must not match `tier-cap`, or an edge appears that is not there.
		const {order} = evaluationOrder(
			system([
				{id: 'tier', formula: 'tier'},
				{id: 'tier-cap', formula: 'cap'},
			]),
			id => (id === 'tier' ? '({level}) => level' : '({level}) => level * 9'),
		);

		expect(order).toHaveLength(2);
	});

	it('ignores stats that are accumulated', () => {
		const {order} = evaluationOrder(
			system([{id: 'constitution'}, {id: 'max-hp', formula: 'max-hp'}]),
			() => '({constitution}) => constitution',
		);

		expect(order).toEqual(['max-hp']);
	});
});

describe('a system whose stats do nothing', () => {
	/**
	 * Declaring a stat is half of having one. With nothing changing it and no
	 * formula deriving it, every sheet shows the declared default in every
	 * scene forever — which looks finished from the outside and is empty.
	 */
	it('is reported once, not once per stat', async () => {
		const project = await computeProject(root);
		const inert = project.questions.filter(q => q.kind === 'system_stats_inert');

		expect(inert).toHaveLength(1);
		expect(inert[0]?.detail).toContain('shows defaults');
	});

	it('says nothing once a stat is derived', async () => {
		await derivedVault();
		const project = await consented();

		expect(project.questions.filter(q => q.kind === 'system_stats_inert')).toEqual([]);
	});

	it('says nothing once a scene changes one', async () => {
		await file(
			`${VAULT.situations}/sit-902.md`,
			'---\nid: sit-902\ntitle: A Change\narc: arc-01\norder: 5\nevents:\n  - {actor: protagonist, type: stat, stat: strength, delta: 1}\n---\n\nProse.\n',
		);
		const project = await computeProject(root);

		expect(project.questions.filter(q => q.kind === 'system_stats_inert')).toEqual([]);
	});

	it('reports a system with no stats at all differently', async () => {
		await file(
			`${VAULT.systems}/bare.md`,
			'---\nid: bare\nname: Bare\nstats: []\n---\n\nNothing.\n',
		);
		const project = await computeProject(root);

		expect(project.questions.map(q => q.kind)).toContain('system_stats_unset');
	});
});

/**
 * Every system's curve defaults to the same formula id, so formulas are stored
 * under a key that includes the system that defined them — and calling with the
 * bare id finds only the shared file. A formula written in a system's own body
 * was never reached, and the first test of this passed anyway because the
 * scaffold happens to define `max-hp` in `setting/formulas.md` as well.
 */
describe('a formula in the system’s own body', () => {
	it('is found, and not confused with a shared one of the same name', async () => {
		await derivedVault();
		// Same id, different arithmetic, in the shared file. The system's own
		// definition has to win.
		await file(VAULT.formulas, '# Formulas\n\n```js id=carry\n() => 1;\n```\n');
		const project = await consented();

		expect(project.replay.state.characters['carl']?.stats['carry']).toBe(158);
	});

	it('reports a formula no system and no shared file defines', async () => {
		await file(
			`${VAULT.systems}/core.md`,
			'---\nid: core\nstats:\n  - id: ghost\n    formula: nowhere\n---\n\nNothing.\n',
		);
		await file(
			`${VAULT.characters}/carl.md`,
			'---\nid: carl\nsystem: core\n---\n\nHim.\n',
		);
		await rm(path.join(root, VAULT.systems, 'system-01.md'), {force: true});
		const project = await consented();

		expect(
			project.questions.find(q => q.detail.includes("formula 'nowhere'")),
		).toBeDefined();
	});
});

/**
 * `max` is a constant, which is right for a bound the world fixes and wrong for
 * one a character grows into. A system whose limits rise with level cannot
 * state its cap as a number, and before `max_from` such a cap was drawn on the
 * screen and enforced nowhere.
 */
describe('a ceiling that moves with level', () => {
	async function cappedVault(level: number, alpha: number) {
		await rm(path.join(root, VAULT.systems, 'system-01.md'), {force: true});
		await file(
			`${VAULT.systems}/core.md`,
			[
				'---',
				'id: core',
				'stats:',
				'  - id: alpha',
				'    max_from: alpha-max',
				'  - id: alpha-max',
				'    formula: alpha-max',
				'---',
				'',
				'```js id=alpha-max',
				'({level}) => 20 + level * 4;',
				'```',
				'',
			].join('\n'),
		);
		await file(
			`${VAULT.characters}/carl.md`,
			`---\nid: carl\nsystem: core\nlevel: ${String(level)}\nstats:\n  alpha: ${String(alpha)}\n---\n\nHim.\n`,
		);
		return consented();
	}

	it('rises as the character does', async () => {
		const project = await cappedVault(3, 10);
		expect(project.replay.state.characters['carl']?.stats['alpha-max']).toBe(32);
	});

	it('reports a value above the ceiling it has now', async () => {
		const project = await cappedVault(1, 40);
		const finding = project.questions.find(q => q.kind === 'stat_over_ceiling');

		expect(finding?.detail).toContain('alpha=40');
		expect(finding?.detail).toContain('alpha-max 24');
		expect(finding?.detail).toContain('at level 1');
	});

	it('says nothing once the level has caught up', async () => {
		// The same 40, at a level whose ceiling allows it.
		const project = await cappedVault(6, 40);
		expect(project.questions.filter(q => q.kind === 'stat_over_ceiling')).toEqual([]);
	});
});
