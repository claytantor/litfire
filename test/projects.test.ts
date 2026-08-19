import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {
	displayPath,
	inspectProject,
	projectName,
	readLastProject,
	readRecent,
	rememberProject,
	resolveProjectPath,
	resolveStartup,
	statePath,
} from '../source/vault/projects.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let home = '';
let configHome = '';
let litfireDir = '';
let savedConfig: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(path.join(tmpdir(), 'litfire-proj-'));
	configHome = await mkdtemp(path.join(tmpdir(), 'litfire-cfg-'));
	// Redirected, so a test run never reads or writes the author's real
	// ~/.litfire — these tests record projects, and one of them is this repo.
	litfireDir = path.join(await mkdtemp(path.join(tmpdir(), 'litfire-home-')), '.litfire');
	savedConfig = process.env['XDG_CONFIG_HOME'];
	savedHome = process.env['LITFIRE_HOME'];
	process.env['XDG_CONFIG_HOME'] = configHome;
	process.env['LITFIRE_HOME'] = litfireDir;
});

afterEach(async () => {
	for (const [key, saved] of [
		['XDG_CONFIG_HOME', savedConfig],
		['LITFIRE_HOME', savedHome],
	] as const) {
		if (saved === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved;
		}
	}
	await rm(home, {recursive: true, force: true});
	await rm(configHome, {recursive: true, force: true});
	await rm(path.dirname(litfireDir), {recursive: true, force: true});
});

const contextAt = async (root: string): Promise<CommandContext> => ({
	root,
	project: await computeProject(root),
	activeCharacter: undefined,
	setActiveCharacter: () => {},
	consentFormulas: () => {},
});

async function dispatch(line: string, context: CommandContext) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
}

describe('path resolution', () => {
	it('resolves relative paths against the current project, like cd', () => {
		expect(resolveProjectPath('/a/b', '../c')).toBe('/a/c');
		expect(resolveProjectPath('/a/b', 'sub')).toBe('/a/b/sub');
	});

	it('keeps absolute paths absolute', () => {
		expect(resolveProjectPath('/a/b', '/elsewhere')).toBe('/elsewhere');
	});

	it('expands ~ itself, because the TUI gets no shell', () => {
		expect(resolveProjectPath('/a/b', '~')).toBe(homedir());
		expect(resolveProjectPath('/a/b', '~/novels/x')).toBe(
			path.join(homedir(), 'novels/x'),
		);
	});

	it('an empty path means stay put', () => {
		expect(resolveProjectPath('/a/b', '  ')).toBe('/a/b');
	});

	it('collapses home to ~ for display', () => {
		expect(displayPath(path.join(homedir(), 'novels/x'))).toBe('~/novels/x');
		expect(displayPath('/opt/other')).toBe('/opt/other');
	});

	it('names a project by its directory', () => {
		expect(projectName('/a/b/starfall')).toBe('starfall');
	});
});

describe('inspectProject', () => {
	it('classifies a scaffolded vault', async () => {
		const vault = path.join(home, 'book');
		await scaffoldVault(vault, 'base');
		expect(await inspectProject(vault)).toBe('vault');
	});

	it('still recognises a vault whose cache was deleted', async () => {
		const vault = path.join(home, 'book');
		await scaffoldVault(vault, 'base');
		await rm(path.join(vault, '.litrpg'), {recursive: true, force: true});

		// DoD 11: .litrpg/ is disposable, so system/ is the durable marker.
		expect(await inspectProject(vault)).toBe('vault');
	});

	it('distinguishes empty, missing, and not-a-directory', async () => {
		const empty = path.join(home, 'empty');
		await mkdir(empty, {recursive: true});
		const file = path.join(home, 'a-file');
		await writeFile(file, 'x', 'utf8');

		expect(await inspectProject(path.join(home, 'nope'))).toBe('missing');
		expect(await inspectProject(file)).toBe('not-a-directory');
	});
});

describe('recent projects', () => {
	it('records outside every vault, most recent first', async () => {
		await rememberProject('/a/one');
		await rememberProject('/a/two');

		const recent = await readRecent();
		expect(recent[0]).toBe('/a/two');
		expect(recent[1]).toBe('/a/one');
		// Cross-project state must not live inside a vault someone might share.
		expect(recent.join()).not.toContain('.litrpg');
	});

	it('de-duplicates on revisit rather than growing', async () => {
		await rememberProject('/a/one');
		await rememberProject('/a/two');
		await rememberProject('/a/one');

		expect(await readRecent()).toEqual(['/a/one', '/a/two']);
	});

	it('inherits the pre-~/.litfire recents list instead of forgetting it', async () => {
		const vault = path.join(home, 'book');
		const plain = path.join(home, 'plain');
		await scaffoldVault(vault, 'base');
		await mkdir(plain, {recursive: true});

		await mkdir(path.join(configHome, 'litfire'), {recursive: true});
		await writeFile(
			path.join(configHome, 'litfire', 'recent.json'),
			// The middle entry is gone — the old list recorded every directory
			// litfire was ever started in, temp directories included.
			JSON.stringify({projects: [plain, '/tmp/litfire-tui-deleted', vault]}),
			'utf8',
		);

		expect(await readRecent()).toEqual([plain, vault]);
		// The first *vault*, not merely the first path.
		expect(await readLastProject()).toBe(vault);
	});
});

