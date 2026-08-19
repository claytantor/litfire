import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {stringifyDocument} from '../source/vault/frontmatter.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

const write = async (relative: string, data: Record<string, unknown>, body = '\n') => {
	const file = resolve(root, relative);
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, stringifyDocument({data, body}), 'utf8');
};

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-status-'));
	await scaffoldVault(root, 'arcane');

	await write(path.join(VAULT.characters, 'carl.md'), {id: 'carl', level: 1, xp: 0});
	await write(path.join(VAULT.arcs, 'arc-90.md'), {id: 'arc-90', order: 99});

	// Two placed situations that move the same stat, so a snapshot lookup and a
	// current-state lookup give provably different answers.
	await write(
		path.join(VAULT.situations, 'sit-901.md'),
		{
			id: 'sit-901',
			arc: 'arc-90',
			order: 10,
			events: [
				{type: 'stat', actor: 'carl', stat: 'mana', value: 40},
				{type: 'acquire_skill', actor: 'carl', skill: 'ember-bolt'},
			],
		},
		'\nCarl opens the door.\n',
	);
	await write(path.join(VAULT.situations, 'sit-902.md'), {
		id: 'sit-902',
		arc: 'arc-90',
		order: 20,
		events: [{type: 'stat', actor: 'carl', stat: 'mana', value: 10}],
	});
	await write(path.join(VAULT.inbox, 'sit-903.md'), {id: 'sit-903'});

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

describe('/status renders', () => {
	it('uses the profile template and its vocabulary', async () => {
		const output = said(await dispatch('/status carl'));

		expect(output).toContain('sheet template, from Arcane / Fantasy');
		expect(output).toContain('level 1');
		expect(output).toContain('school: ember-bolt');
	});

	it('renders the state at a given step rather than the latest', async () => {
		expect(said(await dispatch('/status carl sit-901'))).toContain('| mana | 40 |');
		expect(said(await dispatch('/status carl sit-902'))).toContain('| mana | 10 |');
	});

	it('refuses a character the ledger does not know', async () => {
		expect(said(await dispatch('/status donut'))).toContain("no character 'donut'");
	});

	it('refuses a step that is not in the sequence', async () => {
		expect(said(await dispatch('/status carl sit-999'))).toContain("no step 'sit-999'");
	});
});

describe('/status write', () => {
	const fileFor = (id: string) => resolve(root, VAULT.situations, `${id}.md`);

	it('places a marked block and leaves the prose alone', async () => {
		const result = await dispatch('/status write carl sit-901');
		expect(said(result)).toContain('sheet block →');
		expect(result.dirty).toBe(true);

		const raw = await readFile(fileFor('sit-901'), 'utf8');
		expect(raw).toContain('<!-- litrpg:status char=carl at=sit-901 -->');
		expect(raw).toContain('<!-- /litrpg:status -->');
		expect(raw).toContain('Carl opens the door.');
	});

	/**
	 * The whole reason the write path uses a snapshot: a status screen in an early
	 * scene showing end-of-book numbers is the contradiction this tool exists to
	 * catch, not to introduce.
	 */
	it('writes the state as of that situation, not the latest state', async () => {
		await dispatch('/status write carl sit-901');

		const raw = await readFile(fileFor('sit-901'), 'utf8');
		expect(raw).toContain('| mana | 40 |');
		expect(raw).not.toContain('| mana | 10 |');
	});

	it('replaces the block on a second write rather than stacking them', async () => {
		await dispatch('/status write carl sit-901');
		await dispatch('/status write carl sit-901');

		const raw = await readFile(fileFor('sit-901'), 'utf8');
		expect(raw.match(/<!-- litrpg:status/g)).toHaveLength(1);
	});

	it('refuses an unplaced situation, which has no point in time', async () => {
		const output = said(await dispatch('/status write carl sit-903'));

		expect(output).toContain("'sit-903' has no state in the replay sequence");
		expect(output).toContain('/situation <id> arc');
	});

	it('refuses a situation that does not exist', async () => {
		expect(said(await dispatch('/status write carl nope'))).toContain(
			"'nope' has no state",
		);
	});

	it('reports its usage when an argument is missing', async () => {
		expect(said(await dispatch('/status write carl'))).toContain(
			'usage: /status write <character> <situation>',
		);
	});
});
