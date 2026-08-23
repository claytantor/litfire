import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {parseDocument} from '../source/vault/frontmatter.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-start-'));
	await scaffoldVault(root, 'arcane');
	await refresh();
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function refresh() {
	context = {
		root,
		project: await computeProject(root),
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	};
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	const result = await findCommand(head.replace(/^\//, ''))!.run(args, context);
	if (result.dirty) {
		await refresh();
	}
	return result;
}

const note = async () =>
	parseDocument(await readFile(path.join(root, 'raw/characters/protagonist.md'), 'utf8'))
		.data;

/**
 * Replay seeds each stat from the character's own page, falling back to the
 * system's default — so without either, every sheet in the book opens on zero.
 * That is how a vault ends up with a status screen that is real and blank.
 */
describe('where a character starts', () => {
	it('sets a starting stat on the author’s own note', async () => {
		const result = await run('/character protagonist stat strength 14');

		expect(said(result)).toContain('starts with strength 14');
		expect((await note())['stats']).toMatchObject({strength: 14});
	});

	it('reaches replay as the value the story begins from', async () => {
		await run('/character protagonist stat strength 14');

		expect(
			context.project!.replay.state.characters['protagonist']?.stats['strength'],
		).toBe(14);
	});

	/**
	 * `setAuthored` patches frontmatter shallowly, so a stat map passed whole
	 * would drop every other stat the author had set.
	 */
	it('keeps the stats already set', async () => {
		await run('/character protagonist stat strength 14');
		await run('/character protagonist stat charisma 9');

		expect(await note()).toMatchObject({stats: {strength: 14, charisma: 9}});
	});

	it('sets a starting level', async () => {
		await run('/character protagonist level 3');

		expect(context.project!.replay.state.characters['protagonist']?.level).toBe(3);
	});

	it('refuses a value that is not a number', async () => {
		expect(said(await run('/character protagonist stat strength lots'))).toContain(
			"'lots' is not a number",
		);
	});

	it('asks for both parts rather than guessing one', async () => {
		expect(said(await run('/character protagonist stat strength'))).toContain('usage:');
	});
});

describe('/character edit', () => {
	it('opens the author’s note, like every other kind', async () => {
		const result = await run('/character protagonist edit');
		expect(result.openEditor).toContain(path.join('raw', 'characters', 'protagonist.md'));
	});
});

describe('the view still works', () => {
	it('renders when no verb is given', async () => {
		expect(said(await run('/character protagonist'))).toContain('protagonist');
	});

	it('still tolerates show', async () => {
		expect(said(await run('/character protagonist show'))).toContain('protagonist');
	});
});
