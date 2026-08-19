import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	DEFAULT_SYSTEM_ID,
	characterSchema,
	systemSchema,
} from '../source/domain/schema.js';
import {computeProject} from '../source/core/project.js';
import {replay, systemFor} from '../source/ledger/replay.js';
import {FormulaRunner, formulaKey, hashFormulas} from '../source/system/sandbox.js';
import {loadVault} from '../source/vault/load.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';
import {buildWiki} from '../source/wiki/build.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-systems-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

/** A system page: schema in the frontmatter, formulas in the body. */
async function writeSystem(id: string, frontmatter: string, body = ''): Promise<void> {
	await mkdir(path.join(root, VAULT.systems), {recursive: true});
	await writeFile(
		path.join(root, VAULT.systems, `${id}.md`),
		`---\nid: ${id}\n${frontmatter}---\n\n# ${id}\n\n${body}\n`,
		'utf8',
	);
}

const SEED = [
	'name: The Seed',
	'stats:',
	'  - {id: vitality, default: 10, max: 20}',
	'skills:',
	'  - {id: graft}',
	'curves: {xp_for_level: xp-for-level, max_level: 50}',
	'',
].join('\n');

const CUSTODIAN = [
	'name: The Custodian',
	'stats:',
	'  - {id: standing, default: 0}',
	'curves: {xp_for_level: xp-for-level, max_level: 50}',
	'',
].join('\n');

// Both systems name their curve `xp-for-level` — the default, and therefore the
// collision every multi-system vault hits immediately.
const SEED_CURVE = '```js id=xp-for-level\n(level) => (level - 1) * 100;\n```';
const CUSTODIAN_CURVE = '```js id=xp-for-level\n(level) => (level - 1) * 1000;\n```';

async function character(id: string, frontmatter: string): Promise<void> {
	await mkdir(path.join(root, VAULT.characters), {recursive: true});
	await writeFile(
		path.join(root, VAULT.characters, `${id}.md`),
		`---\nid: ${id}\n${frontmatter}---\n\n# ${id}\n`,
		'utf8',
	);
}

