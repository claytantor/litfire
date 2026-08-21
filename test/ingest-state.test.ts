import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {readRaw} from '../source/ingest/index.js';
import {
	hashSource,
	readIngestState,
	honourAuthored,
	stampSource,
	statusOf,
} from '../source/ingest/state.js';
import {parseDocument} from '../source/vault/frontmatter.js';
import {RAW_KINDS, VAULT} from '../source/vault/paths.js';
import {appendLog} from '../source/vault/log.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-state-'));
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

async function note(relative: string, contents: string) {
	const file = path.join(root, relative);
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, contents, 'utf8');
}

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

describe('/init scaffolds the raw folders', () => {
	it('creates one per primitive, with a README saying what belongs there', async () => {
		for (const kind of RAW_KINDS) {
			const readme = path.join(root, VAULT.raw, kind, 'README.md');
			await expect(readFile(readme, 'utf8'), `${kind}/README.md`).resolves.toContain(
				`raw/${kind}`,
			);
		}
	});

	/** Signposting, not material. Ingesting it would propose a page about pages. */
	it('does not offer those READMEs as documents to ingest', async () => {
		// Isolate from the scaffold's seeded raw/characters/protagonist.md.
		await rm(path.join(root, 'raw/characters/protagonist.md'), {force: true});
		expect((await readRaw(root, 'character')).documents).toEqual([]);

		await note('raw/characters/inanna.md', 'She lied.');
		expect((await readRaw(root, 'character')).documents.map(d => d.path)).toEqual([
			'raw/characters/inanna.md',
		]);
	});
});

describe('knowing what has already been said', () => {
	it('hashes the same content the same way, whatever the line endings', () => {
		expect(hashSource('one\ntwo')).toBe(hashSource('one\r\ntwo'));
		expect(hashSource('one\ntwo\n\n')).toBe(hashSource('one\ntwo'));
		expect(hashSource('one')).not.toBe(hashSource('two'));
		expect(hashSource('one')).toHaveLength(12);
	});

	it('reads provenance back off the corpus, not a cache', async () => {
		await note(
			'characters/inanna.md',
			'---\nid: inanna\nsource: raw/characters/inanna.md\nsource_hash: abc123abc123\n---\n\nProse.\n',
		);

		const state = await readIngestState(root, 'character');
		expect(state.get('raw/characters/inanna.md')).toBe('abc123abc123');
	});

	it('ignores a page that carries no provenance', async () => {
		// Isolate from the scaffold's seeded characters/protagonist.md, which
		// does carry provenance.
		await rm(path.join(root, 'characters/protagonist.md'), {force: true});
		await note('characters/hand-written.md', '---\nid: hand-written\n---\n\nProse.\n');
		expect(await readIngestState(root, 'character')).toEqual(new Map());
	});

	it('tells new from changed from unchanged', () => {
		const state = new Map([['raw/characters/inanna.md', hashSource('She lied.')]]);

		expect(statusOf(state, 'raw/characters/inanna.md', 'She lied.')).toBe('unchanged');
		expect(statusOf(state, 'raw/characters/inanna.md', 'She lied twice.')).toBe(
			'changed',
		);
		expect(statusOf(state, 'raw/characters/carl.md', 'anything')).toBe('new');
	});
});

describe('stamping a page', () => {
	it('records the note and its hash, leaving the prose alone', () => {
		const page = '---\nid: inanna\nname: Inanna\n---\n\nShe lied.\n';
		const stamped = stampSource(page, 'raw/characters/inanna.md', 'abc123abc123');
		const {data, body} = parseDocument(stamped);

		expect(data['source']).toBe('raw/characters/inanna.md');
		expect(data['source_hash']).toBe('abc123abc123');
		expect(data['name']).toBe('Inanna');
		expect(body).toBe(parseDocument(page).body);
	});

	it('round-trips into something the next ingest can read', async () => {
		await note(
			'characters/inanna.md',
			stampSource(
				'---\nid: inanna\n---\n\nShe lied.\n',
				'raw/characters/inanna.md',
				hashSource('She lied.'),
			),
		);

		const state = await readIngestState(root, 'character');
		expect(statusOf(state, 'raw/characters/inanna.md', 'She lied.')).toBe('unchanged');
		expect(statusOf(state, 'raw/characters/inanna.md', 'She lied twice.')).toBe(
			'changed',
		);
	});
});

