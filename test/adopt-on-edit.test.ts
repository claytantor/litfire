import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {readIngestState, statusOf} from '../source/ingest/state.js';
import {parseDocument} from '../source/vault/frontmatter.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-adopt-'));
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

async function file(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), {recursive: true});
	await writeFile(target, contents, 'utf8');
}

const read = (relative: string) => readFile(path.join(root, relative), 'utf8');
const exists = (relative: string) =>
	read(relative).then(
		() => true,
		() => false,
	);

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

/** A vault written before raw-first: a corpus page and nothing in raw/. */
async function legacyMoment() {
	await file(
		'corpus/moments/the-breach.md',
		'---\nid: the-breach\nname: The Breach\n---\n\nWhat changed here.\n',
	);
	context = {...context, project: await computeProject(root)};
}

describe('the first edit adopts the page', () => {
	it('copies it into raw, frontmatter and prose together', async () => {
		await legacyMoment();
		await run('/moment the-breach at 86400');

		const adopted = await read('raw/moments/the-breach.md');
		const {data, body} = parseDocument(adopted);

		expect(data['id']).toBe('the-breach');
		expect(data['name']).toBe('The Breach');
		expect(data['at']).toBe(86_400n);
		// The whole page, so the note is a complete record rather than a stub
		// that would lose the body on the next ingest.
		expect(body).toContain('What changed here.');
	});

	it('says so, once', async () => {
		await legacyMoment();

		expect(said(await run('/moment the-breach at 86400'))).toContain('adopted into');
		// Already adopted; a line on every edit forever would be noise.
		expect(said(await run('/moment the-breach at 1000'))).not.toContain('adopted');
	});

	it('edits the note from then on, not the page', async () => {
		await legacyMoment();
		await run('/moment the-breach at 86400');
		await run('/moment the-breach name The Second Breach');

		expect(parseDocument(await read('raw/moments/the-breach.md')).data['name']).toBe(
			'The Second Breach',
		);
	});

	it('opens the note when the buffer is asked for', async () => {
		await legacyMoment();
		const result = await run('/moment the-breach edit');

		expect(result.openEditor).toContain(path.join('raw', 'moments', 'the-breach.md'));
		expect(said(result)).toContain('adopted into');
	});
});

describe('the derived page keeps up', () => {
	/**
	 * Setting a field the author stated is a copy, not an inference. Requiring a
	 * model call to make it visible would make the tool worse at its own job.
	 */
	it('carries the change across without a model', async () => {
		await legacyMoment();
		await run('/moment the-breach at 86400');

		expect(context.project!.vault.moments.find(m => m.id === 'the-breach')?.at).toBe(
			86_400n,
		);
	});

	it('leaves the page’s prose exactly as it was', async () => {
		await legacyMoment();
		const before = parseDocument(await read('corpus/moments/the-breach.md')).body;

		await run('/moment the-breach at 86400');

		expect(parseDocument(await read('corpus/moments/the-breach.md')).body).toBe(before);
	});

	it('stamps provenance, so the next ingest skips it', async () => {
		await legacyMoment();
		await run('/moment the-breach at 86400');

		const state = await readIngestState(root, 'moment');
		const note = await read('raw/moments/the-breach.md');

		expect(state.get('raw/moments/the-breach.md')).toBeDefined();
		expect(statusOf(state, 'raw/moments/the-breach.md', note)).toBe('unchanged');
	});
});

describe('every kind takes the same path', () => {
	it('places', async () => {
		await file('corpus/places/oz-farm.md', '---\nid: oz-farm\n---\n\nTwelve acres.\n');
		context = {...context, project: await computeProject(root)};

		await run('/place oz-farm name The Farm');
		expect(parseDocument(await read('raw/places/oz-farm.md')).data['name']).toBe(
			'The Farm',
		);
	});

	it('arcs', async () => {
		await run('/arc arc-01 order 30');
		expect(await exists('raw/arcs/arc-01.md')).toBe(true);
		expect(context.project!.vault.arcs.find(a => a.id === 'arc-01')?.order).toBe(30);
	});

	it('situations, through every linking verb', async () => {
		await run('/situation sit-001 place oz-farm');
		await run('/situation sit-001 cast carl');

		const {data} = parseDocument(await read('raw/situations/sit-001.md'));
		expect(data['place']).toBe('oz-farm');
		// Additive: the scaffold's scene already casts someone.
		expect(data['characters']).toContain('carl');
	});
});

describe('what it refuses', () => {
	it('will not adopt something that does not exist anywhere', async () => {
		expect(said(await run('/moment nowhere at 0'))).toContain("no moment 'nowhere'");
		expect(await exists('raw/moments/nowhere.md')).toBe(false);
	});

	it('writes nothing when the value is refused', async () => {
		await legacyMoment();
		const result = await run('/moment the-breach at -31557600000000000001');

		expect(said(result)).toContain('outside the supported range');
		// Nothing adopted, because nothing was set: a refused edit must not leave
		// a half-migrated page behind.
		expect(await exists('raw/moments/the-breach.md')).toBe(false);
	});
});
