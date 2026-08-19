import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {parseDocument, stringifyDocument} from '../source/vault/frontmatter.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-situation-'));
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

async function dispatch(line: string, using: CommandContext = context) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	const command = findCommand(head.replace(/^\//, ''));
	if (!command) {
		throw new Error(`no command for ${line}`);
	}
	return command.run(args, using);
}

const said = (result: {lines: readonly {text: string}[]}) =>
	result.lines.map(line => line.text).join('\n');

describe('writing a situation', () => {
	it('opens the new scene in the buffer instead of shelling out', async () => {
		const result = await dispatch('/situation new The Ledger Room');

		expect(result.openEditor).toBeDefined();
		expect(result.openEditor?.endsWith('.md')).toBe(true);
		// The file exists before the buffer opens on it.
		await expect(readFile(result.openEditor!, 'utf8')).resolves.toContain('id:');
		expect(said(result)).toContain('created');
	});

	it('says nothing about $EDITOR any more', async () => {
		const result = await dispatch('/situation new A Scene');

		expect(said(result)).not.toContain('EDITOR');
		expect(said(result)).not.toContain('opened in');
	});

	it('reopens an existing scene by id', async () => {
		const created = await dispatch('/situation new A Scene');
		const id = parseDocument(await readFile(created.openEditor!, 'utf8')).data['id'];

		const reopened = await dispatch(`/situation edit ${String(id)}`);
		expect(reopened.openEditor).toBe(created.openEditor);
	});

	it('reports an id it cannot find rather than opening an empty buffer', async () => {
		const result = await dispatch('/situation edit sit-999');

		expect(result.openEditor).toBeUndefined();
		expect(said(result)).toContain("no file for situation 'sit-999'");
	});

	it('asks for an id when none is given', async () => {
		expect(said(await dispatch('/situation edit'))).toContain('usage:');
	});
});

/**
 * The buffer edits the body and nothing else. Frontmatter is what `/situation
 * place`, extraction and the ledger maintain; prose is the author's alone (P6).
 * App does the write, so this asserts the shape it relies on.
 */
describe('saving a scene', () => {
	it('replaces the body and leaves the frontmatter meaning unchanged', async () => {
		const created = await dispatch('/situation new A Scene');
		const file = created.openEditor!;
		const {data} = parseDocument(await readFile(file, 'utf8'));

		const written = stringifyDocument({data, body: '\nShe put the ledger down.\n'});
		const reparsed = parseDocument(written);

		expect(reparsed.body).toContain('She put the ledger down.');
		expect(reparsed.body).not.toContain('Write the scene here');
		expect(reparsed.data).toEqual(data);
	});

	it('keeps the situation loadable after a body-only rewrite', async () => {
		const created = await dispatch('/situation new A Scene');
		const file = created.openEditor!;
		const {data} = parseDocument(await readFile(file, 'utf8'));

		const {writeFile} = await import('node:fs/promises');
		await writeFile(file, stringifyDocument({data, body: '\nProse.\n'}), 'utf8');

		const project = await computeProject(root);
		expect(project.vault.issues).toHaveLength(0);
		expect(project.vault.situations.some(s => s.id === data['id'])).toBe(true);
	});
});
