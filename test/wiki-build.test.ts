import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject, type Project} from '../source/core/project.js';
import {AGENCY_NOTE, ORIGIN_NOTE} from '../source/genre/index.js';
import {stringifyDocument} from '../source/vault/frontmatter.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';
import {buildWiki} from '../source/wiki/build.js';
import type {WikiPage} from '../source/wiki/types.js';
import {writeWiki} from '../source/wiki/write.js';

let root = '';

const put = async (relative: string, data: Record<string, unknown>, body = '\n') => {
	const file = resolve(root, relative);
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, stringifyDocument({data, body}), 'utf8');
};

const exists = async (file: string): Promise<boolean> =>
	access(file)
		.then(() => true)
		.catch(() => false);

/**
 * A small but connected fixture: two characters who share two scenes and part
 * ways in a third, an item that is gained then partly lost, a skill acquired
 * mid-book, and a milestone that deliberately drifts — every page kind in the
 * contract has something real to report on.
 *
 * Ids are `sit-9xx`/`arc-90`-style throughout: `scaffoldVault` ships example
 * content under `sit-001`/`arc-01`/`protagonist`, which has cost this project
 * three debugging cycles before, so those examples are removed below rather
 * than left to pollute exact-count assertions.
 */
async function buildFixture(): Promise<void> {
	await scaffoldVault(root, 'arcane');

	await rm(resolve(root, VAULT.characters, 'protagonist.md'), {force: true});
	await rm(resolve(root, VAULT.arcs, 'arc-01.md'), {force: true});
	await rm(resolve(root, VAULT.situations, 'sit-001-the-arrival.md'), {force: true});
	await rm(resolve(root, VAULT.themes, 'commodification.md'), {force: true});

	await put(VAULT.skills, {
		skills: [{id: 'ember-bolt', name: 'Ember Bolt', requires_skills: []}],
	});
	await put(path.join(VAULT.moments, 'we-90.md'), {
		id: 'we-90',
		name: 'The Signal',
		at: 0,
	});

	await put(path.join(VAULT.characters, 'carl.md'), {id: 'carl', level: 1, xp: 0});
	await put(path.join(VAULT.characters, 'nyx.md'), {id: 'nyx', level: 1, xp: 0});

	await put(path.join(VAULT.arcs, 'arc-90.md'), {
		id: 'arc-90',
		order: 99,
		starts_after: 'we-90',
		milestone: {carl: {level: 3, has_skills: ['ember-bolt']}},
	});

	await put(path.join(VAULT.themes, 'threads.md'), {
		id: 'threads',
		name: 'Threads',
		subthemes: [{id: 'the-signal', name: 'The Signal', tension: ['before', 'after']}],
	});

	await put(
		path.join(VAULT.situations, 'sit-901.md'),
		{
			id: 'sit-901',
			title: 'The Door',
			arc: 'arc-90',
			order: 10,
			characters: ['carl', 'nyx'],
			place: 'atrium',
			themes: ['the-signal'],
			events: [
				{type: 'level_set', actor: 'carl', value: 2},
				{type: 'acquire_skill', actor: 'carl', skill: 'ember-bolt'},
			],
		},
		'\nCarl and Nyx meet in the atrium.\n',
	);
	await put(
		path.join(VAULT.situations, 'sit-902.md'),
		{
			id: 'sit-902',
			title: 'The Ledger',
			arc: 'arc-90',
			order: 20,
			characters: ['carl', 'nyx'],
			place: 'atrium',
			events: [{type: 'item_gain', actor: 'carl', item: 'donut', qty: 8}],
		},
		'\nCarl finds a box of donuts.\n',
	);
	await put(
		path.join(VAULT.situations, 'sit-903.md'),
		{
			id: 'sit-903',
			title: 'The Overlook',
			arc: 'arc-90',
			order: 30,
			characters: ['carl'],
			place: 'overlook',
			themes: ['the-signal'],
			events: [{type: 'item_lose', actor: 'carl', item: 'donut', qty: 3}],
		},
		'\nCarl eats three donuts alone.\n',
	);

	await put(
		path.join(VAULT.places, 'atrium.md'),
		{},
		'\nThe atrium hums with old System energy.\n',
	);

	await put(path.join(VAULT.factions, 'ember-cult.md'), {}, '\nWorships the Signal.\n');
}

