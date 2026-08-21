import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {buildIngest, INGEST, isIngestKind, readRaw} from '../source/ingest/index.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-ingest-'));
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

describe('finding the notes', () => {
	it('reads every document in the directory', async () => {
		await note('raw/characters/sebastian-weber.md', 'A geneticist in Berlin.');
		await note('raw/characters/linh-tran.md', 'A systems engineer.');

		const {documents} = await readRaw(root, 'character');
		expect(documents.map(d => d.path)).toEqual([
			'raw/characters/linh-tran.md',
			'raw/characters/sebastian-weber.md',
		]);
	});

	it('narrows to one by its filename, exactly or loosely', async () => {
		await note('raw/characters/sebastian-weber.md', 'A geneticist.');
		await note('raw/characters/linh-tran.md', 'An engineer.');

		expect((await readRaw(root, 'character', 'sebastian-weber')).documents).toHaveLength(
			1,
		);
		// An author reaches for the thing it is about, not the filename.
		expect((await readRaw(root, 'character', 'sebastian')).documents).toHaveLength(1);
		expect((await readRaw(root, 'character', 'nobody')).documents).toHaveLength(0);
	});

	it('skips an empty file rather than sending it to a model', async () => {
		await note('raw/moments/blank.md', '   \n\n');
		expect((await readRaw(root, 'moment')).documents).toHaveLength(0);
	});

	it('reports a directory that is not there as simply empty', async () => {
		const {documents, directory} = await readRaw(root, 'artifact');
		expect(documents).toEqual([]);
		expect(directory).toBe('raw/artifacts');
	});

	it('maps every kind to a raw directory and a corpus directory', () => {
		for (const [kind, spec] of Object.entries(INGEST)) {
			expect(spec.from, kind).toMatch(/^raw\//);
			expect(spec.to, kind).not.toMatch(/^raw\//);
			expect(spec.fields, kind).toContain('id');
		}
	});
});

describe('what the pass is asked to do', () => {
	it('names where pages go and what their frontmatter holds', async () => {
		await note('raw/moments/ordered.md', '- The Breach — 32 kya');
		const {documents} = await readRaw(root, 'moment');
		const {instruction} = await buildIngest(root, context.project!, 'moment', documents);

		expect(instruction).toContain('timeline/moments/<id>.md');
		expect(instruction).toContain('whole seconds from the origin');
	});

	it('shows what already exists, so it updates rather than duplicating', async () => {
		await note('raw/moments/ordered.md', '- The Breach — 32 kya');
		await note(
			'timeline/moments/the-breach.md',
			'---\nid: the-breach\nname: The Breach\n---\n\nProse.\n',
		);
		context = {...context, project: await computeProject(root)};

		const {documents} = await readRaw(root, 'moment');
		const {context: built, instruction} = await buildIngest(
			root,
			context.project!,
			'moment',
			documents,
		);

		expect(built).toContain('`the-breach`');
		expect(built).toContain('The Breach');
		expect(instruction).toContain('Never create a second');
	});

	it('says plainly when nothing of that kind exists yet', async () => {
		await note('raw/factions/notes.md', 'The Custodians want the substrate.');
		const {documents} = await readRaw(root, 'faction');
		const {context: built} = await buildIngest(
			root,
			context.project!,
			'faction',
			documents,
		);

		expect(built).toContain('No faction pages exist yet');
	});

	it('carries the author’s notes in verbatim', async () => {
		await note('raw/places/oz-farm.md', 'Twelve acres, off-grid, one water tower.');
		const {documents} = await readRaw(root, 'place');
		const {context: built} = await buildIngest(
			root,
			context.project!,
			'place',
			documents,
		);

		expect(built).toContain('Twelve acres, off-grid, one water tower.');
		expect(built).toContain('raw/places/oz-farm.md');
	});

	it('tells it not to touch the notes themselves', async () => {
		await note('raw/places/oz-farm.md', 'Twelve acres.');
		const {documents} = await readRaw(root, 'place');
		expect(
			(await buildIngest(root, context.project!, 'place', documents)).instruction,
		).toContain('Do not modify the raw notes');
	});

	it('warns that one note may hold several things', async () => {
		await note('raw/moments/ordered.md', '- one\n- two\n- three');
		const {documents} = await readRaw(root, 'moment');
		expect(
			(await buildIngest(root, context.project!, 'moment', documents)).instruction,
		).toContain('a page each');
	});
});

describe('/ingest', () => {
	it('hands the kind and document to App rather than printing', async () => {
		await note('raw/characters/sebastian-weber.md', 'A geneticist.');

		const result = await run('/ingest character');
		expect(result.ingest).toEqual({kind: 'character'});
		expect(said(result)).toContain('raw/characters/sebastian-weber.md');
	});

	it('passes the document through when one is named', async () => {
		await note('raw/characters/sebastian-weber.md', 'A geneticist.');
		await note('raw/characters/linh-tran.md', 'An engineer.');

		const result = await run('/ingest character sebastian-weber');
		expect(result.ingest).toEqual({kind: 'character', focus: 'sebastian-weber'});
		expect(said(result)).toContain('sebastian-weber');
		expect(said(result)).not.toContain('linh-tran');
	});

	/** Nothing to think about, and a model call costs money. */
	it('refuses an empty directory before calling anything', async () => {
		const result = await run('/ingest character');

		expect(result.ingest).toBeUndefined();
		expect(said(result)).toContain('nothing to ingest');
		expect(said(result)).toContain('raw/characters');
	});

	it('says which document it could not find', async () => {
		await note('raw/characters/linh-tran.md', 'An engineer.');
		const result = await run('/ingest character nobody');

		expect(result.ingest).toBeUndefined();
		expect(said(result)).toContain("no document matching 'nobody'");
	});

	it('lists the kinds when given a bad one, or none', async () => {
		expect(said(await run('/ingest nonsense'))).toContain('character, moment, place');
		expect(said(await run('/ingest'))).toContain('usage:');
	});

	it('accepts every kind it advertises', () => {
		for (const kind of Object.keys(INGEST)) {
			expect(isIngestKind(kind), kind).toBe(true);
		}
		expect(isIngestKind('transcript')).toBe(false);
	});
});
