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
	root = await mkdtemp(path.join(tmpdir(), 'litfire-reviewercmd-'));
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

describe('/reviewer', () => {
	it('asks App to open the reviewer rather than printing output', async () => {
		const result = await dispatch('/reviewer');

		expect(result.reviewer).toBe(true);
		expect(result.lines).toHaveLength(0);
	});

	/**
	 * The provider is resolved where the screen opens, not here — but a vault has
	 * to exist first, because the reviewer's whole premise is having read one.
	 */
	it('refuses without a vault', async () => {
		const result = await dispatch('/reviewer', {...context, project: undefined});

		expect(result.reviewer).toBeUndefined();
		expect(said(result)).toContain('no vault loaded here');
	});

	it('is listed in /help', async () => {
		expect(said(await dispatch('/help'))).toContain('/reviewer');
	});

	it('is registered exactly once', () => {
		expect(commands.filter(command => command.name === 'reviewer')).toHaveLength(1);
	});

	/**
	 * The rename this file is named for. `$EDITOR` is the program the author
	 * writes situations in; the reviewer is the agent that reads the rendered
	 * corpus. One word used to mean both, and `/editor` was the ambiguous half.
	 */
	it('leaves no /editor command behind to mean the other thing', () => {
		expect(commands.some(command => command.name === 'editor')).toBe(false);
	});

	it('is a different thing from the situation editor $EDITOR opens', async () => {
		expect(findCommand('reviewer')?.summary).toContain('literary editor');
		expect(findCommand('situation')?.usage).toContain('new');
	});
});