async function project(): Promise<Project> {
	return computeProject(root);
}

const findPage = (
	pages: readonly WikiPage[],
	kind: WikiPage['kind'],
	id: string,
): WikiPage => {
	const page = pages.find(p => p.kind === kind && p.id === id);
	if (!page) {
		throw new Error(`no ${kind} page for '${id}'`);
	}
	return page;
};

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-wiki-'));
	await buildFixture();
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

describe('buildWiki — characters', () => {
	it('states the level trajectory and the step a skill was acquired at', async () => {
		const wiki = buildWiki(await project());
		const carl = findPage(wiki.pages, 'character', 'carl');

		expect(carl.body).toContain('level **2**');
		expect(carl.body).toContain('| seed | 1 | 0 |');
		expect(carl.body).toContain('| [[sit-901]] | 2 | 0 |');
		expect(carl.body).toContain('[[ember-bolt]] at [[sit-901]]');
	});

	it('gets co-appearance counts right when two characters share scenes', async () => {
		const wiki = buildWiki(await project());
		const carl = findPage(wiki.pages, 'character', 'carl');
		const nyx = findPage(wiki.pages, 'character', 'nyx');

		expect(carl.body).toContain('[[nyx]] ×2');
		expect(nyx.body).toContain('[[carl]] ×2');
	});

	it('carries the scene count as a number in the summary, not a restatement', async () => {
		const wiki = buildWiki(await project());
		const carl = findPage(wiki.pages, 'character', 'carl');

		// Carl appears in sit-901, sit-902, sit-903 — three scenes.
		expect(carl.summary).toContain('3 scenes');
		expect(carl.summary).not.toBe('carl is a character');
	});

	it('lists items currently held, netting gains against losses', async () => {
		const wiki = buildWiki(await project());
		const carl = findPage(wiki.pages, 'character', 'carl');

		expect(carl.body).toContain('[[donut]] ×5');
	});
});

describe('buildWiki — places', () => {
	it('lists its situations in sequence order and folds in the author body', async () => {
		const wiki = buildWiki(await project());
		const atrium = findPage(wiki.pages, 'place', 'atrium');

		const firstIndex = atrium.body.indexOf('sit-901');
		const secondIndex = atrium.body.indexOf('sit-902');
		expect(firstIndex).toBeGreaterThan(-1);
		expect(secondIndex).toBeGreaterThan(firstIndex);

		expect(atrium.body).toContain('The atrium hums with old System energy.');
		expect(atrium.summary).toContain('first sit-901');
		expect(atrium.summary).toContain('last sit-902');
	});
});

describe('buildWiki — items', () => {
	it('derives item pages purely from item_gain/item_lose events', async () => {
		const wiki = buildWiki(await project());
		const donut = findPage(wiki.pages, 'item', 'donut');

		expect(donut.body).toContain('[[carl]] ×5');
		expect(donut.body).toContain('+8 [[carl]] at [[sit-902]]');
		expect(donut.body).toContain('-3 [[carl]] at [[sit-903]]');
		expect(donut.body).toContain('no item schema');
	});
});

describe('buildWiki — arcs', () => {
	it('shows milestone vs what actually replayed', async () => {
		const wiki = buildWiki(await project());
		const arc = findPage(wiki.pages, 'arc', 'arc-90');

		expect(arc.body).toContain('level 3 vs actual 2');
		expect(arc.body).toContain('— drift');
		expect(arc.body).toContain('holds: ember-bolt');
		expect(arc.body).toContain('we-90');
	});
});

