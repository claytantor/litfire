import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {loadSetting, term} from '../source/genre/index.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-idiom-'));
	// Arcane rather than base: an inherited term has to exist for `unset` to fall
	// back to, and `base` supplies none.
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

/** Dispatches the way App does: split the line, strip the slash, look it up. */
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

describe('/idiom set', () => {
	it('overrides a term and reports what it replaced', async () => {
		const result = await dispatch('/idiom set resource essence');

		expect(said(result)).toContain('resource  mana → essence');
		expect(result.dirty).toBe(true);

		const {profile, overridden} = await loadSetting(root);
		expect(term(profile, 'resource')).toBe('essence');
		expect(overridden).toBe(true);
	});

	it('leaves every term it did not touch inheriting from the profile', async () => {
		await dispatch('/idiom set resource essence');

		const {profile} = await loadSetting(root);
		expect(term(profile, 'space')).toBe('dungeon');
		expect(term(profile, 'ability')).toBe('spell');
	});

	it('accepts a multi-word term', async () => {
		await dispatch('/idiom set ability_group spell school');

		const {profile} = await loadSetting(root);
		expect(term(profile, 'ability_group')).toBe('spell school');
	});

	it('accumulates rather than replacing the previous override', async () => {
		await dispatch('/idiom set resource essence');
		await dispatch('/idiom set threat horror');

		const {profile} = await loadSetting(root);
		expect(term(profile, 'resource')).toBe('essence');
		expect(term(profile, 'threat')).toBe('horror');
	});

	/** P6: the override file has a prose body the author may have written in. */
	it('preserves the prose body of the override file', async () => {
		await dispatch('/idiom set resource essence');

		const raw = await readFile(resolve(root, VAULT.idiom), 'utf8');
		expect(raw).toContain('# Idiom override');
		expect(raw).toContain('lexicon:');
	});

	it('refuses a key that is not in the lexicon, and writes nothing', async () => {
		const before = await readFile(resolve(root, VAULT.idiom), 'utf8');
		const result = await dispatch('/idiom set vibes ominous');

		expect(said(result)).toContain("'vibes' is not a lexicon key");
		expect(said(result)).toContain('resource');
		expect(await readFile(resolve(root, VAULT.idiom), 'utf8')).toBe(before);
	});

	it('refuses a key with no term', async () => {
		const result = await dispatch('/idiom set resource');
		expect(said(result)).toContain('usage: /idiom set resource <term>');
	});

	it('refuses to write without a vault', async () => {
		const result = await dispatch('/idiom set resource essence', {
			...context,
			project: undefined,
		});
		expect(said(result)).toContain('no vault loaded here');
	});
});

describe('/idiom unset', () => {
	it('falls back to the inherited term', async () => {
		await dispatch('/idiom set resource essence');
		const result = await dispatch('/idiom unset resource');

		expect(said(result)).toContain('resource  essence → mana');

		const {profile} = await loadSetting(root);
		expect(term(profile, 'resource')).toBe('mana');
	});

	/**
	 * `loadSetting` treats the presence of a `lexicon` key as a declaration, so
	 * clearing the last term has to remove the key rather than leave `{}` — or the
	 * vault stays pinned to an `arcane-local` profile that overrides nothing.
	 */
	it('stops overriding once the last term is cleared', async () => {
		await dispatch('/idiom set resource essence');
		await dispatch('/idiom set threat horror');

		expect((await loadSetting(root)).overridden).toBe(true);

		await dispatch('/idiom unset resource');
		expect((await loadSetting(root)).overridden).toBe(true);

		await dispatch('/idiom unset threat');
		const {profile, overridden} = await loadSetting(root);
		expect(overridden).toBe(false);
		expect(profile.id).toBe('arcane');
	});

	it('is harmless on a term that was never overridden', async () => {
		const result = await dispatch('/idiom unset currency');

		expect(said(result)).toContain('currency  gold → gold');
		expect((await loadSetting(root)).overridden).toBe(false);
	});
});

describe('bare /idiom', () => {
	it('still shows the profile and now points at the editing commands', async () => {
		const result = await dispatch('/idiom');
		const output = said(result);

		expect(output).toContain('Arcane / Fantasy');
		expect(output).toContain('/idiom set <key> <term>');
	});

	it('rejects an unknown subcommand rather than treating it as a key', async () => {
		const result = await dispatch('/idiom resource essence');
		expect(said(result)).toContain('usage: /idiom');
	});
});