describe('the last project', () => {
	it('is recorded in ~/.litfire, not in any vault', async () => {
		const vault = path.join(home, 'book');
		await scaffoldVault(vault, 'base');
		await rememberProject(vault);

		expect(statePath()).toBe(path.join(litfireDir, 'state.json'));
		expect(await readLastProject()).toBe(vault);
	});

	it('does not advance for a directory that is not a vault', async () => {
		const vault = path.join(home, 'book');
		await scaffoldVault(vault, 'base');
		await rememberProject(vault);

		// Running litfire in a plain directory — to /init it, or by accident —
		// must not become the thing a bare `litfire` reopens tomorrow.
		const scratch = path.join(home, 'not-a-vault');
		await mkdir(scratch, {recursive: true});
		await rememberProject(scratch);

		expect(await readLastProject()).toBe(vault);
		// It is still worth listing, though: /project offers it as somewhere to go.
		expect(await readRecent()).toContain(scratch);
	});

	it('follows a /project switch', async () => {
		const first = path.join(home, 'first');
		const second = path.join(home, 'second');
		await scaffoldVault(first, 'base');
		await scaffoldVault(second, 'base');

		await rememberProject(first);
		await rememberProject(second);

		expect(await readLastProject()).toBe(second);
	});

	it('survives a corrupt state file rather than failing to start', async () => {
		await mkdir(litfireDir, {recursive: true});
		await writeFile(path.join(litfireDir, 'state.json'), '{not json', 'utf8');

		expect(await readLastProject()).toBeUndefined();
		expect(await readRecent()).toEqual([]);
	});
});

describe('startup resolution', () => {
	it('litfire <path> opens that vault', async () => {
		const vault = path.join(home, 'book');
		await scaffoldVault(vault, 'base');

		expect(await resolveStartup(vault, home)).toEqual({root: vault, mode: 'argument'});
	});

	it('litfire . opens the launch directory even when another is remembered', async () => {
		const remembered = path.join(home, 'remembered');
		const here = path.join(home, 'here');
		await scaffoldVault(remembered, 'base');
		await scaffoldVault(here, 'base');
		await rememberProject(remembered);

		// `.` is how an author says "this directory, not wherever I was last".
		expect(await resolveStartup('.', here)).toEqual({root: here, mode: 'cwd'});
	});

	it('bare litfire reopens the last vault', async () => {
		const remembered = path.join(home, 'remembered');
		const elsewhere = path.join(home, 'elsewhere');
		await scaffoldVault(remembered, 'base');
		await mkdir(elsewhere, {recursive: true});
		await rememberProject(remembered);

		expect(await resolveStartup(undefined, elsewhere)).toEqual({
			root: remembered,
			mode: 'last',
		});
	});

	it('bare litfire falls back to the launch directory with nothing remembered', async () => {
		expect(await resolveStartup(undefined, home)).toEqual({root: home, mode: 'cwd'});
	});

	it('falls back rather than failing when the remembered vault is gone', async () => {
		const vault = path.join(home, 'deleted-later');
		await scaffoldVault(vault, 'base');
		await rememberProject(vault);
		await rm(vault, {recursive: true, force: true});

		expect(await resolveStartup(undefined, home)).toEqual({
			root: home,
			mode: 'stale',
			missing: vault,
		});
	});

	it('does not reopen a remembered path that stopped being a vault', async () => {
		const vault = path.join(home, 'emptied');
		await scaffoldVault(vault, 'base');
		await rememberProject(vault);
		await rm(path.join(vault, 'system'), {recursive: true, force: true});
		await rm(path.join(vault, 'index.md'), {force: true});

		const startup = await resolveStartup(undefined, home);
		expect(startup.mode).toBe('stale');
	});

	it('expands ~ in a path argument, since there may be no shell', async () => {
		const startup = await resolveStartup('~', home);
		expect(startup).toEqual({root: homedir(), mode: 'argument'});
	});

	it('treats an explicit path equal to cwd as cwd', async () => {
		const vault = path.join(home, 'book');
		await scaffoldVault(vault, 'base');

		expect(await resolveStartup(vault, vault)).toEqual({root: vault, mode: 'cwd'});
	});
});

