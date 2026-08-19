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
	root = await mkdtemp(path.join(tmpdir(), 'litfire-moment-'));
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

const moments = () => context.project!.vault.moments;

describe('creating a moment', () => {
	it('slugs the name into an id and opens the buffer to describe it', async () => {
		const result = await run('/moment new The Substrate Patch');

		expect(said(result)).toContain('created');
		expect(result.openEditor).toContain('the-substrate-patch.md');
		expect(moments().some(m => m.id === 'the-substrate-patch')).toBe(true);
	});

	it('keeps the name the author typed, not just the slug', async () => {
		await run('/moment new The Substrate Patch');
		expect(moments().find(m => m.id === 'the-substrate-patch')?.name).toBe(
			'The Substrate Patch',
		);
	});

	/**
	 * A moment an author has just thought of usually has no date yet. Demanding
	 * one at creation would either block the thought or invent a number.
	 */
	it('starts undated, and says how to place it', async () => {
		const result = await run('/moment new The Breach');

		expect(moments().find(m => m.id === 'the-breach')?.at).toBeUndefined();
		expect(said(result)).toContain('at <date>');
	});

	it('refuses to overwrite one that already exists', async () => {
		await run('/moment new The Breach');
		const second = await run('/moment new The Breach');

		expect(said(second)).toContain('already exists');
		expect(moments().filter(m => m.id === 'the-breach')).toHaveLength(1);
	});

	it('asks for a name when given none', async () => {
		expect(said(await run('/moment new'))).toContain('usage:');
	});
});

describe('setting the time', () => {
	beforeEach(async () => {
		await run('/moment new The Breach');
	});

	it('takes whole seconds', async () => {
		expect(said(await run('/moment the-breach at 86400'))).toContain('86,400');
		expect(moments().find(m => m.id === 'the-breach')?.at).toBe(86_400n);
	});

	it('takes a date once a calendar is bound', async () => {
		await run('/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles');

		const result = await run('/moment the-breach at 2036-08-15 02:30:00');
		expect(said(result)).toContain('2036-08-15 02:30:00');
		expect(moments().find(m => m.id === 'the-breach')?.at).toBe(157_791_420n);
	});

	it('updates a time that was already set', async () => {
		await run('/moment the-breach at 86400');
		await run('/moment the-breach at -1000');

		expect(moments().find(m => m.id === 'the-breach')?.at).toBe(-1_000n);
	});

	it('writes deep time to disk at full precision', async () => {
		await run('/moment the-breach at -26174880000000123');

		// Straight off the file, not the parsed model: the digits have to survive
		// the round trip through YAML.
		const raw = await readFile(
			path.join(root, 'timeline', 'moments', 'the-breach.md'),
			'utf8',
		);
		expect(raw).toContain('at: -26174880000000123');
		expect(moments().find(m => m.id === 'the-breach')?.at).toBe(-26_174_880_000_000_123n);
	});

	it('accepts the grouped digits it prints', async () => {
		await run('/moment the-breach at -26,174,880,000,000,123');
		expect(moments().find(m => m.id === 'the-breach')?.at).toBe(-26_174_880_000_000_123n);
	});

	it('reports a time it cannot read, and changes nothing', async () => {
		const result = await run('/moment the-breach at last Tuesday');

		expect(said(result)).toContain('is not a time');
		expect(moments().find(m => m.id === 'the-breach')?.at).toBeUndefined();
	});

	it('refuses an instant past the supported range', async () => {
		const result = await run('/moment the-breach at -31557600000000000001');

		expect(said(result)).toContain('is not a time');
		expect(moments().find(m => m.id === 'the-breach')?.at).toBeUndefined();
	});

	it('reports a moment that does not exist', async () => {
		expect(said(await run('/moment nowhere at 0'))).toContain("no moment 'nowhere'");
	});
});

describe('editing a moment', () => {
	beforeEach(async () => {
		await run('/moment new The Breach');
	});

	it('opens the description in the native buffer', async () => {
		const result = await run('/moment the-breach edit');
		expect(result.openEditor).toContain('the-breach.md');
	});

	it('renames without touching anything else', async () => {
		await run('/moment the-breach at 86400');
		await run('/moment the-breach name The Second Breach');

		const moment = moments().find(m => m.id === 'the-breach');
		expect(moment?.name).toBe('The Second Breach');
		expect(moment?.at).toBe(86_400n);
	});

	it('never rewrites the description when changing the time', async () => {
		const file = path.join(root, 'timeline', 'moments', 'the-breach.md');
		const before = await readFile(file, 'utf8');
		const body = parseDocument(before).body;

		await run('/moment the-breach at 86400');
		await run('/moment the-breach name Renamed');

		expect(parseDocument(await readFile(file, 'utf8')).body).toBe(body);
	});

	it('takes the id before or after the verb', async () => {
		await run('/moment the-breach at 100');
		await run('/moment at the-breach 200');

		expect(moments().find(m => m.id === 'the-breach')?.at).toBe(200n);
	});
});

describe('reading moments back', () => {
	it('lists nothing helpfully when there are none', async () => {
		expect(said(await run('/moment'))).toContain('/moment new');
	});

	it('separates dated from undated', async () => {
		await run('/moment new The Breach');
		await run('/moment new The Aftermath');
		await run('/moment the-breach at 0');

		const shown = said(await run('/moment'));
		// "1 dated", never "1 dateds".
		expect(shown).toContain('1 dated ');
		expect(shown).toContain('the-breach');
		expect(shown).toContain('undated');
		expect(shown).toContain('the-aftermath');
	});

	it('shows one moment with what hangs off it', async () => {
		await run('/moment new The Breach');
		await run('/moment the-breach at 0');
		await run('/arc arc-01 after the-breach');

		const shown = said(await run('/moment the-breach'));
		expect(shown).toContain('reads as');
		expect(shown).toContain('arcs starting after it');
		expect(shown).toContain('arc-01');
	});

	it('says an undated moment is not on the clock', async () => {
		await run('/moment new The Breach');
		const shown = said(await run('/moment the-breach'));

		expect(shown).toContain('undated');
		expect(shown).toContain('at <date>');
	});

	it('reports an id it does not know', async () => {
		expect(said(await run('/moment nowhere'))).toContain("no moment 'nowhere'");
	});
});
