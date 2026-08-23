import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import {computeProject} from '../source/core/project.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-arcorder-'));
	await scaffoldVault(root);
	// The scaffold's own scene would sit in every sequence below.
	await rm(path.join(root, VAULT.situations, 'sit-001.md'), {force: true});
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function file(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), {recursive: true});
	await writeFile(target, contents, 'utf8');
}

const order = async () =>
	(await computeProject(root)).replay.sequence.map(step => step.id);

/** A deep-time moment, a present one, and a main arc anchored at the present. */
async function twoAges() {
	await file(
		`${VAULT.moments}/aeons-ago.md`,
		'---\nid: aeons-ago\nat: -900000000000\n---\n\nLong before.\n',
	);
	await file(
		`${VAULT.moments}/the-breach.md`,
		'---\nid: the-breach\nat: 0\n---\n\nIt broke.\n',
	);
	await file(
		`${VAULT.arcs}/arc-01.md`,
		'---\nid: arc-01\norder: 1\nstarts_after: the-breach\n---\n\nMain.\n',
	);
	await file(
		`${VAULT.situations}/sit-main.md`,
		'---\nid: sit-main\ntitle: Main\narc: arc-01\norder: 10\n---\n\nAfter.\n',
	);
}

/**
 * The opening of a book has nothing before it, so its arc has no `starts_after`
 * to name — and an arc without one used to mean "the beginning of time", which
 * put a prologue's scenes *before the moment they say they happen at*. Any
 * events that moment carried had not applied yet, so the scene saw a world that
 * had not changed.
 */
describe('an arc with nothing before it', () => {
	it('plays its scenes after the moment they are anchored to', async () => {
		await twoAges();
		await file(
			`${VAULT.arcs}/arc-00.md`,
			'---\nid: arc-00\norder: 0\n---\n\nPrologue.\n',
		);
		await file(
			`${VAULT.situations}/prologue.md`,
			'---\nid: prologue\ntitle: Prologue\nmoment: aeons-ago\narc: arc-00\norder: 10\n---\n\nBefore.\n',
		);

		const sequence = await order();
		expect(sequence.indexOf('aeons-ago')).toBeLessThan(sequence.indexOf('prologue'));
		expect(sequence.indexOf('prologue')).toBeLessThan(sequence.indexOf('the-breach'));
	});

	it('takes the earliest of its scenes, not the first one written', async () => {
		await twoAges();
		await file(
			`${VAULT.arcs}/arc-00.md`,
			'---\nid: arc-00\norder: 0\n---\n\nPrologue.\n',
		);
		// Ordered second, anchored earlier: the arc has to wait for the earlier.
		await file(
			`${VAULT.situations}/later.md`,
			'---\nid: later\narc: arc-00\norder: 10\nmoment: the-breach\n---\n\nB.\n',
		);
		await file(
			`${VAULT.situations}/earlier.md`,
			'---\nid: earlier\narc: arc-00\norder: 20\nmoment: aeons-ago\n---\n\nA.\n',
		);

		const sequence = await order();
		expect(sequence.indexOf('aeons-ago')).toBeLessThan(sequence.indexOf('later'));
	});

	it('still opens the sequence when none of its scenes name a moment', async () => {
		// Nothing to anchor on, so the old behaviour is right: it goes first.
		await twoAges();
		await file(
			`${VAULT.arcs}/arc-00.md`,
			'---\nid: arc-00\norder: 0\n---\n\nPrologue.\n',
		);
		await file(
			`${VAULT.situations}/prologue.md`,
			'---\nid: prologue\narc: arc-00\norder: 10\n---\n\nBefore.\n',
		);

		expect((await order())[0]).toBe('prologue');
	});

	it('leaves an arc that names its own anchor exactly as it was', async () => {
		await twoAges();
		// `starts_after` wins: the author said it, and a scene claiming otherwise
		// does not get to move the arc.
		await file(
			`${VAULT.situations}/sit-two.md`,
			'---\nid: sit-two\narc: arc-01\norder: 20\nmoment: aeons-ago\n---\n\nFlashback.\n',
		);

		const sequence = await order();
		expect(sequence.indexOf('the-breach')).toBeLessThan(sequence.indexOf('sit-two'));
	});
});

describe('a scene on no arc', () => {
	it('is reported, because it reaches no replay at all', async () => {
		await twoAges();
		await file(
			`${VAULT.situations}/loose.md`,
			'---\nid: loose\ntitle: Loose\nmoment: aeons-ago\n---\n\nNowhere.\n',
		);

		const project = await computeProject(root);
		const finding = project.questions.find(q => q.kind === 'situation_unplaced');

		expect(finding?.detail).toContain('loose');
		expect(finding?.detail).toContain('contribute nothing to the ledger');
	});

	it('is still absent from the sequence, which is what the report is about', async () => {
		await twoAges();
		await file(`${VAULT.situations}/loose.md`, '---\nid: loose\n---\n\nNowhere.\n');

		expect(await order()).not.toContain('loose');
	});

	it('is counted once, not once per scene', async () => {
		await twoAges();
		for (const id of ['a', 'b', 'c', 'd']) {
			await file(`${VAULT.situations}/${id}.md`, `---\nid: ${id}\n---\n\nx.\n`);
		}

		const project = await computeProject(root);
		const found = project.questions.filter(q => q.kind === 'situation_unplaced');

		expect(found).toHaveLength(1);
		expect(found[0]?.detail).toContain('4 scene(s)');
		expect(found[0]?.detail).toContain('and 1 more');
	});
});

/**
 * Minting an id from the collection's length is wrong the moment ids are not a
 * dense 1..N run — a vault holding only `arc-02` mints `arc-02` again, and one
 * seeded with `arc-00` and `arc-01` skips to `arc-03`. `/situation new` already
 * counted past what was taken; these two did not.
 */
describe('minting an id for a new arc or chapter', () => {
	it('takes the first free number, not the count', async () => {
		// The scaffold seeds arc-00 and arc-01, so length + 1 would give arc-03.
		const project = await computeProject(root);
		const context = {
			root,
			project,
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		};
		const result = await findCommand('arc')!.run(['new', 'The', 'Descent'], context);

		expect(result.lines.map(l => l.text).join('\n')).toContain('arc-02');
	});

	it('does not reuse an id a gap left behind', async () => {
		await rm(path.join(root, VAULT.arcs, 'arc-01.md'), {force: true});
		const project = await computeProject(root);
		const context = {
			root,
			project,
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		};
		// arc-00 remains, so the first free number is 1.
		const result = await findCommand('arc')!.run(['new', 'Next'], context);

		expect(result.lines.map(l => l.text).join('\n')).toContain('arc-01');
	});
});