describe('/project', () => {
	it('lists the current project and offers recent ones', async () => {
		const first = path.join(home, 'first');
		const second = path.join(home, 'second');
		await scaffoldVault(first, 'base');
		await scaffoldVault(second, 'base');
		await rememberProject(second);

		const result = await dispatch('/project', await contextAt(first));
		const rendered = result.lines.map(l => l.text).join('\n');

		expect(rendered).toContain(displayPath(first));
		expect(rendered).toContain(displayPath(second));
	});

	it('switches to an existing vault', async () => {
		const from = path.join(home, 'from');
		const to = path.join(home, 'to');
		await scaffoldVault(from, 'base');
		await scaffoldVault(to, 'base');

		const result = await dispatch(`/project ${to}`, await contextAt(from));

		expect(result.switchProject).toBe(to);
	});

	it('resolves a relative path against the current project', async () => {
		const from = path.join(home, 'nested', 'from');
		const to = path.join(home, 'nested', 'to');
		await scaffoldVault(from, 'base');
		await scaffoldVault(to, 'base');

		const result = await dispatch('/project ../to', await contextAt(from));

		expect(result.switchProject).toBe(to);
	});

	it('allows switching to an empty directory and points at /init', async () => {
		const from = path.join(home, 'from');
		const fresh = path.join(home, 'fresh');
		await scaffoldVault(from, 'base');
		await mkdir(fresh, {recursive: true});

		const result = await dispatch(`/project ${fresh}`, await contextAt(from));

		// Starting a new book is exactly this, so it must not be refused.
		expect(result.switchProject).toBe(fresh);
		expect(result.lines.map(l => l.text).join(' ')).toContain('/init');
	});

	it('refuses a path that does not exist', async () => {
		const from = path.join(home, 'from');
		await scaffoldVault(from, 'base');

		const result = await dispatch('/project /definitely/not/here', await contextAt(from));

		expect(result.switchProject).toBeUndefined();
		expect(result.lines[0]?.text).toContain('does not exist');
	});

	it('refuses a file', async () => {
		const from = path.join(home, 'from');
		await scaffoldVault(from, 'base');
		const file = path.join(home, 'notes.txt');
		await writeFile(file, 'x', 'utf8');

		const result = await dispatch(`/project ${file}`, await contextAt(from));

		expect(result.switchProject).toBeUndefined();
		expect(result.lines[0]?.text).toContain('not a directory');
	});

	it('is a no-op when already there', async () => {
		const from = path.join(home, 'from');
		await scaffoldVault(from, 'base');

		const result = await dispatch(`/project ${from}`, await contextAt(from));

		expect(result.switchProject).toBeUndefined();
		expect(result.lines[0]?.text).toContain('already in');
	});
});

describe('/init with a target path', () => {
	it('scaffolds elsewhere and switches there', async () => {
		const from = path.join(home, 'from');
		await scaffoldVault(from, 'base');
		const target = path.join(home, 'starfall');

		const result = await dispatch(`/init technological ${target}`, await contextAt(from));

		expect(result.switchProject).toBe(target);
		expect(await inspectProject(target)).toBe('vault');
	});

	it('accepts the path before the idiom too', async () => {
		const from = path.join(home, 'from');
		await scaffoldVault(from, 'base');
		const target = path.join(home, 'either-order');

		const result = await dispatch(`/init ${target} arcane`, await contextAt(from));

		expect(result.switchProject).toBe(target);
	});

	it('scaffolds in place and does not switch when given no path', async () => {
		const here = path.join(home, 'here');
		await mkdir(here, {recursive: true});

		const result = await dispatch('/init base', await contextAt(here));

		expect(result.switchProject).toBeUndefined();
		expect(await inspectProject(here)).toBe('vault');
	});

	it('carries the path into the ask when only a path is given', async () => {
		const here = path.join(home, 'here');
		await mkdir(here, {recursive: true});

		const result = await dispatch('/init ../elsewhere', await contextAt(here));

		const rendered = result.lines.map(l => l.text).join('\n');
		// The ask must offer runnable commands, not lose the path.
		expect(rendered).toContain('/init base ../elsewhere');
		expect(rendered).toContain('/init technological ../elsewhere');
		expect(result.switchProject).toBeUndefined();
	});
});

describe('vault detection is not fooled by a bare cache directory', () => {
	it('does not call a directory a vault just because .litrpg exists', async () => {
		// `/provider` and interview metrics both create `.litrpg/` as a side
		// effect, so it appears in directories litfire was merely run in.
		const ran = path.join(home, 'just-ran-here');
		await mkdir(path.join(ran, '.litrpg'), {recursive: true});
		await writeFile(path.join(ran, '.litrpg', 'config.json'), '{}', 'utf8');

		expect(await inspectProject(ran)).toBe('empty');
	});

	it('still recognises a real vault by system/ and index.md', async () => {
		const vault = path.join(home, 'real');
		await scaffoldVault(vault, 'base');
		await rm(path.join(vault, '.litrpg'), {recursive: true, force: true});

		expect(await inspectProject(vault)).toBe('vault');
	});
});