describe('buildWiki — system', () => {
	it('names every stat with its default, min, and max where set', async () => {
		await put(VAULT.stats, {
			stats: [
				{id: 'strength', name: 'Strength', default: 10, min: 0, max: 20},
				{id: 'luck', default: 5},
			],
		});

		const wiki = buildWiki(await project());
		const system = findPage(wiki.pages, 'system', 'system');

		expect(system.body).toContain('Strength');
		expect(system.body).toContain('`strength`');
		expect(system.body).toContain('default **10**');
		expect(system.body).toContain('min 0, max 20');
		expect(system.body).toContain('`luck`');
		expect(system.body).toContain('default **5**');
	});

	it('carries the stat count as a number in the summary, not a label', async () => {
		await put(VAULT.stats, {
			stats: [
				{id: 'strength', default: 10},
				{id: 'agility', default: 10},
				{id: 'luck', default: 5},
			],
		});

		const wiki = buildWiki(await project());
		const system = findPage(wiki.pages, 'system', 'system');

		expect(system.summary).toContain('3 stats');
		expect(system.summary).not.toBe('The System');
	});

	it('calls out a curve naming a formula that does not exist', async () => {
		await put(VAULT.curves, {xp_for_level: 'no-such-formula', max_level: 50});

		const wiki = buildWiki(await project());
		const system = findPage(wiki.pages, 'system', 'system');

		expect(system.body).toContain('no-such-formula');
		expect(system.body).toContain('not defined');
	});

	it('lists formula ids without rendering their source', async () => {
		const wiki = buildWiki(await project());
		const system = findPage(wiki.pages, 'system', 'system');

		expect(system.body).toContain('`xp-for-level`');
		expect(system.body).toContain('`max-hp`');
		expect(system.body).not.toContain('level ** 2');
		expect(system.body).not.toContain('constitution * 8');
	});

	it('renders setting descriptors with their human sentence, and an unset one says so', async () => {
		await put(VAULT.settingFile, {
			idiom: 'arcane',
			system_origin: 'technological',
			system_agency: 'physics',
		});

		const wiki = buildWiki(await project());
		const system = findPage(wiki.pages, 'system', 'system');

		expect(system.body).toContain(ORIGIN_NOTE.technological);
		expect(system.body).toContain(AGENCY_NOTE.physics);
		expect(system.body).toContain('not yet decided');
	});

	it('still produces a page, saying so, when the /system interview never landed', async () => {
		const bareRoot = await mkdtemp(path.join(tmpdir(), 'litfire-wiki-empty-'));
		try {
			const wiki = buildWiki(await computeProject(bareRoot));
			const system = findPage(wiki.pages, 'system', 'system');

			expect(system.body).toContain('No stats defined');
			expect(system.body).toContain('None declared');
			expect(system.summary).toContain('0 stats');
		} finally {
			await rm(bareRoot, {recursive: true, force: true});
		}
	});
});

describe('buildWiki — index', () => {
	it('lists every page grouped by kind, with its summary', async () => {
		const wiki = buildWiki(await project());
		const index = findPage(wiki.pages, 'index', 'index');

		for (const page of wiki.pages) {
			if (page.kind === 'index') {
				continue;
			}
			// The link target is always the id, because that is what a wikilink
			// resolves against; a page whose name differs from its slug carries it
			// as an alias, so the index reads in the author's words.
			const link =
				page.title.toLowerCase() === page.id.toLowerCase()
					? `[[${page.id}]]`
					: `[[${page.id}|${page.title}]]`;
			expect(index.body).toContain(`${link} — ${page.summary}`);
		}
	});

	it('shows a named page by its name, not its slug', async () => {
		const wiki = buildWiki(await project());
		const index = findPage(wiki.pages, 'index', 'index');

		// The reported bug: an index that lists slugs tells the author "system"
		// about a thing they named, and "ember-bolt" about Ember Bolt.
		expect(index.body).toContain('[[ember-bolt|Ember Bolt]]');
		expect(index.body).not.toContain('[[ember-bolt]]');
	});
});

describe('buildWiki — generated banner', () => {
	it('opens every page body with the generated banner', async () => {
		const wiki = buildWiki(await project());

		for (const page of wiki.pages) {
			expect(page.body).toContain('Generated file');
			expect(page.body).toContain('Written by litfire');
		}
	});
});

