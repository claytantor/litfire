import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject} from '../source/core/project.js';
import {inspectProject} from '../source/vault/projects.js';
import {VAULT} from '../source/vault/paths.js';
import {buildWiki} from '../source/wiki/build.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-legacy-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function file(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), {recursive: true});
	await writeFile(target, contents, 'utf8');
}

/**
 * A vault exactly as litfire wrote them before `corpus/` and `setting/`:
 * primitives at the top level, the setting under `system/`, moments and arcs
 * under `timeline/`.
 */
async function preMoveVault() {
	await file('system/system.md', '---\nidiom: arcane\n---\n\n# Setting\n');
	await file('system/idiom.md', '---\n---\n\n# Idiom\n');
	await file(
		'system/formulas.md',
		'# Formulas\n\n```js id=xp-for-level\n(l) => l * 100;\n```\n',
	);
	await file(
		'systems/the-lathe.md',
		'---\nid: the-lathe\nname: The Lathe\n---\n\nRules.\n',
	);
	await file(
		'timeline/moments/the-breach.md',
		'---\nid: the-breach\nat: 500\n---\n\nIt broke.\n',
	);
	await file(
		'timeline/arcs/arc-01.md',
		'---\nid: arc-01\nname: Ground Floor\norder: 1\n---\n\nArc.\n',
	);
	await file('timeline/time.md', '---\ncalendar: seconds\n---\n\n# Time\n');
	await file('characters/carl.md', '---\nid: carl\nname: Carl\n---\n\nHim.\n');
	await file('places/oz-farm.md', '---\nid: oz-farm\n---\n\nTwelve acres.\n');
	await file('factions/the-sufi.md', '---\nid: the-sufi\nname: The Sufi\n---\n\nThem.\n');
	await file('artifacts/the-keypair.md', '---\nid: the-keypair\n---\n\nIt.\n');
	await file('themes/commodification.md', '---\nid: commodification\n---\n\nIt.\n');
	await file(
		'situations/sit-001.md',
		'---\nid: sit-001\ntitle: The Arrival\narc: arc-01\n---\n\nProse.\n',
	);
	await file(
		'chapters/ch-01.md',
		'---\nid: ch-01\ntitle: One\norder: 1\nstarts_at: sit-001\n---\n\nCut.\n',
	);
	await file('index.md', '# Index\n');
}

describe('a vault written before the layout moved', () => {
	it('is still recognised as a vault', async () => {
		await preMoveVault();
		expect(await inspectProject(root)).toBe('vault');
	});

	it('loads every primitive from where it actually is', async () => {
		await preMoveVault();
		const {vault} = await computeProject(root);

		expect(vault.systems.map(s => s.id)).toEqual(['the-lathe']);
		expect(vault.moments.map(m => m.id)).toEqual(['the-breach']);
		expect(vault.arcs.map(a => a.id)).toEqual(['arc-01']);
		expect(vault.characters.map(c => c.id)).toEqual(['carl']);
		expect(vault.places.map(p => p.id)).toEqual(['oz-farm']);
		expect(vault.factions.map(f => f.id)).toEqual(['the-sufi']);
		expect(vault.artifacts.map(a => a.id)).toEqual(['the-keypair']);
		expect(vault.themes.map(t => t.id)).toEqual(['commodification']);
		expect(vault.situations.map(s => s.id)).toEqual(['sit-001']);
		expect(vault.chapters.map(c => c.id)).toEqual(['ch-01']);
		expect(vault.issues).toEqual([]);
	});

	it('reads the setting, the idiom and the clock from their old homes', async () => {
		await preMoveVault();
		const project = await computeProject(root);

		expect(project.vault.time).toBeDefined();
		expect(project.vault.formulas.some(f => f.id === 'xp-for-level')).toBe(true);
	});

	it('says which old homes it read, so /lint can report them', async () => {
		await preMoveVault();
		const {vault} = await computeProject(root);

		expect(vault.legacy).toContain('characters');
		expect(vault.legacy).toContain('timeline/moments');
		expect(vault.legacy).toContain('timeline/time.md');
	});

	it('says nothing about an old home that is empty', async () => {
		await preMoveVault();
		await rm(path.join(root, 'factions'), {recursive: true});
		const {vault} = await computeProject(root);

		expect(vault.legacy).not.toContain('factions');
	});
});

