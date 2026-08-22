import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {buildStatsGeneration} from '../source/system/generate.js';
import {saveProvider} from '../source/vault/config.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-generate-'));
	await scaffoldVault(root, 'arcane');
	await saveProvider(root, {id: 'openai', model: 'gpt-4o'});
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function file(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), {recursive: true});
	await writeFile(target, contents, 'utf8');
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

async function refresh() {
	context = {
		root,
		project: await computeProject(root),
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	};
}

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
}

/** One system, with a drawn screen and a note behind it. */
async function drawnSystem() {
	await rm(path.join(root, VAULT.systems, 'system-01.md'), {force: true});
	await rm(path.join(root, 'raw/systems/system-01.md'), {force: true});
	await file(
		`${VAULT.systems}/lathe.md`,
		[
			'---',
			'id: lathe',
			'name: The Lathe',
			'---',
			'',
			'It counts what it can see.',
			'',
			'```interface',
			'│ {name}  TIER {level} │',
			'│ COHERENCE {coherence}/10 │',
			'```',
			'',
		].join('\n'),
	);
	await file('raw/systems/lathe.md', 'The Lathe counts what it can see.\n');
	await refresh();
}

describe('what the pass is given', () => {
	it('leads with the screen, because that is the specification', async () => {
		await drawnSystem();
		const {context: given} = await buildStatsGeneration(
			root,
			context.project!,
			context.project!.vault.systems[0]!,
		);

		expect(given).toContain('The screen it draws');
		expect(given.indexOf('The screen it draws')).toBeLessThan(
			given.indexOf('Stats it already declares'),
		);
		expect(given).toContain('COHERENCE {coherence}/10');
	});

	it('proposes into the raw note, not the derived page', async () => {
		await drawnSystem();
		const {note, context: given} = await buildStatsGeneration(
			root,
			context.project!,
			context.project!.vault.systems[0]!,
		);

		// A formula written to the corpus page would be dropped by the next
		// /ingest system, because the page is rebuilt from the note.
		expect(note).toBe('raw/systems/lathe.md');
		expect(given).toContain('raw/systems/lathe.md');
		expect(given).toContain('The Lathe counts what it can see.');
	});

	it('says plainly when there is no screen to work from', async () => {
		await file(`${VAULT.systems}/bare.md`, '---\nid: bare\n---\n\nSome prose.\n');
		await rm(path.join(root, VAULT.systems, 'lathe.md'), {force: true});
		await rm(path.join(root, VAULT.systems, 'system-01.md'), {force: true});
		await refresh();

		const {context: given} = await buildStatsGeneration(
			root,
			context.project!,
			context.project!.vault.systems.find(s => s.id === 'bare')!,
		);

		expect(given).toContain('draws no status screen');
		expect(given).toContain('drawn interface would settle it');
	});
});

describe('what the instruction forbids', () => {
	/**
	 * The whole reason this pass is allowed to exist. Nobody can read an
	 * expression and tell whether it is right for their book; they can read a
	 * table of what it does and say whether a level-20 character having that
	 * much is absurd.
	 */
	it('requires a worked table with every formula', async () => {
		await drawnSystem();
		const {instruction} = await buildStatsGeneration(
			root,
			context.project!,
			context.project!.vault.systems[0]!,
		);

		expect(instruction).toContain('worked table');
		expect(instruction).toContain('This is not optional');
		expect(instruction).toContain('The author cannot check an expression');
	});

	it('forbids inventing a stat, a bound, or an event', async () => {
		await drawnSystem();
		const {instruction} = await buildStatsGeneration(
			root,
			context.project!,
			context.project!.vault.systems[0]!,
		);

		expect(instruction).toContain('Do not invent a stat the screen does not draw');
		expect(instruction).toContain('Do not invent a bound');
		// What happens in a scene is the story, and not the tool's to write.
		expect(instruction).toContain('Do not propose ledger events');
	});

	it('warns about the kebab-case trap it would otherwise walk into', async () => {
		await drawnSystem();
		const {instruction} = await buildStatsGeneration(
			root,
			context.project!,
			context.project!.vault.systems[0]!,
		);

		expect(instruction).toContain('({max-hp}) =>` is a syntax error');
	});
});

describe('/system generate stats', () => {
	it('names the system it will work on', async () => {
		await drawnSystem();
		const result = await run('/system lathe generate stats');

		expect(result.generateStats?.system).toBe('lathe');
		expect(said(result)).toContain('the screen it draws');
	});

	it('takes the only system without being told', async () => {
		await drawnSystem();
		expect((await run('/system generate stats')).generateStats?.system).toBe('lathe');
	});

	it('refuses to guess between two', async () => {
		await drawnSystem();
		await file(`${VAULT.systems}/mesh.md`, '---\nid: mesh\n---\n\nOther.\n');
		await refresh();

		const output = said(await run('/system generate stats'));
		expect(output).toContain('2 systems — name one');
		expect(output).toContain('/system lathe generate stats');
	});

	it('says a screen would make it precise when there is none', async () => {
		await file(`${VAULT.systems}/bare.md`, '---\nid: bare\n---\n\nProse.\n');
		await rm(path.join(root, VAULT.systems, 'system-01.md'), {force: true});
		await refresh();

		const output = said(await run('/system bare generate stats'));
		expect(output).toContain('draws no status screen');
		expect(output).toContain('interface');
	});

	it('needs a provider, and refuses before spending anything', async () => {
		await drawnSystem();
		await writeFile(
			path.join(root, VAULT.config),
			JSON.stringify({version: 1, provider: {}}, null, 2),
			'utf8',
		);
		await refresh();

		const result = await run('/system lathe generate stats');
		expect(result.generateStats).toBeUndefined();
		expect(said(result)).toContain('/provider');
	});

	it('still renders the view when not generating', async () => {
		await drawnSystem();
		expect(said(await run('/system lathe'))).toContain('The Lathe');
	});
});