describe('writeWiki', () => {
	it('creates every page under wiki/', async () => {
		const wiki = buildWiki(await project());
		const result = await writeWiki(root, wiki);

		expect(result.written).toContain('wiki/characters/carl.md');
		expect(result.written).toContain('wiki/characters/nyx.md');
		expect(result.written).toContain('wiki/index.md');
		expect(await exists(resolve(root, VAULT.wiki, 'characters', 'carl.md'))).toBe(true);
		expect(await exists(resolve(root, VAULT.wiki, 'index.md'))).toBe(true);
	});

	it('removes a stale character page after that character is deleted from the corpus', async () => {
		await writeWiki(root, buildWiki(await project()));
		expect(await exists(resolve(root, VAULT.wiki, 'characters', 'nyx.md'))).toBe(true);

		await rm(resolve(root, VAULT.characters, 'nyx.md'));

		const result = await writeWiki(root, buildWiki(await project()));

		expect(result.removed).toContain('wiki/characters/nyx.md');
		expect(await exists(resolve(root, VAULT.wiki, 'characters', 'nyx.md'))).toBe(false);
		// Carl's page is untouched by the recompute that dropped Nyx.
		expect(await exists(resolve(root, VAULT.wiki, 'characters', 'carl.md'))).toBe(true);
	});

	it('never touches anything outside wiki/', async () => {
		const before = await readFile(resolve(root, VAULT.characters, 'carl.md'), 'utf8');

		await writeWiki(root, buildWiki(await project()));

		const after = await readFile(resolve(root, VAULT.characters, 'carl.md'), 'utf8');
		expect(after).toBe(before);
		expect(after).not.toContain('Generated file');
	});
});

/**
 * The failure these pin: `/system extract` writes the meaning of the System as
 * prose into `system/system.md`, and the wiki page read only its frontmatter —
 * so an author's interview landed on disk and still appeared nowhere. The same
 * omission applied to characters, arcs, and themes. Places and factions already
 * folded the author's body in, which is what made the gap look deliberate.
 */
describe("buildWiki — the author's own prose", () => {
	const pageAt = (pages: readonly WikiPage[], wikiPath: string) =>
		pages.find(page => page.path === wikiPath)?.body ?? '';

	it('shows what the /system interview actually established', async () => {
		await buildFixture();
		await put(
			VAULT.settingFile,
			{idiom: 'arcane', system_visibility: 'privileged'},
			'\nLevelling costs memory. You trade who you were for what you can do.\n',
		);

		const wiki = buildWiki(await computeProject(root));

		expect(pageAt(wiki.pages, `${VAULT.wiki}/systems/system.md`)).toContain(
			'Levelling costs memory',
		);
	});

	it('keeps the idiom and descriptors alongside the prose', async () => {
		await buildFixture();
		await put(
			VAULT.settingFile,
			{idiom: 'arcane', system_visibility: 'privileged'},
			'\nOnly the indebted see the numbers.\n',
		);

		const page = pageAt(
			buildWiki(await computeProject(root)).pages,
			`${VAULT.wiki}/systems/system.md`,
		);

		expect(page).toContain('Only the indebted see the numbers');
		expect(page).toContain('Visibility');
	});

	it("shows a character's narrative body", async () => {
		await buildFixture();
		await put(
			`${VAULT.characters}/carl.md`,
			{id: 'carl', name: 'Carl', level: 1, xp: 0},
			'\nA debtor with good handwriting and a failing memory.\n',
		);

		const page = pageAt(
			buildWiki(await computeProject(root)).pages,
			`${VAULT.wiki}/characters/carl.md`,
		);

		expect(page).toContain('good handwriting');
	});

	it('shows what an arc is about, not only its situations', async () => {
		await buildFixture();
		await put(
			`${VAULT.arcs}/arc-90.md`,
			{id: 'arc-90', name: 'Descent', order: 1},
			'\nCarl learns the debt is transferable, and that he is not the first.\n',
		);

		const page = pageAt(
			buildWiki(await computeProject(root)).pages,
			`${VAULT.wiki}/arcs/arc-90.md`,
		);

		expect(page).toContain('not the first');
	});

	/**
	 * Note which page: `/init` writes a prose body into `system/system.md`
	 * explaining the descriptors, so the System page always has *something*. An
	 * arc created without a body is the honest empty case.
	 */
	it('says so plainly when a page has no prose yet', async () => {
		await buildFixture();
		await put(`${VAULT.arcs}/arc-91.md`, {id: 'arc-91', name: 'Quiet', order: 5});

		const page = pageAt(
			buildWiki(await computeProject(root)).pages,
			`${VAULT.wiki}/arcs/arc-91.md`,
		);

		expect(page).toContain('Nothing written in');
	});
});
