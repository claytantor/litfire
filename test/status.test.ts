import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BUILT_IN_PROFILES, resolveProfile} from '../source/genre/index.js';
import type {CharacterState} from '../source/ledger/replay.js';
import {renderStatusBlock, writeStatusBlock} from '../source/system/status.js';

const arcane = resolveProfile('arcane', BUILT_IN_PROFILES);
const technological = resolveProfile('technological', BUILT_IN_PROFILES);

// Stats span both arcane resources (mana, stamina) and technological ones
// (charge, heat) so the hud test is meaningful under either profile.
const character: CharacterState = {
	id: 'carl',
	system: 'system',
	level: 5,
	xp: 120,
	stats: {
		strength: 12,
		agility: 9,
		constitution: 14,
		intellect: 7,
		mana: 40,
		stamina: 20,
		charge: 15,
		heat: 3,
	},
	skills: ['fireball', 'heal'],
	artifacts: [],
	items: {potion: 3, torch: 0},
};

const emptyCharacter: CharacterState = {
	id: 'nobody',
	system: 'system',
	level: 1,
	xp: 0,
	stats: {strength: 5},
	skills: [],
	artifacts: [],
	items: {},
};

describe('renderStatusBlock', () => {
	it('renders all three templates from one fixture', () => {
		expect(renderStatusBlock(character, {profile: arcane, template: 'sheet'})).toContain(
			'carl',
		);
		expect(renderStatusBlock(character, {profile: arcane, template: 'hud'})).toContain(
			'carl',
		);
		expect(renderStatusBlock(character, {profile: arcane, template: 'inline'})).toContain(
			'carl',
		);
	});

	it('defaults template to the profile status_template', () => {
		// arcane ships status_template: 'sheet' (genre/profiles.ts)
		expect(renderStatusBlock(character, {profile: arcane})).toContain('| stat | value |');
		// technological ships status_template: 'hud'
		expect(renderStatusBlock(character, {profile: technological})).not.toContain(
			'| stat | value |',
		);
	});

	it('defaults displayName to character.id', () => {
		const inline = renderStatusBlock(character, {profile: arcane, template: 'inline'});
		expect(inline.startsWith('carl —')).toBe(true);
	});

	it('uses a displayName override when given', () => {
		const inline = renderStatusBlock(character, {
			profile: arcane,
			template: 'inline',
			displayName: 'Carl Rehnquist',
		});
		expect(inline.startsWith('Carl Rehnquist —')).toBe(true);
	});

	it('gives arcane and technological different vocabulary for the same state', () => {
		const arcaneSheet = renderStatusBlock(character, {
			profile: arcane,
			template: 'sheet',
		});
		const techSheet = renderStatusBlock(character, {
			profile: technological,
			template: 'sheet',
		});

		expect(arcaneSheet).toContain('level 5');
		expect(techSheet).toContain('iteration 5');
		expect(arcaneSheet).toContain('school: fireball, heal');
		expect(techSheet).toContain('stack: fireball, heal');
	});

	it('hud includes a resource stat and excludes items', () => {
		const hud = renderStatusBlock(character, {profile: arcane, template: 'hud'});
		expect(hud).toContain('mana 40');
		expect(hud).not.toContain('potion');
	});

	it('inline is exactly one line', () => {
		const inline = renderStatusBlock(character, {profile: arcane, template: 'inline'});
		expect(inline).not.toContain('\n');
		expect(inline.split('\n')).toHaveLength(1);
	});

	it('renders without a dangling empty section when there are no skills or items', () => {
		const sheet = renderStatusBlock(emptyCharacter, {profile: arcane, template: 'sheet'});
		expect(sheet).not.toContain('school');
		expect(sheet).not.toContain('items');
	});

	/** The guard against a fabricated maximum — see the HARD PROHIBITION in status.ts. */
	it('never emits a slash between two numbers, in any template', () => {
		for (const profile of [arcane, technological]) {
			for (const template of ['sheet', 'hud', 'inline'] as const) {
				const rendered = renderStatusBlock(character, {profile, template});
				expect(rendered).not.toMatch(/\d\/\d/);
			}
		}
	});
});

describe('writeStatusBlock', () => {
	let root = '';

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'litfire-status-'));
	});

	afterEach(async () => {
		await rm(root, {recursive: true, force: true});
	});

	const doc = [
		'Author prose above.',
		'',
		'<!-- litrpg:status char=carl at=sit-042 -->',
		'old block',
		'<!-- /litrpg:status -->',
		'',
		'Author prose below.',
	].join('\n');

	it('upserts into an existing file and preserves surrounding prose byte for byte', async () => {
		const file = path.join(root, 'sit-042.md');
		await writeFile(file, doc, 'utf8');

		await writeStatusBlock(file, 'new block', {char: 'carl', at: 'sit-042'});
		const after = await readFile(file, 'utf8');

		const before = doc.slice(0, doc.indexOf('<!-- litrpg:status'));
		const closeTag = '<!-- /litrpg:status -->';
		const proseBelow = doc.slice(doc.indexOf(closeTag) + closeTag.length);

		expect(after.startsWith(before)).toBe(true);
		expect(after.endsWith(proseBelow)).toBe(true);
		expect(after).toContain('new block');
		expect(after).not.toContain('old block');
	});

	it('replaces rather than duplicates an existing block on a second call', async () => {
		const file = path.join(root, 'sit-042.md');
		await writeFile(file, doc, 'utf8');

		await writeStatusBlock(file, 'first write', {char: 'carl', at: 'sit-042'});
		await writeStatusBlock(file, 'second write', {char: 'carl', at: 'sit-042'});

		const contents = await readFile(file, 'utf8');
		expect(contents.match(/<!-- litrpg:status/g)).toHaveLength(1);
		expect(contents).toContain('second write');
		expect(contents).not.toContain('first write');
	});

	it('rejects on a missing file rather than creating one', async () => {
		const file = path.join(root, 'does-not-exist.md');

		await expect(
			writeStatusBlock(file, 'body', {char: 'carl', at: 'sit-042'}),
		).rejects.toThrow();
		await expect(readFile(file, 'utf8')).rejects.toThrow();
	});
});
