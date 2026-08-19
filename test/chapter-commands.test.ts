import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {parseDocument, stringifyDocument} from '../source/vault/frontmatter.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

const put = async (relative: string, data: Record<string, unknown>, body = '\n') => {
	const file = resolve(root, relative);
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, stringifyDocument({data, body}), 'utf8');
};

const refresh = async () => {
	context = {...context, project: await computeProject(root)};
};

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-chapter-'));
	await scaffoldVault(root, 'arcane');

	// The scaffold seeds an example chapter. Removed here so chapter numbering and
	// generated ids depend on this fixture alone, not on how many placeholders
	// `/init` happens to ship.
	await rm(resolve(root, VAULT.chapters, 'ch-01.md'), {force: true});

	await put(path.join(VAULT.arcs, 'arc-90.md'), {id: 'arc-90', order: 99});
	await put(
		path.join(VAULT.situations, 'sit-901.md'),
		{id: 'sit-901', title: 'The Door', arc: 'arc-90', order: 10},
		'\nCarl opened the door.\n',
	);
	await put(
		path.join(VAULT.situations, 'sit-902.md'),
		{id: 'sit-902', title: 'The Ledger', arc: 'arc-90', order: 20},
		'\nThe ledger was open.\n',
	);
	await put(path.join(VAULT.inbox, 'sit-903.md'), {id: 'sit-903', title: 'Loose'});

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

async function dispatch(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	const command = findCommand(head.replace(/^\//, ''));
	if (!command) {
		throw new Error(`no command for ${line}`);
	}
	return command.run(args, context);
}

const said = (result: {lines: readonly {text: string}[]}) =>
	result.lines.map(line => line.text).join('\n');

describe('/chapter new', () => {
	it('cuts the sequence at a placed situation', async () => {
		const result = await dispatch('/chapter new sit-901 The Ledger Room');

		expect(said(result)).toContain('opening on sit-901');
		expect(result.dirty).toBe(true);

		const raw = await readFile(resolve(root, VAULT.chapters, 'ch-001.md'), 'utf8');
		const {data} = parseDocument(raw);
		expect(data['starts_at']).toBe('sit-901');
		expect(data['title']).toBe('The Ledger Room');
	});

	/** A chapter opening on an unplaced scene would claim nothing at all. */
	it('refuses an unplaced situation and says why', async () => {
		const output = said(await dispatch('/chapter new sit-903'));

		expect(output).toContain('not in the replay sequence');
		expect(output).toContain('/situation <id> arc');
	});

	it('refuses a situation that does not exist', async () => {
		expect(said(await dispatch('/chapter new sit-999'))).toContain(
			'no situation by that id',
		);
	});

	it('refuses a second chapter on the same scene', async () => {
		await dispatch('/chapter new sit-901');
		await refresh();

		expect(said(await dispatch('/chapter new sit-901'))).toContain('already opens on');
	});
});

describe('/chapter move', () => {
	it('moves the cut and leaves the connective text alone', async () => {
		await dispatch('/chapter new sit-901 Opening');
		await refresh();

		const file = resolve(root, VAULT.chapters, 'ch-001.md');
		const before = parseDocument(await readFile(file, 'utf8')).body;

		expect(said(await dispatch('/chapter move ch-001 sit-902'))).toContain(
			'now opens on sit-902',
		);

		const after = parseDocument(await readFile(file, 'utf8'));
		expect(after.data['starts_at']).toBe('sit-902');
		expect(after.body).toBe(before);
	});

	it('reports a chapter it cannot find', async () => {
		expect(said(await dispatch('/chapter move ch-999 sit-901'))).toContain(
			'no chapter file',
		);
	});
});

describe('/export', () => {
	it('refuses with nothing to assemble', async () => {
		// The scaffold ships one example chapter, so remove it to get an empty vault.
		await rm(resolve(root, VAULT.chapters), {recursive: true, force: true});
		await mkdir(resolve(root, VAULT.chapters), {recursive: true});
		await refresh();

		expect(said(await dispatch('/export'))).toContain('no chapters to assemble');
	});

	it('assembles the manuscript with the scene prose in order', async () => {
		await dispatch('/chapter new sit-901 The Ledger Room');
		await refresh();

		const result = await dispatch('/export');
		expect(said(result)).toContain('→ manuscript.md');

		const manuscript = await readFile(resolve(root, VAULT.manuscript), 'utf8');
		expect(manuscript).toContain('## 1. The Ledger Room');
		expect(manuscript).toContain('Carl opened the door.');
		expect(manuscript.indexOf('Carl opened the door.')).toBeLessThan(
			manuscript.indexOf('The ledger was open.'),
		);
	});

	/**
	 * The destructive typo this guard exists for: a scene file is the only copy
	 * of that prose, and export would replace it with a manuscript containing it.
	 */
	it('refuses to write over source', async () => {
		await dispatch('/chapter new sit-901');
		await refresh();

		const output = said(await dispatch('/export situations/sit-901.md'));
		expect(output).toContain('that is source, not output');

		const scene = await readFile(resolve(root, VAULT.situations, 'sit-901.md'), 'utf8');
		expect(scene).toContain('Carl opened the door.');
	});

	it('accepts a path outside the corpus', async () => {
		await dispatch('/chapter new sit-901');
		await refresh();

		expect(said(await dispatch('/export draft.md'))).toContain('→ draft.md');
		expect(await readFile(resolve(root, 'draft.md'), 'utf8')).toContain('Carl opened');
	});
});
