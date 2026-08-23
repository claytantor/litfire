import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {saveProvider} from '../source/vault/config.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-founding-'));
	context = {
		root,
		project: undefined,
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	};
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

const run = async (line: string) => {
	const [head = '', ...args] = line.trim().split(/\s+/);
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
};

describe('/init offers the founding interview', () => {
	it('offers it when a provider is configured', async () => {
		await scaffoldVault(root, 'arcane');
		await saveProvider(root, {id: 'openai', model: 'gpt-4o'});

		const result = await run('/init arcane');

		expect(result.confirm?.question).toBe('interview you about this world now?');
		expect(result.confirm?.proceed.interview?.kind).toBe('system');
	});

	/**
	 * `/init` is the one command that has to work with no provider, no key and
	 * no network: it is how a vault is made offline, how a throwaway one is made
	 * to try something, and how every fixture in this suite is built.
	 */
	it('scaffolds without one, and says what to do about it', async () => {
		const result = await run('/init arcane');

		expect(result.confirm).toBeUndefined();
		expect(said(result)).toContain('what is here is scaffolding');
		expect(said(result)).toContain('/questions system');
	});

	it('leaves a vault behind either way', async () => {
		await run('/init arcane');
		const project = await computeProject(root);

		expect(project.vault.systems.length).toBeGreaterThan(0);
		expect(project.vault.issues).toEqual([]);
	});

	it('declining says the scaffolding is kept', async () => {
		await scaffoldVault(root, 'arcane');
		await saveProvider(root, {id: 'openai', model: 'gpt-4o'});

		expect((await run('/init arcane')).confirm?.declined).toContain('scaffolding kept');
	});
});

describe('a vault that is still scaffolding says so', () => {
	it('reports the pages /init wrote, once', async () => {
		await scaffoldVault(root, 'arcane');
		const project = await computeProject(root);
		const found = project.questions.filter(q => q.kind === 'scaffold_unreplaced');

		expect(found).toHaveLength(1);
		expect(found[0]?.detail).toContain('/questions system');
	});

	it('stops saying it as the pages are replaced', async () => {
		await scaffoldVault(root, 'arcane');
		// Rewrite every scaffolded page without the flag.
		for (const [dir, id] of [
			[VAULT.systems, 'system-01'],
			[VAULT.characters, 'protagonist'],
			[VAULT.moments, 'we-001'],
			[VAULT.moments, 'we-002'],
			[VAULT.arcs, 'arc-00'],
			[VAULT.arcs, 'arc-01'],
			[VAULT.situations, 'sit-001'],
			[VAULT.themes, 'commodification'],
			[VAULT.chapters, 'ch-01'],
		] as const) {
			await writeFile(
				path.join(root, dir, `${id}.md`),
				`---\nid: ${id}\n---\n\nMine now.\n`,
				'utf8',
			);
		}

		const project = await computeProject(root);
		expect(project.questions.filter(q => q.kind === 'scaffold_unreplaced')).toEqual([]);
	});
});

describe('the prologue arc', () => {
	it('is seeded, ordered first, and anchored to nothing', async () => {
		await scaffoldVault(root, 'arcane');
		const project = await computeProject(root);
		const prologue = project.vault.arcs.find(arc => arc.id === 'arc-00');

		expect(prologue?.order).toBe(0);
		// The whole point: it waits for the earliest moment its own scenes claim.
		expect(prologue?.starts_after).toBeUndefined();
	});
});

describe('where interviews land', () => {
	/**
	 * Not a primitive folder — a transcript is a source that touches several
	 * kinds at once — but a real place things are written, and `/init` never
	 * made it. Its absence was indistinguishable from being in the wrong vault.
	 */
	it('exists from the first scaffold', async () => {
		await scaffoldVault(root, 'arcane');
		const {readdir} = await import('node:fs/promises');

		await expect(readdir(path.join(root, VAULT.raw, 'interviews'))).resolves.toEqual([]);
	});
});