describe('a vault caught half-way', () => {
	/**
	 * Migration is per-page, so both homes are populated for as long as the
	 * author takes. The canonical one has to win, or moving a page would have no
	 * visible effect and the author would reasonably conclude it had not worked.
	 */
	it('prefers the page that has already moved', async () => {
		await preMoveVault();
		await file(
			`${VAULT.characters}/carl.md`,
			'---\nid: carl\nname: Carl, moved\n---\n\nThe current one.\n',
		);
		const {vault} = await computeProject(root);

		expect(vault.characters).toHaveLength(1);
		expect(vault.characters[0]?.name).toBe('Carl, moved');
	});

	/**
	 * Not `duplicate_id`, deliberately. A half-moved vault has both copies of
	 * every page by definition, and one finding per page would bury the one
	 * thing worth saying under thirty repetitions of it. The directory is
	 * reported once, and it names where the contents belong.
	 */
	/**
	 * A scene in the old inbox is unplaced by virtue of being there, and the
	 * loader forces that rather than trusting the frontmatter (§5). It must
	 * force it only for the copy it actually used: a scene the author has moved
	 * onto an arc, whose stale inbox copy is still on disk, is placed.
	 */
	it('does not unplace a moved scene because of the copy left behind', async () => {
		await preMoveVault();
		await file(
			`${VAULT.inbox}/sit-001.md`,
			'---\nid: sit-001\ntitle: The Arrival\n---\n\nThe stale one.\n',
		);
		await file(
			`${VAULT.situations}/sit-001.md`,
			'---\nid: sit-001\ntitle: The Arrival\narc: arc-01\n---\n\nMoved and placed.\n',
		);
		const {vault} = await computeProject(root);

		expect(vault.situations).toHaveLength(1);
		expect(vault.situations[0]?.arc).toBe('arc-01');
	});

	it('still unplaces a scene that is only in the inbox', async () => {
		await preMoveVault();
		await file(
			`${VAULT.inbox}/sit-900.md`,
			'---\nid: sit-900\ntitle: Loose\narc: arc-01\n---\n\nLoose.\n',
		);
		const {vault} = await computeProject(root);

		expect(vault.situations.find(s => s.id === 'sit-900')?.arc).toBeUndefined();
	});

	/**
	 * The regression this nearly shipped with. Deduping by id inside `loadKind`
	 * is right across homes and wrong within one — it made two files declaring
	 * one id in a single directory silently collapse to one, which is exactly
	 * the failure `duplicate_id` was written for and the one that started the
	 * raw-first work.
	 */
	it('still reports two files sharing an id in one directory', async () => {
		await preMoveVault();
		await file(
			`${VAULT.moments}/the-breach.md`,
			'---\nid: the-breach\nat: 500\n---\n\nOne.\n',
		);
		await file(
			`${VAULT.moments}/the-breach-again.md`,
			'---\nid: the-breach\nat: 500\n---\n\nTwo.\n',
		);
		const project = await computeProject(root);

		const finding = project.questions.find(q => q.kind === 'duplicate_id');
		expect(finding?.detail).toContain('corpus/moments/the-breach.md');
		expect(finding?.detail).toContain('corpus/moments/the-breach-again.md');
	});

	it('reports the old home once, not every page inside it', async () => {
		await preMoveVault();
		await file(`${VAULT.characters}/carl.md`, '---\nid: carl\n---\n\nMoved.\n');
		const project = await computeProject(root);

		const legacy = project.questions.filter(q => q.kind === 'legacy_location');
		expect(legacy.find(q => q.where === 'characters')?.detail).toContain(
			'corpus/characters/',
		);
		expect(project.questions.filter(q => q.kind === 'duplicate_id')).toEqual([]);
	});
});

/**
 * The wiki reads author prose straight off disk rather than through the
 * loader, so it needed the same dual-read and did not get it — every page of a
 * pre-move vault rendered "nothing written yet" while the corpus sat right
 * there. Twenty-two blank sections in one real vault, and the wiki reporting
 * the whole book as empty.
 */
describe('the wiki reads a pre-move vault too', () => {
	it('renders author prose from an old home', async () => {
		await preMoveVault();
		const wiki = buildWiki(await computeProject(root));
		const page = wiki.pages.find(one => one.path.endsWith('characters/carl.md'));

		expect(page?.body).toContain('Him.');
		expect(page?.body).not.toContain('_Nothing written in');
	});

	it('renders the setting from `system/system.md`', async () => {
		// The rename changed the stem as well as the directory, so an id lookup
		// tries `setting/setting.md` and `system/setting.md` and matches neither.
		await preMoveVault();
		await file('system/system.md', '---\nidiom: arcane\n---\n\nA world of rules.\n');

		const wiki = buildWiki(await computeProject(root));
		const page = wiki.pages.find(one => one.path.includes('systems/'));

		expect(page?.body).toContain('A world of rules.');
	});

	it('prefers the moved copy when both are on disk', async () => {
		await preMoveVault();
		await file(`${VAULT.characters}/carl.md`, '---\nid: carl\n---\n\nThe moved one.\n');

		const wiki = buildWiki(await computeProject(root));
		const page = wiki.pages.find(one => one.path.endsWith('characters/carl.md'));

		expect(page?.body).toContain('The moved one.');
		expect(page?.body).not.toContain('Him.');
	});
});

describe('a named system shows its own page', () => {
	/**
	 * It rendered the shared setting prose and nothing the system had written
	 * about itself, so every system in a multi-system vault read identically —
	 * and the summary block was simply never seen.
	 */
	it('renders the system’s body, not only the setting', async () => {
		await preMoveVault();
		await file(
			'systems/the-lathe.md',
			'---\nid: the-lathe\nname: The Lathe\n---\n\n<!-- litrpg:summary -->\n**Wants** — legibility.\n<!-- /litrpg:summary -->\n\nIt counts what it can see.\n',
		);

		const wiki = buildWiki(await computeProject(root));
		const page = wiki.pages.find(one => one.path.endsWith('systems/the-lathe.md'));

		expect(page?.body).toContain('It counts what it can see.');
		expect(page?.body).toContain('## At a glance');
		expect(page?.body).toContain('**Wants** — legibility.');
	});
});
