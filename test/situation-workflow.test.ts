import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {momentSchema} from '../source/domain/schema.js';
import {parseDocument, stringifyDocument} from '../source/vault/frontmatter.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';
import {buildWiki} from '../source/wiki/index.js';

let root = '';
let context: CommandContext;

/** Recomputed after every write, the way App does on a `dirty` result. */
async function refresh() {
	context = {...context, project: await computeProject(root)};
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-workflow-'));
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
	const command = findCommand(head.replace(/^\//, ''));
	if (!command) {
		throw new Error(`no command for ${line}`);
	}
	const result = await command.run(args, context);
	if (result.dirty) {
		await refresh();
	}
	return result;
}

const said = (result: {lines: readonly {text: string}[]}) =>
	result.lines.map(line => line.text).join('\n');

/** A dated moment, which the scaffold does not ship. */
async function writeMoment(id: string, at: number) {
	await writeFile(
		resolve(root, VAULT.moments, `${id}.md`),
		stringifyDocument({data: momentSchema.parse({id, name: id, at}), body: '\n'}),
		'utf8',
	);
	await refresh();
}

describe('the documented workflow', () => {
	it('carries a scene from nothing to fully linked', async () => {
		await writeMoment('the-breach', 0);

		// 1. An arc has to exist before a scene can be placed on one.
		expect(said(await run('/arc new The Long Descent'))).toContain('created');

		// 2. Anchoring the arc to a moment is what gives its scenes a clock
		//    position to inherit.
		expect(said(await run('/arc arc-02 after the-breach'))).toContain(
			'starts after the-breach',
		);

		// 3. The scene itself.
		const created = await run('/situation new The Ledger Room');
		expect(created.openEditor).toBeDefined();
		await refresh();

		// 4. Link it: arc, moment, place, cast.
		expect(said(await run('/situation sit-002 arc arc-02'))).toContain('placed');
		expect(said(await run('/situation sit-002 moment the-breach'))).toContain(
			'happens at the-breach',
		);
		expect(said(await run('/situation sit-002 place the-atrium'))).toContain(
			'happens at the-atrium',
		);
		expect(said(await run('/situation sit-002 cast carl'))).toContain('carl');

		const situation = context.project!.vault.situations.find(s => s.id === 'sit-002');
		expect(situation?.arc).toBe('arc-02');
		expect(situation?.moment).toBe('the-breach');
		expect(situation?.place).toBe('the-atrium');
		expect(situation?.characters).toContain('carl');
	});

	it('puts the scene, its place and its arc into the wiki', async () => {
		await writeMoment('the-breach', 0);
		await run('/arc new The Long Descent');
		await run('/arc arc-02 after the-breach');
		await run('/situation new The Ledger Room');
		await refresh();
		await run('/situation sit-002 arc arc-02');
		await run('/situation sit-002 moment the-breach');
		await run('/situation sit-002 place the-atrium');
		await run('/situation sit-002 cast carl');

		const wiki = buildWiki(context.project!);
		const kinds = new Set(wiki.pages.map(page => page.kind));

		expect(kinds).toContain('situation');
		expect(kinds).toContain('arc');
		// The place exists in the wiki *because* a situation names it.
		expect(kinds).toContain('place');

		const page = wiki.pages.find(p => p.kind === 'situation' && p.id === 'sit-002');
		expect(page?.body).toContain('[[arc-02]]');
		expect(page?.body).toContain('[[the-breach]]');
		expect(page?.body).toContain('[[the-atrium]]');
		expect(page?.body).toContain('[[carl]]');

		const index = wiki.pages.find(p => p.kind === 'index');
		expect(index?.body).toContain('Situations (');
	});

	/**
	 * The reported failure: linking a scene to a moment wrote the frontmatter,
	 * and the moment's page never mentioned it. A link the wiki shows from only
	 * one end looks, after a rebuild, exactly like a link that did not happen.
	 */
	it('shows the link from the moment’s end as well as the scene’s', async () => {
		await writeMoment('the-breach', 0);
		await run('/situation new The Ledger Room');
		await refresh();
		await run('/situation sit-002 moment the-breach');
		await run('/situation sit-002 place the-atrium');

		const pages = buildWiki(context.project!).pages;
		const moment = pages.find(p => p.kind === 'moment' && p.id === 'the-breach');

		expect(moment?.body).toContain('Scenes anchored here');
		expect(moment?.body).toContain('[[sit-002|The Ledger Room]]');
		// And where it happens, so the moment page is navigable on its own.
		expect(moment?.body).toContain('[[the-atrium]]');
		// The index says how many, so a moment nothing happens at is visible.
		expect(moment?.summary).toContain('1 scene');
	});

	it('says plainly when nothing happens at a moment', async () => {
		await writeMoment('the-breach', 0);

		const moment = buildWiki(context.project!).pages.find(
			p => p.kind === 'moment' && p.id === 'the-breach',
		);
		expect(moment?.body).toContain('no situation says it happens at this moment');
		expect(moment?.summary).not.toContain('scene');
	});

	it('marks an anchored scene that is still in the inbox', async () => {
		await writeMoment('the-breach', 0);
		await run('/situation new The Ledger Room');
		await refresh();
		await run('/situation sit-002 moment the-breach');

		const moment = buildWiki(context.project!).pages.find(
			p => p.kind === 'moment' && p.id === 'the-breach',
		);
		// It has a moment but no arc, so it contributes nothing to replay yet.
		expect(moment?.body).toContain('unplaced');
	});

	it('stops asking for a moment once the scene has one, arc or no arc', async () => {
		await writeMoment('the-breach', 0);
		await run('/situation new The Ledger Room');
		await refresh();
		await run('/situation sit-002 moment the-breach');

		const page = buildWiki(context.project!).pages.find(
			p => p.kind === 'situation' && p.id === 'sit-002',
		);

		expect(page?.body).toContain('[[the-breach]]');
		expect(page?.body).not.toContain('Give it a moment');
		// Still unplaced, which is a different gap and still worth saying.
		expect(page?.body).toContain('Put it on an arc');
	});

	it('says on the page what is still unlinked, rather than looking finished', async () => {
		await run('/situation new A Bare Scene');
		await refresh();

		const page = buildWiki(context.project!).pages.find(
			p => p.kind === 'situation' && p.id === 'sit-002',
		);
		const body = page?.body ?? '';

		expect(body).toContain('Not linked yet');
		expect(body).toContain('In the order they need doing');
		expect(body).toContain('Put it on an arc');
		expect(body).toContain('Give it a moment');
		expect(body).toContain('Cast it');
		expect(body).toContain('Say where it happens');
	});

	/**
	 * The order is the useful part. An arc comes first because without one the
	 * scene never replays, so fixing anything else changes nothing that reaches
	 * the ledger; place is last because it blocks only its own wiki page.
	 */
	it('lists the gaps in the order they have to be done', async () => {
		await run('/situation new A Bare Scene');
		await refresh();

		const body =
			buildWiki(context.project!).pages.find(
				p => p.kind === 'situation' && p.id === 'sit-002',
			)?.body ?? '';

		const order = [
			'Put it on an arc',
			'Give it a moment',
			'Cast it',
			'Say where it happens',
		];
		const positions = order.map(step => body.indexOf(step));
		expect(positions.every(at => at !== -1)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));

		// Numbered, because it genuinely is a sequence.
		expect(body).toContain('1. **Put it on an arc');
		expect(body).toContain('4. **Say where it happens');
	});

	it('names the prerequisite when the step cannot be run yet', async () => {
		// The scaffold now seeds dated moments (we-001, we-002); remove them so
		// the vault genuinely has none, and the moment step has to send the
		// author to /moment first rather than to a refusal.
		await rm(resolve(root, VAULT.moments, 'we-001.md'), {force: true});
		await rm(resolve(root, VAULT.moments, 'we-002.md'), {force: true});
		await run('/situation new A Bare Scene');
		await refresh();

		const body =
			buildWiki(context.project!).pages.find(
				p => p.kind === 'situation' && p.id === 'sit-002',
			)?.body ?? '';

		expect(body).toContain('No dated moments exist yet');
		expect(body).toContain('/moment new <name>');
	});

	it('flags an arc that has no clock position for its scenes to inherit', async () => {
		// The scaffold's arc-01 is already anchored, so this needs a bare one.
		await run('/arc new The Long Descent');
		await run('/situation new A Bare Scene');
		await refresh();
		await run('/situation sit-002 arc arc-02');

		const body =
			buildWiki(context.project!).pages.find(
				p => p.kind === 'situation' && p.id === 'sit-002',
			)?.body ?? '';

		// Placed, so the arc step is done — but the arc itself is unanchored.
		expect(body).not.toContain('Put it on an arc');
		expect(body).toContain('Anchor its arc to the clock');
		expect(body).toContain('/arc arc-02 after <moment>');
	});

	it('refuses a link to something that does not exist, and says how to make it', async () => {
		await run('/situation new A Scene');
		await refresh();

		expect(said(await run('/situation sit-002 moment nowhere'))).toContain(
			"no moment 'nowhere'",
		);
		const noArc = said(await run('/situation sit-002 arc arc-99'));
		expect(noArc).toContain("no arc 'arc-99'");
		expect(noArc).toContain('/arc new');
	});

	/**
	 * A typo in a cast list used to be silent: the scene named someone, the wiki
	 * linked them, and nothing anywhere said who they were.
	 */
	it('reports a cast member with no character page', async () => {
		await run('/situation new A Scene');
		await refresh();
		await run('/situation sit-002 cast nobody-wrote-them');

		const finding = context.project!.questions.find(
			q => q.kind === 'broken_reference' && q.detail.includes('nobody-wrote-them'),
		);
		expect(finding?.detail).toContain('casts');
		expect(finding?.detail).toContain('no character page');
	});

	it('adds to a cast rather than replacing it', async () => {
		await run('/situation new A Scene');
		await refresh();

		await run('/situation sit-002 cast carl');
		const second = await run('/situation sit-002 cast donut');

		expect(said(second)).toContain('carl');
		expect(said(second)).toContain('donut');
	});

	it('names a place that has no page yet without refusing it', async () => {
		await run('/situation new A Scene');
		await refresh();

		const result = await run('/situation sit-002 place the-undercroft');
		expect(said(result)).toContain('the-undercroft');
		expect(said(result)).toContain('no places/the-undercroft.md yet');
	});

	/**
	 * `/situation new` slugs the title into the filename, so `sit-002` lives in
	 * `sit-002-the-ledger-room.md`. The wiki used to look only for
	 * `situations/sit-002.md`, which meant a scene's prose never appeared on the
	 * one page it most obviously belongs on.
	 */
	it('shows the scene’s own prose on the scene’s own page', async () => {
		const created = await run('/situation new The Ledger Room');
		await refresh();

		const raw = await readFile(created.openEditor!, 'utf8');
		const {data} = parseDocument(raw);
		await writeFile(
			created.openEditor!,
			stringifyDocument({
				data,
				body: '\nShe put the ledger down and did not pick it up.\n',
			}),
			'utf8',
		);
		await refresh();

		const page = buildWiki(context.project!).pages.find(
			p => p.kind === 'situation' && p.id === 'sit-002',
		);
		expect(page?.body).toContain('She put the ledger down');
	});

	it('finds that prose whether the scene is in the inbox or placed on an arc', async () => {
		const created = await run('/situation new The Ledger Room');
		await refresh();
		const {data} = parseDocument(await readFile(created.openEditor!, 'utf8'));
		await writeFile(
			created.openEditor!,
			stringifyDocument({data, body: '\nA line that must survive placement.\n'}),
			'utf8',
		);
		await refresh();

		// Placing moves the file from situations/inbox/ to situations/.
		await run('/situation sit-002 arc arc-01');

		const page = buildWiki(context.project!).pages.find(
			p => p.kind === 'situation' && p.id === 'sit-002',
		);
		expect(page?.body).toContain('A line that must survive placement');
	});

	/**
	 * The failure this whole change is about: one scene existing as two files.
	 * `/situation new` wrote `<id>-<slug>.md` into the inbox while ingest
	 * proposed `<id>.md` beside it, and nothing that looks at names could see
	 * they were the same page.
	 */
	it('writes one file, named for the id', async () => {
		const created = await run('/situation new The Ledger Room');
		expect(created.openEditor).toContain(`${path.sep}situations${path.sep}sit-002.md`);
		expect(created.openEditor).not.toContain('inbox');
	});

	it('does not move the file when it is placed on an arc', async () => {
		const created = await run('/situation new A Scene');
		await refresh();
		await run('/situation sit-002 arc arc-01');

		// The file stays put; `arc:` is what says it is placed.
		await expect(readFile(created.openEditor!, 'utf8')).resolves.toContain('arc: arc-01');
		expect(context.project!.vault.situations.find(s => s.id === 'sit-002')?.arc).toBe(
			'arc-01',
		);
	});

	it('reports a file whose name is not its id', async () => {
		await writeFile(
			resolve(root, VAULT.situations, 'not-the-id.md'),
			'---\nid: sit-900\ntitle: Misfiled\n---\n\nProse.\n',
			'utf8',
		);
		await refresh();

		const finding = context.project!.questions.find(
			q => q.kind === 'file_name_not_id' && q.detail.includes('not-the-id.md'),
		);
		expect(finding?.detail).toContain('not-the-id.md');
		expect(finding?.detail).toContain('sit-900.md');
	});

	it('reports a scene left in the old inbox', async () => {
		await mkdir(resolve(root, VAULT.inbox), {recursive: true});
		await writeFile(
			resolve(root, VAULT.inbox, 'sit-900.md'),
			'---\nid: sit-900\ntitle: Legacy\n---\n\nProse.\n',
			'utf8',
		);
		await refresh();

		const finding = context.project!.questions.find(q => q.kind === 'legacy_location');
		expect(finding?.detail).toContain('situations/inbox/sit-900.md');
		expect(finding?.detail).toContain('already unplaced');
	});

	/**
	 * The same finding, for the files that predate a primitive being a page. Two
	 * homes for one system is the version that actually hurts: every stat on a
	 * sheet resolves against whichever the loader picked.
	 */
	it('reports a superseded layout file, and says what replaces it', async () => {
		await mkdir(resolve(root, VAULT.legacySetting), {recursive: true});
		await writeFile(
			resolve(root, VAULT.stats),
			'---\nstats:\n  - id: grit\n    default: 10\n---\n\nLegacy.\n',
			'utf8',
		);
		await refresh();

		const finding = context
			.project!.questions.filter(q => q.kind === 'legacy_location')
			.find(q => q.detail.includes(VAULT.stats));
		expect(finding?.detail).toContain('systems/<id>.md');
	});

	it('says nothing about a legacy file that is not there', async () => {
		await refresh();

		expect(
			context.project!.questions.filter(q => q.kind === 'legacy_location'),
		).toHaveLength(0);
	});

	it('never rewrites the author body when linking', async () => {
		const created = await run('/situation new A Scene');
		await refresh();
		const before = await readFile(created.openEditor!, 'utf8');
		const body = before.slice(before.lastIndexOf('---') + 3);

		await run('/situation sit-002 cast carl');
		await run('/situation sit-002 place the-atrium');

		const after = await readFile(created.openEditor!, 'utf8');
		expect(after.slice(after.lastIndexOf('---') + 3)).toBe(body);
	});
});

describe('/arc', () => {
	it('lists nothing helpfully when there are no arcs', async () => {
		await rm(resolve(root, VAULT.arcs), {recursive: true, force: true});
		await refresh();

		expect(said(await run('/arc'))).toContain('/arc new');
	});

	it('shows an arc with the situations placed on it', async () => {
		await run('/situation new A Scene');
		await refresh();
		await run('/situation sit-002 arc arc-01');

		const shown = said(await run('/arc arc-01'));
		expect(shown).toContain('sit-002');
	});

	it('sets a replay order', async () => {
		expect(said(await run('/arc arc-01 order 30'))).toContain('order 30');
		expect(context.project!.vault.arcs.find(a => a.id === 'arc-01')?.order).toBe(30);
	});

	it('reports an anchor moment that does not exist', async () => {
		expect(said(await run('/arc arc-01 after nowhere'))).toContain("no moment 'nowhere'");
	});
});

/**
 * `cast` was additive with no inverse, so a name typed wrong — or one that
 * turned out to be a note's filename rather than the character's id — could
 * only be taken out by hand-editing frontmatter the buffer will not touch.
 */
describe('taking someone out of a scene', () => {
	it('removes the name and leaves the rest', async () => {
		await run('/situation sit-001 cast carl donut');

		const output = said(await run('/situation sit-001 uncast donut'));

		expect(output).toContain('carl');
		expect(output).not.toContain('donut');
	});

	it('says so when the name was never in the scene', async () => {
		await run('/situation sit-001 cast carl');

		expect(said(await run('/situation sit-001 uncast nobody'))).toContain(
			"'nobody' was not in this scene",
		);
	});

	it('reports an empty cast rather than an empty list', async () => {
		const only =
			context.project!.vault.situations.find(s => s.id === 'sit-001')?.characters ?? [];
		const output = said(await run(`/situation sit-001 uncast ${only.join(' ')}`));

		expect(output).toContain('has no cast');
	});

	it('asks for a name rather than emptying the scene', async () => {
		expect(said(await run('/situation sit-001 uncast'))).toContain('usage:');
	});
});