describe('/ingest before it spends anything', () => {
	it('does nothing at all when every note is already reflected', async () => {
		// Isolate from the scaffold's seeded raw/characters/protagonist.md.
		await rm(path.join(root, 'raw/characters/protagonist.md'), {force: true});
		await note('raw/characters/inanna.md', 'She lied.');
		await note(
			'characters/inanna.md',
			stampSource(
				'---\nid: inanna\n---\n\nShe lied.\n',
				'raw/characters/inanna.md',
				hashSource('She lied.'),
			),
		);
		context = {...context, project: await computeProject(root)};

		const result = await run('/ingest character');
		expect(result.ingest).toBeUndefined();
		expect(said(result)).toContain('nothing to do');
		expect(said(result)).toContain('all 1 up to date');
	});

	it('runs again once the note changes', async () => {
		await note('raw/characters/inanna.md', 'She lied.');
		await note(
			'characters/inanna.md',
			stampSource(
				'---\nid: inanna\n---\n\nShe lied.\n',
				'raw/characters/inanna.md',
				hashSource('She lied.'),
			),
		);
		await note('raw/characters/inanna.md', 'She lied, and knew it.');
		context = {...context, project: await computeProject(root)};

		const result = await run('/ingest character');
		expect(result.ingest).toEqual({kind: 'character'});
		expect(said(result)).toContain('changed');
	});

	it('says which notes it will read and how many it skipped', async () => {
		// Isolate from the scaffold's seeded raw/characters/protagonist.md.
		await rm(path.join(root, 'raw/characters/protagonist.md'), {force: true});
		await note('raw/characters/inanna.md', 'She lied.');
		await note('raw/characters/carl.md', 'He did not.');
		await note(
			'characters/inanna.md',
			stampSource(
				'---\nid: inanna\n---\n\nProse.\n',
				'raw/characters/inanna.md',
				hashSource('She lied.'),
			),
		);
		context = {...context, project: await computeProject(root)};

		const shown = said(await run('/ingest character'));
		expect(shown).toContain('ingesting 1 of 2');
		expect(shown).toContain('new       raw/characters/carl.md');
		expect(shown).toContain('1 unchanged, skipped');
	});
});

describe('the log', () => {
	it('appends a timestamped line and never reads it back', async () => {
		await appendLog(root, '/ingest character: read 2 note(s), proposed 3 page(s)');
		await appendLog(root, '/curator: proposed 1 file(s) — merge the duplicates');

		const log = await readFile(path.join(root, VAULT.log), 'utf8');
		const lines = log.split('\n').filter(line => line.startsWith('- '));

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain('/ingest character');
		expect(lines[1]).toContain('merge the duplicates');
		// ISO 8601, so `git log` and the file agree about when.
		expect(lines[0]).toMatch(/- \d{4}-\d{2}-\d{2}T[\d:.]+Z — /);
	});

	/** A permissions problem is not a reason to lose the work just done. */
	it('says nothing and throws nothing when it cannot write', async () => {
		await expect(
			appendLog(path.join(root, 'nowhere', 'at', 'all'), 'ignored'),
		).resolves.toBeUndefined();
	});
});

describe('the author’s own frontmatter', () => {
	const doc = (data: string, body: string) => ({
		path: 'raw/situations/sit-001.md',
		contents: `---\n${data}---\n\n${body}`,
		data: parseDocument(`---\n${data}---\n\n${body}`).data,
		body: parseDocument(`---\n${data}---\n\n${body}`).body,
	});

	it('is read off a note alongside its prose', async () => {
		await note(
			'raw/situations/sit-001.md',
			'---\nmoment: inannas-first-memory\ncast: [inanna]\n---\n\nShe woke suddenly.\n',
		);

		const [document] = (await readRaw(root, 'situation')).documents;
		expect(document?.data['moment']).toBe('inannas-first-memory');
		expect(document?.data['cast']).toEqual(['inanna']);
		expect(document?.body.trim()).toBe('She woke suddenly.');
	});

	/**
	 * A decision the author made should not depend on a model remembering to
	 * carry it. The instruction asks; this makes it so.
	 */
	it('outranks whatever the model chose for the same field', () => {
		const proposed =
			'---\nid: sit-001\nmoment: something-else\nplace: nowhere\n---\n\nProse.\n';
		const merged = honourAuthored(
			proposed,
			doc('moment: inannas-first-memory\n', 'She woke suddenly.\n'),
		);
		const {data} = parseDocument(merged);

		expect(data['moment']).toBe('inannas-first-memory');
		// Fields the author did not set are still the model's to fill.
		expect(data['place']).toBe('nowhere');
	});

	it('leaves the prose the model wrote alone', () => {
		const proposed = '---\nid: sit-001\n---\n\nThe page body.\n';
		const merged = honourAuthored(proposed, doc('cast: [inanna]\n', 'The note body.\n'));

		expect(parseDocument(merged).body.trim()).toBe('The page body.');
	});

	/** A compendium says nothing in particular about any one page it produces. */
	it('applies only to the page the note is about', () => {
		const proposed = '---\nid: the-breach\n---\n\nProse.\n';
		const merged = honourAuthored(
			proposed,
			doc('at: 100\n', 'Nine moments, in order.\n'),
		);

		expect(parseDocument(merged).data['at']).toBeUndefined();
	});

	it('never lets a note forge its own provenance', () => {
		const proposed = '---\nid: sit-001\n---\n\nProse.\n';
		const merged = honourAuthored(
			proposed,
			doc('source: somewhere-else.md\nsource_hash: deadbeefdead\n', 'Prose.\n'),
		);
		const {data} = parseDocument(merged);

		expect(data['source']).toBeUndefined();
		expect(data['source_hash']).toBeUndefined();
	});

	it('does nothing at all to a note with no frontmatter', () => {
		const proposed = '---\nid: sit-001\n---\n\nProse.\n';
		expect(honourAuthored(proposed, doc('', 'Just prose.\n'))).toBe(proposed);
	});
});
