import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {commands, findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-editorcmd-'));
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

describe('/editor', () => {
	it('asks App to open the editor rather than printing output', async () => {
		const result = await dispatch('/editor');

		expect(result.editor).toBe(true);
		expect(result.lines).toHaveLength(0);
	});

	/**
	 * The provider is resolved where the screen opens, not here — but a vault has
	 * to exist first, because the editor's whole premise is having read one.
	 */
	it('refuses without a vault', async () => {
		const result = await dispatch('/editor', {...context, project: undefined});

		expect(result.editor).toBeUndefined();
		expect(said(result)).toContain('no vault loaded here');
	});

	it('is listed in /help', async () => {
		expect(said(await dispatch('/help'))).toContain('/editor');
	});

	it('is registered exactly once', () => {
		expect(commands.filter(command => command.name === 'editor')).toHaveLength(1);
	});

	it('does not shadow the situation editor path', async () => {
		// `/situation new` still shells out to $EDITOR; `/editor` is a different
		// thing entirely, and the two must not have collided in the registry.
		expect(findCommand('editor')?.summary).toContain('literary editor');
		expect(findCommand('situation')?.usage).toContain('new');
	});
});