const said = (r: {lines: readonly {readonly text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

describe('systems as a primitive', () => {
	it('loads one page per system, id-sorted', async () => {
		await writeSystem('seed', SEED);
		await writeSystem('custodian', CUSTODIAN);

		const vault = await loadVault(root);
		expect(vault.issues).toEqual([]);
		expect(vault.systems.map(s => s.id)).toEqual(['custodian', 'seed']);
		expect(vault.systems.find(s => s.id === 'seed')?.name).toBe('The Seed');
	});

	it('reads a legacy vault as the one system named `system`', async () => {
		await scaffoldVault(root);
		const vault = await loadVault(root);

		expect(vault.systems).toHaveLength(1);
		expect(vault.systems[0]?.id).toBe(DEFAULT_SYSTEM_ID);
		// The scaffold seeds stats from the profile, so this is real content.
		expect(vault.systems[0]?.stats.length).toBeGreaterThan(0);
	});

	it('never returns an empty list, so nothing downstream special-cases it', async () => {
		const vault = await loadVault(root);
		expect(vault.systems).toHaveLength(1);
		expect(vault.systems[0]?.stats).toEqual([]);
	});

	it('drops the empty legacy system once a vault has moved to systems/', async () => {
		await writeSystem('seed', SEED);
		const vault = await loadVault(root);

		expect(vault.systems.map(s => s.id)).toEqual(['seed']);
	});
});

describe('formulas are scoped to their system', () => {
	it('keeps two `xp-for-level` curves apart', async () => {
		await writeSystem('seed', SEED, SEED_CURVE);
		await writeSystem('custodian', CUSTODIAN, CUSTODIAN_CURVE);

		const vault = await loadVault(root);
		expect(vault.formulas.map(f => formulaKey(f.id, f.system)).toSorted()).toEqual([
			'custodian/xp-for-level',
			'seed/xp-for-level',
		]);

		const runner = await FormulaRunner.create(vault.formulas);
		try {
			expect(runner.errors).toEqual([]);
			// Same id, resolved through different systems, different answers.
			expect(await runner.call(runner.resolve('xp-for-level', 'seed')!, 3)).toBe(200);
			expect(await runner.call(runner.resolve('xp-for-level', 'custodian')!, 3)).toBe(
				2000,
			);
		} finally {
			runner.dispose();
		}
	});

	it('falls back to the shared file for a rule that really is universal', async () => {
		await writeSystem('seed', SEED);
		await mkdir(path.join(root, VAULT.system), {recursive: true});
		await writeFile(
			path.join(root, VAULT.formulas),
			'```js id=shared\n() => 7;\n```\n',
			'utf8',
		);

		const vault = await loadVault(root);
		const runner = await FormulaRunner.create(vault.formulas);
		try {
			expect(runner.resolve('shared', 'seed')).toBe('shared');
			expect(runner.has('shared', 'seed')).toBe(true);
			expect(runner.resolve('nowhere', 'seed')).toBeUndefined();
		} finally {
			runner.dispose();
		}
	});

	it('hashes the same id in two systems as two formulas', () => {
		const one = hashFormulas([{id: 'x', source: '() => 1;', system: 'seed'}]);
		const two = hashFormulas([{id: 'x', source: '() => 1;', system: 'custodian'}]);
		expect(one).not.toBe(two);
	});
});

describe('a character is under exactly one system', () => {
	it('needs no `system:` when the vault has only one', () => {
		const systems = [systemSchema.parse({id: 'seed'})];
		expect(systemFor(undefined, systems)?.id).toBe('seed');
	});

	it('will not choose between two, and says so instead of guessing', async () => {
		await writeSystem('seed', SEED);
		await writeSystem('custodian', CUSTODIAN);
		await character('inanna', '');

		const project = await computeProject(root);
		const kinds = project.questions.map(q => q.kind);
		expect(kinds).toContain('character_system_unset');
		// No stats seeded from either system — picking one would decide what every
		// number on the sheet means.
		expect(project.replay.state.characters['inanna']?.system).toBeUndefined();
		expect(project.replay.state.characters['inanna']?.stats).toEqual({});
	});

	it('reports a system that does not exist', async () => {
		await writeSystem('seed', SEED);
		await character('inanna', 'system: nowhere\n');

		const project = await computeProject(root);
		const broken = project.questions.find(q => q.actor === 'inanna');
		expect(broken?.kind).toBe('broken_reference');
		expect(broken?.detail).toContain("'nowhere'");
	});

	it('seeds stats from their own system, not from every system', async () => {
		await writeSystem('seed', SEED);
		await writeSystem('custodian', CUSTODIAN);
		await character('inanna', 'system: seed\n');

		const project = await computeProject(root);
		const state = project.replay.state.characters['inanna'];
		expect(state?.system).toBe('seed');
		expect(state?.stats).toEqual({vitality: 10});
		expect(state?.stats['standing']).toBeUndefined();
	});
});

describe('porting between systems', () => {
	const situation = async (events: string) => {
		await mkdir(path.join(root, VAULT.situations), {recursive: true});
		await writeFile(
			path.join(root, VAULT.situations, 'sit-a.md'),
			`---\nid: sit-a\nevents:\n${events}---\n\n# sit-a\n`,
			'utf8',
		);
		await mkdir(path.join(root, VAULT.arcs), {recursive: true});
		await writeFile(
			path.join(root, VAULT.arcs, 'arc-01.md'),
			'---\nid: arc-01\norder: 1\n---\n\n# arc-01\n',
			'utf8',
		);
		await writeFile(
			path.join(root, VAULT.situations, 'sit-a.md'),
			`---\nid: sit-a\narc: arc-01\norder: 1\nevents:\n${events}---\n\n# sit-a\n`,
			'utf8',
		);
	};

	it('re-derives the level under the new curve from the XP already earned', async () => {
		await writeSystem('seed', SEED, SEED_CURVE);
		await writeSystem('custodian', CUSTODIAN, CUSTODIAN_CURVE);
		await character('inanna', 'system: seed\n');
		await situation(
			[
				'  - {type: xp, actor: inanna, value: 500}',
				'  - {type: port, actor: inanna, system: custodian}',
				'',
			].join('\n'),
		);

		const vault = await loadVault(root);
		const runner = await FormulaRunner.create(vault.formulas);
		try {
			const result = await replay({
				systems: vault.systems,
				moments: vault.moments,
				arcs: vault.arcs,
				situations: vault.situations,
				characters: vault.characters,
				formulas: runner,
			});

			const state = result.state.characters['inanna'];
			expect(state?.system).toBe('custodian');
			// 500 xp is level 6 on the Seed's curve (100/level) and level 1 on the
			// Custodian's (1000/level). Same experience, different standing.
			expect(state?.level).toBe(1);
			// The new system's stat arrives at its default...
			expect(state?.stats['standing']).toBe(0);
			// ...and the old one is kept rather than deleted.
			expect(state?.stats['vitality']).toBe(10);

			const port = result.findings.find(f => f.kind === 'system_port');
			expect(port?.detail).toContain("from 'seed' to 'custodian'");
			expect(port?.detail).toContain('carrying 1 stat');
		} finally {
			runner.dispose();
		}
	});

	it('reports a port to a system that does not exist', async () => {
		await writeSystem('seed', SEED, SEED_CURVE);
		await character('inanna', 'system: seed\n');
		await situation('  - {type: port, actor: inanna, system: nowhere}\n');

		const project = await computeProject(root);
		const broken = project.questions.find(q => q.detail.includes('port names system'));
		expect(broken?.kind).toBe('broken_reference');
		expect(project.replay.state.characters['inanna']?.system).toBe('seed');
	});
});

describe('the wiki follows', () => {
	it('files a lone system with the rest, not at a special path', async () => {
		// One system is not a different kind of thing from two. Keeping
		// `wiki/system.md` for the single case meant the slug said `system` about
		// a page the author had named, and meant the page moved the moment a
		// second system appeared.
		await scaffoldVault(root);
		const wiki = buildWiki(await computeProject(root));

		expect(wiki.pages.some(p => p.path === `${VAULT.wiki}/systems/system.md`)).toBe(true);
		expect(wiki.pages.some(p => p.path === `${VAULT.wiki}/system.md`)).toBe(false);
	});

	it('lists a system in the index by its name, not its id', async () => {
		// The reported bug was "Systems (1) / system — 5 stats…" for a system the
		// author had named. The page id is now the system's own, so the link
		// target reads as the thing it names and the alias carries the name.
		await writeSystem('the-lathe', SEED);
		const wiki = buildWiki(await computeProject(root));
		const index = wiki.pages.find(page => page.kind === 'index');

		expect(index?.body).toContain('## Systems (1)');
		expect(index?.body).toContain('[[the-lathe|The Seed]]');
		expect(index?.body).not.toMatch(/- \[\[system]] —/);
	});

	it('gives each system its own page, listing who is under it', async () => {
		await writeSystem('seed', SEED, SEED_CURVE);
		await writeSystem('custodian', CUSTODIAN, CUSTODIAN_CURVE);
		await character('inanna', 'system: seed\n');

		const wiki = buildWiki(await computeProject(root));
		const paths = wiki.pages.map(p => p.path);
		expect(paths).toContain(`${VAULT.wiki}/systems/seed.md`);
		expect(paths).toContain(`${VAULT.wiki}/systems/custodian.md`);

		const seed = wiki.pages.find(p => p.path === `${VAULT.wiki}/systems/seed.md`);
		expect(seed?.title).toBe('The Seed');
		expect(seed?.body).toContain('[[inanna]]');

		const custodian = wiki.pages.find(
			p => p.path === `${VAULT.wiki}/systems/custodian.md`,
		);
		expect(custodian?.body).toContain('_Nobody._');
	});
});

describe('the character schema', () => {
	it('accepts a system and leaves it out when unset', () => {
		expect(characterSchema.parse({id: 'a', system: 'seed'}).system).toBe('seed');
		expect(characterSchema.parse({id: 'a'}).system).toBeUndefined();
	});
});

describe('the in-world clock at deep time', () => {
	/** One page per moment, which is what a timeline is made of now. */
	const moment = async (id: string, frontmatter = '') => {
		await mkdir(path.join(root, VAULT.moments), {recursive: true});
		await writeFile(
			path.join(root, VAULT.moments, `${id}.md`),
			`---\nid: ${id}\n${frontmatter}---\n\n# ${id}\n`,
			'utf8',
		);
	};

	it('states the real granularity when a position leaves the exact range', async () => {
		// 800 million years ago, counted in seconds: -800000000 * 31536000.
		await moment('substrate-patch', 'at: -25228800000000000\n');

		const project = await computeProject(root);
		const finding = project.questions.find(q => q.kind === 'clock_beyond_exact_range');

		expect(finding?.detail).toContain('substrate-patch');
		// Computed for this magnitude, not a hardcoded warning.
		expect(finding?.detail).toContain('within 4 of it cannot be told apart');
	});

	it('says nothing about positions the clock can represent exactly', async () => {
		await moment('the-arrival', 'at: 0\n');
		await moment('later', 'at: 86400\n');

		const project = await computeProject(root);
		expect(project.questions.map(q => q.kind)).not.toContain('clock_beyond_exact_range');
	});

	it('reports two events that land on the same instant', async () => {
		// One second apart at this magnitude is no distance at all.
		await moment('patch', 'at: -25228800000000000\n');
		await moment('aftermath', 'at: -25228799999999999\n');

		const project = await computeProject(root);
		const collision = project.questions.find(q => q.kind === 'clock_collision');
		expect(collision?.detail).toContain('aftermath, patch');
		expect(collision?.detail).toContain('orders them by id');
	});
});

describe('the system extraction brief', () => {
	it('targets systems/<id>.md and forbids the layout it replaced', async () => {
		const {buildExtractionMessages} = await import('../source/interview/extract.js');
		const messages = buildExtractionMessages(
			{
				id: 't',
				kind: 'system',
				startedAt: '2026-01-01T00:00:00.000Z',
				status: 'complete',
				exchanges: [],
			},
			'',
		);
		const hint = messages[1]?.content ?? '';

		expect(hint).toContain('systems/<id>.md');
		// The bug this guards: a brief that names both layouts makes the model
		// recreate system/stats.md, which splits a migrated vault back into two
		// systems fighting over the same characters.
		expect(hint).toContain('Never propose');
		expect(hint).toMatch(/system\/stats\.md.*old single-system layout/s);
		expect(hint).toContain('system/system.md is NOT a system page');
	});

	it('tells the model that parts of one apparatus are one system', async () => {
		// The Seed, the Custodian and the Sky are components of the Lathe, not
		// three systems: a character is under one at a time, so "two systems"
		// means two sets of rules that could track someone instead of each other.
		const {buildExtractionMessages} = await import('../source/interview/extract.js');
		const hint =
			buildExtractionMessages(
				{
					id: 't',
					kind: 'system',
					startedAt: '2026-01-01T00:00:00.000Z',
					status: 'complete',
					exchanges: [],
				},
				'',
			)[1]?.content ?? '';

		expect(hint).toContain('one system with several components');
		expect(hint).toContain('do not invent one');
	});
});

describe('systems are namespaced by id', () => {
	beforeEach(async () => {
		// Interviews refuse without a provider, and these assert routing, not auth.
		const {saveProvider} = await import('../source/vault/config.js');
		await saveProvider(root, {id: 'openai', model: 'gpt-4o'});
	});

	const dispatch = async (line: string) => {
		const {findCommand} = await import('../source/commands/registry.js');
		const [name, ...args] = line.replace(/^\//, '').split(' ');
		return findCommand(name!)!.run(args, {
			root,
			project: await computeProject(root),
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		});
	};

	it('names the only system rather than staying unfocused', async () => {
		await writeSystem('the-lathe', SEED);
		const result = await dispatch('/system');

		// One system is not a choice, but the transcript still lands in the same
		// namespace a multi-system vault would use.
		expect(result.interview).toEqual({kind: 'system', focus: 'the-lathe'});
	});

	it('refuses to guess when there are two, and lists them', async () => {
		await writeSystem('seed', SEED);
		await writeSystem('custodian', CUSTODIAN);
		const rendered = said(await dispatch('/system'));

		expect(rendered).toContain('this vault has 2 systems — name one');
		expect(rendered).toContain('/system seed — The Seed');
		expect(rendered).toContain('/system custodian — The Custodian');
	});

	it('interviews the one you name', async () => {
		await writeSystem('seed', SEED);
		await writeSystem('custodian', CUSTODIAN);

		expect((await dispatch('/system custodian')).interview).toEqual({
			kind: 'system',
			focus: 'custodian',
		});
	});

	it('shows one system in full and all of them in a list', async () => {
		await writeSystem('seed', SEED);
		await writeSystem('custodian', CUSTODIAN);

		const list = said(await dispatch('/system show'));
		expect(list).toContain('2 character systems');

		const one = said(await dispatch('/system seed show'));
		expect(one).toContain('system — The Seed');
		expect(one).toContain('vitality');
		// Namespaced: the other system's stats are not in this view.
		expect(one).not.toContain('standing');
	});

	it('says so when a named system does not exist', async () => {
		await writeSystem('seed', SEED);
		expect(said(await dispatch('/system nowhere show'))).toContain("no system 'nowhere'");
	});

	it('narrows interview grounding to the system being interviewed', async () => {
		const {buildGrounding} = await import('../source/interview/grounding.js');
		await writeSystem('seed', SEED);
		await writeSystem('custodian', CUSTODIAN);

		const grounding = await buildGrounding(root, 'system', {focus: 'seed'});
		expect(grounding).toContain('systems/seed.md');
		// Handing the model a sibling system's stats is how the two get confused.
		expect(grounding).not.toContain('systems/custodian.md');
	});
});

describe('systems must be named', () => {
	it('raises an open question rather than dropping the page', async () => {
		// No `name:` — the stats still load, because losing a whole cast's numbers
		// over a missing title is the worse outcome.
		await writeSystem('the-lathe', 'stats:\n  - {id: vitality, default: 10}\n');

		const project = await computeProject(root);
		expect(project.vault.systems[0]?.stats).toHaveLength(1);

		const question = project.questions.find(q => q.kind === 'system_unnamed');
		expect(question?.detail).toContain("'the-lathe'");
		expect(question?.detail).toContain('add `name:`');
	});

	it('says nothing when the system is named', async () => {
		await writeSystem('the-lathe', SEED);
		const project = await computeProject(root);
		expect(project.questions.map(q => q.kind)).not.toContain('system_unnamed');
	});
});

describe('transcripts recorded before namespacing', () => {
	it('are still found by a namespaced lookup', async () => {
		const {saveTranscript, findForResume, transcriptsForKind} =
			await import('../source/interview/index.js');
		await writeSystem('the-lathe', SEED);
		// No focus: how every /system interview was recorded before systems had ids.
		await saveTranscript(root, {
			id: 'system-2026-08-15T09-53-40',
			kind: 'system',
			startedAt: '2026-08-15T09:53:40.000Z',
			status: 'complete',
			exchanges: [{question: 'Who made it?', answer: 'The Travellers.'}],
		});

		const found = await findForResume(root, 'system', 'the-lathe');
		expect(found?.transcript.id).toBe('system-2026-08-15T09-53-40');
		expect(await transcriptsForKind(root, 'system', 'the-lathe')).toHaveLength(1);
	});

	it('are not preferred once a namespaced one exists', async () => {
		const {saveTranscript, findForResume} = await import('../source/interview/index.js');
		await writeSystem('the-lathe', SEED);
		for (const t of [
			{
				id: 'system-2026-08-15T09-53-40',
				focus: undefined,
				at: '2026-08-15T09:53:40.000Z',
			},
			{
				id: 'system-the-lathe-2026-09-01T00-00-00',
				focus: 'the-lathe',
				at: '2026-09-01T00:00:00.000Z',
			},
		]) {
			await saveTranscript(root, {
				id: t.id,
				kind: 'system',
				startedAt: t.at,
				status: 'complete',
				...(t.focus === undefined ? {} : {focus: t.focus}),
				exchanges: [{question: 'q', answer: 'a'}],
			});
		}

		const found = await findForResume(root, 'system', 'the-lathe');
		expect(found?.transcript.id).toBe('system-the-lathe-2026-09-01T00-00-00');
	});
});

describe('the wiki renders a timeline as a timeline', () => {
	const moment = async (id: string, frontmatter = '') => {
		await mkdir(path.join(root, VAULT.moments), {recursive: true});
		await writeFile(
			path.join(root, VAULT.moments, `${id}.md`),
			`---\nid: ${id}\n${frontmatter}---\n\n# ${id}\n`,
			'utf8',
		);
	};

	it('lists moments in clock order, not alphabetical order', async () => {
		// The reported bug. Sorted by title these come out
		// ascension → cambrian → substrate, which states the sequence backwards.
		await moment(
			'the-substrate-patch',
			'name: The Substrate Patch\nat: -26174880000000000\n',
		);
		await moment(
			'the-cambrian-activation',
			'name: The Cambrian Activation\nat: -16714080000000000\n',
		);
		await moment('the-arrival', 'name: The Arrival\nat: 0\n');

		const wiki = buildWiki(await computeProject(root));
		const index = wiki.pages.find(page => page.kind === 'index')?.body ?? '';
		const order = index
			.split('\n')
			.filter(row => row.startsWith('- [[the-'))
			.map(row => /\[\[([a-z-]+)/.exec(row)?.[1]);

		expect(order).toEqual([
			'the-substrate-patch',
			'the-cambrian-activation',
			'the-arrival',
		]);
	});

	it('puts undated moments after every dated one', async () => {
		await moment('dated', 'name: Dated\nat: 0\n');
		await moment('a-undated', 'name: A Undated\n');

		const wiki = buildWiki(await computeProject(root));
		const index = wiki.pages.find(page => page.kind === 'index')?.body ?? '';
		expect(index.indexOf('[[dated')).toBeLessThan(index.indexOf('[[a-undated'));
	});

	it('carries the integer position in the summary', async () => {
		await moment(
			'the-substrate-patch',
			'name: The Substrate Patch\nat: -26174880000000000\n',
		);

		const wiki = buildWiki(await computeProject(root));
		const page = wiki.pages.find(p => p.id === 'the-substrate-patch');
		expect(page?.summary).toContain('at -26174880000000000');
		expect(page?.body).toContain('On the in-world clock at **-26174880000000000**');
	});
});
