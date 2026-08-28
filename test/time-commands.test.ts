import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {parseDocument} from '../source/vault/frontmatter.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

const build = async () => {
	context = {
		root,
		project: await computeProject(root),
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	};
};

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-time-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	const result = await findCommand(head.replace(/^\//, ''))!.run(args, context);
	if (result.dirty) {
		context = {...context, project: await computeProject(root)};
	}
	return result;
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

const binding = async () =>
	parseDocument(await readFile(resolve(root, VAULT.time), 'utf8')).data;

describe('/time at, in a named zone', () => {
	beforeEach(async () => {
		await scaffoldVault(root, 'technological');
		await build();
		await run('/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles');
	});

	it('reads a trailing zone without touching the binding', async () => {
		const utc = await run('/time at 2031-02-13 09:26:11 Etc/UTC');
		expect(said(utc)).toContain('at: -15872809');
		// Said out loud, because the number alone cannot show which zone made it.
		expect(said(utc)).toContain('Etc/UTC');
		// Still a Los Angeles vault afterwards.
		expect((await binding())['timezone']).toBe('America/Los_Angeles');
		expect(said(utc)).toContain('2031-02-13 01:26:11');
	});

	it('reads the bound zone when none is named', async () => {
		expect(said(await run('/time at 2031-02-13 09:26:11'))).toContain('at: -15844009');
	});

	it('names a zone it does not know rather than blaming the date', async () => {
		const bad = await run('/time at 2031-02-13 09:26:11 Bag/End');
		expect(said(bad)).toMatch(/not a time zone/);
	});
});

/**
 * Both bugs here were found by running the command against a real vault that
 * predates `setting/`, which is the only place either one shows up.
 */
describe('/time writes into a vault that has no setting/ directory', () => {
	beforeEach(async () => {
		// A pre-`setting/` vault: the clock binding is in its legacy home and the
		// modern directory does not exist at all.
		await mkdir(resolve(root, VAULT.meta), {recursive: true});
		await mkdir(path.dirname(resolve(root, VAULT.legacyTime)), {recursive: true});
		await writeFile(
			resolve(root, VAULT.legacyTime),
			[
				'---',
				'origin: Inanna’s Birthday',
				'calendar: seconds',
				'---',
				'',
				'Why.',
				'',
			].join('\n'),
			'utf8',
		);
		await build();
	});

	it('creates the directory instead of failing with ENOENT', async () => {
		const result = await run('/time gregorian 2031-08-15T19:33:00-07:00 Etc/UTC');
		expect(said(result)).not.toMatch(/ENOENT/);
		expect(said(result)).toContain('clock read as gregorian');
		expect((await binding())['epoch']).toBe('2031-08-15T19:33:00-07:00');
	});

	it('carries the fields the author already set across from the legacy file', async () => {
		await run('/time gregorian 2031-08-15T19:33:00-07:00 Etc/UTC');
		// The origin was set once, in the old home, and is not part of this
		// command's patch — reading only the new path silently dropped it.
		expect((await binding())['origin']).toBe('Inanna’s Birthday');
	});
});

/**
 * Binding a calendar is configuration, not conversion — there is no timestamp
 * to report, because the epoch *is* instant zero. What is worth reporting is
 * that the spelling of zero changed and that nothing under it moved.
 */
describe('what /time gregorian says it did', () => {
	beforeEach(async () => {
		await scaffoldVault(root, 'technological');
		await build();
		await run('/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles');
	});

	it('shows what second zero now reads as, and what it read as before', async () => {
		const result = await run('/time gregorian 2031-08-15T19:33:00-07:00 Etc/UTC');
		expect(said(result)).toContain('2031-08-16 02:33:00');
		expect(said(result)).toContain('2031-08-15 19:33:00 before this');
		expect(said(result)).toContain('Gregorian (Etc/UTC)');
	});

	it('states the origin\u2019s seconds rather than leaving them to be inferred', async () => {
		const result = await run('/time gregorian 2031-08-15T19:33:00-07:00 Etc/UTC');
		expect(said(result)).toContain('origin       0  2031-08-16 02:33:00');
		expect(said(result)).toMatch(/second zero/);
	});

	it('converts the anchor it was just given, through /time at', async () => {
		await run('/time gregorian 2031-08-15T19:33:00-07:00 Etc/UTC');
		// The notation /time gregorian requires, read back by /time at.
		expect(said(await run('/time at 2031-08-15T19:33:00-07:00'))).toContain('at: 0');
		expect(said(await run('/time at 2036-08-15T09:30:00Z'))).toContain('at: 157791420');
	});

	it('says the dated moments read differently and did not move', async () => {
		await run('/moment new The Substrate Patch');
		await run('/moment the-substrate-patch at 2036-08-15 02:30:00');
		const before = context.project!.vault.moments.find(
			m => m.id === 'the-substrate-patch',
		)!.at;

		const result = await run('/time gregorian 2031-08-15T19:33:00-07:00 Etc/UTC');
		expect(said(result)).toMatch(/read differently now — none of them moved/);

		const after = context.project!.vault.moments.find(
			m => m.id === 'the-substrate-patch',
		)!.at;
		// The claim the message makes, actually checked.
		expect(after).toBe(before);
	});

	it('says nothing about moments when no reading changed', async () => {
		const result = await run(
			'/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles',
		);
		expect(said(result)).not.toMatch(/read differently/);
	});
});

/**
 * The point of the preview is that it is not a rebind. Every assertion here is
 * really about the absence of a write.
 */
describe('/time in — another zone, without rebinding', () => {
	beforeEach(async () => {
		await scaffoldVault(root, 'technological');
		await build();
		await run('/time gregorian 2031-08-15T19:33:00-07:00 Etc/UTC');
		await run('/moment new The Substrate Patch');
		await run('/moment the-substrate-patch at 2036-08-15 09:30:00');
	});

	it('shows both readings and leaves the binding alone', async () => {
		const result = await run('/time in America/Los_Angeles');

		expect(said(result)).toContain('preview only');
		// Second zero, spelled two ways.
		expect(said(result)).toContain('2031-08-16 02:33:00');
		expect(said(result)).toContain('2031-08-15 19:33:00');
		// The vault is still what it was.
		expect((await binding())['timezone']).toBe('Etc/UTC');
	});

	it('lists a dated moment in both zones, against one set of seconds', async () => {
		const at = context.project!.vault.moments.find(
			m => m.id === 'the-substrate-patch',
		)!.at!;

		const result = await run('/time in America/Los_Angeles');
		expect(said(result)).toContain(at.toString());
		expect(said(result)).toContain('2036-08-15 09:30:00');
		expect(said(result)).toContain('2036-08-15 02:30:00');

		// Same seconds afterwards. This is the claim the output makes.
		expect(
			context.project!.vault.moments.find(m => m.id === 'the-substrate-patch')!.at,
		).toBe(at);
	});

	it('says so plainly when the zone is the one already bound', async () => {
		expect(said(await run('/time in Etc/UTC'))).toMatch(/reads exactly as/);
		// And under its other spelling, which is the same zone. Compared by what
		// they render, since the two names are not equal strings.
		expect(said(await run('/time in UTC'))).toMatch(/reads exactly as/);
	});

	it('rejects a zone that is not one', async () => {
		const result = await run('/time in Bag/End');
		expect(said(result)).toMatch(/not a time zone/);
		expect((await binding())['timezone']).toBe('Etc/UTC');
	});

	it('has nothing to preview when no calendar has zones', async () => {
		await run('/time seconds');
		expect(said(await run('/time in Asia/Tokyo'))).toMatch(/no time zones/);
	});
});

describe('what /time gregorian stores', () => {
	beforeEach(async () => {
		await scaffoldVault(root, 'technological');
		await build();
	});

	it('records the epoch with its offset resolved', async () => {
		await run('/time gregorian 2031-08-15T22:33:00 America/Los_Angeles');
		// What the author typed is a reading; what is stored is a fact.
		expect((await binding())['epoch']).toBe('2031-08-15T22:33:00-07:00');
		expect((await binding())['timezone']).toBe('America/Los_Angeles');
	});

	it('leaves an epoch that already carries one exactly as written', async () => {
		await run('/time gregorian 2031-08-15T19:33:00-07:00 Etc/UTC');
		expect((await binding())['epoch']).toBe('2031-08-15T19:33:00-07:00');
	});

	it('lets a later zone change move the zone and not the anchor', async () => {
		await run('/time gregorian 2031-08-15T22:33:00 America/Los_Angeles');
		const anchor = await run('/time at 2031-08-15 22:33:00');
		expect(said(anchor)).toContain('at: 0');

		// Same epoch string, different zone. With the offset resolved on the
		// first write, this moves how dates read and leaves second zero alone.
		await run('/time gregorian 2031-08-15T22:33:00-07:00 Asia/Tokyo');
		expect(said(await run('/time at 2031-08-16 14:33:00'))).toContain('at: 0');
	});
});
