import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {parseDocument} from '../source/vault/frontmatter.js';
import {scaffoldVault} from '../source/vault/scaffold.js';
import {buildWiki} from '../source/wiki/index.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-place-'));
	await scaffoldVault(root, 'arcane');
	context = {
		root,
		project: await computeProject(root),
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	};
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	const result = await findCommand(head.replace(/^\//, ''))!.run(args, context);
	if (result.dirty) {
		context = {...context, project: await computeProject(root)};
	}
	return result;
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

const places = () => context.project!.vault.places;

describe('places are a primitive now', () => {
	it('loads a page as a place with an id and a name', async () => {
		await run('/place new The Ledger Room');

		expect(places().some(p => p.id === 'the-ledger-room')).toBe(true);
		expect(places().find(p => p.id === 'the-ledger-room')?.name).toBe('The Ledger Room');
	});

	it('opens the buffer to describe it, since a place is mostly prose', async () => {
		const result = await run('/place new The Ledger Room');
		expect(result.openEditor).toContain('the-ledger-room.md');
	});

	it('refuses to overwrite a page that exists', async () => {
		await run('/place new The Ledger Room');
		expect(said(await run('/place new The Ledger Room'))).toContain('already has a page');
	});

	it('renames without touching the prose', async () => {
		await run('/place new The Ledger Room');
		const file = path.join(root, 'corpus', 'places', 'the-ledger-room.md');
		const body = parseDocument(await readFile(file, 'utf8')).body;

		await run('/place the-ledger-room name The Counting House');

		expect(places().find(p => p.id === 'the-ledger-room')?.name).toBe(
			'The Counting House',
		);
		expect(parseDocument(await readFile(file, 'utf8')).body).toBe(body);
	});

	it('refuses a second page that would slug to the same id', async () => {
		await run('/place new The Ledger Room');
		// Different words, same slug.
		expect(said(await run('/place new the  ledger  room'))).toContain(
			'already has a page',
		);
	});

	it('reports two pages sharing a name, like every other primitive', async () => {
		// Written directly, because that is how it happens: extraction slugs one
		// place two ways and the command that refuses collisions never runs.
		await run('/place new The Ledger Room');
		await writeFile(
			path.join(root, 'corpus', 'places', 'ledger-room.md'),
			'---\nid: ledger-room\nname: The Ledger Room\n---\n\nProse.\n',
			'utf8',
		);
		context = {...context, project: await computeProject(root)};

		const finding = context.project!.questions.find(q => q.kind === 'duplicate_name');
		expect(finding?.detail).toContain('ledger-room');
		expect(finding?.detail).toContain('the-ledger-room');
	});
});

describe('the link to a situation', () => {
	it('shows the scenes that happen there', async () => {
		await run('/place new The Ledger Room');
		await run('/situation new A Scene');
		context = {...context, project: await computeProject(root)};
		await run('/situation sit-002 place the-ledger-room');

		const shown = said(await run('/place the-ledger-room'));
		expect(shown).toContain('scenes here');
		expect(shown).toContain('sit-002');
	});

	it('lists who has been there', async () => {
		await run('/place new The Ledger Room');
		await run('/situation new A Scene');
		context = {...context, project: await computeProject(root)};
		await run('/situation sit-002 place the-ledger-room');
		await run('/situation sit-002 cast carl');

		expect(said(await run('/place the-ledger-room'))).toContain('carl');
	});

	/**
	 * The reported gap: a place with a page but no scene was invisible, because
	 * the wiki derived place ids from `situation.place` alone.
	 */
	it('gets a wiki page before any scene happens there', async () => {
		await run('/place new The Ledger Room');

		const page = buildWiki(context.project!).pages.find(
			p => p.kind === 'place' && p.id === 'the-ledger-room',
		);
		expect(page).toBeDefined();
		expect(page?.title).toBe('The Ledger Room');
	});

	it('still gets one when a scene names somewhere unwritten', async () => {
		await run('/situation new A Scene');
		context = {...context, project: await computeProject(root)};
		await run('/situation sit-002 place the-undercroft');

		const page = buildWiki(context.project!).pages.find(
			p => p.kind === 'place' && p.id === 'the-undercroft',
		);
		expect(page).toBeDefined();
		// No page of its own, so it is titled by its id and says so.
		expect(page?.title).toBe('the-undercroft');
		expect(page?.body).toContain('No `corpus/places/the-undercroft.md` file yet');
	});
});

describe('reading places back', () => {
	it('says both kinds of unfinished apart', async () => {
		await run('/place new Written But Unused');
		await run('/situation new A Scene');
		context = {...context, project: await computeProject(root)};
		await run('/situation sit-002 place named-but-unwritten');

		const shown = said(await run('/place'));
		expect(shown).toContain('written-but-unused');
		expect(shown).toContain('no scenes');
		expect(shown).toContain('named-but-unwritten');
		expect(shown).toContain('no page yet');
	});

	it('lists nothing helpfully when there are none', async () => {
		expect(said(await run('/place'))).toContain('/place new');
	});

	it('reports a name nothing in the vault knows', async () => {
		expect(said(await run('/place nowhere'))).toContain("no place 'nowhere'");
	});

	it('shows a scene-named place that has no page, rather than refusing', async () => {
		await run('/situation new A Scene');
		context = {...context, project: await computeProject(root)};
		await run('/situation sit-002 place the-undercroft');

		const shown = said(await run('/place the-undercroft'));
		expect(shown).toContain('no page yet');
		expect(shown).toContain('/place new the-undercroft');
	});

	it('appears in /primitives with its name and scene count', async () => {
		await run('/place new The Ledger Room');
		await run('/situation new A Scene');
		context = {...context, project: await computeProject(root)};
		await run('/situation sit-002 place the-ledger-room');

		const shown = said(await run('/primitives place'));
		expect(shown).toContain('the-ledger-room');
		expect(shown).toContain('The Ledger Room');
		expect(shown).toContain('1 scene');
	});
});
