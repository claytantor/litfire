import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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

	it('says on the page what is still unlinked, rather than looking finished', async () => {
		await run('/situation new A Bare Scene');
		await refresh();

		const page = buildWiki(context.project!).pages.find(
			p => p.kind === 'situation' && p.id === 'sit-002',
		);

		expect(page?.body).toContain('Not linked yet');
		expect(page?.body).toContain('No arc');
		expect(page?.body).toContain('No moment');
		expect(page?.body).toContain('No place');
		expect(page?.body).toContain('Nobody in it');
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
