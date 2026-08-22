import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {readRaw} from '../source/ingest/index.js';
import {stampSource, hashSource} from '../source/ingest/state.js';
import {INGEST} from '../source/ingest/index.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-again-'));
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

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	context = {...context, project: await computeProject(root)};
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
}

/** Mark every note of a kind as already reflected by its page. */
async function allSeen(kind: 'character') {
	const {documents} = await readRaw(root, kind);
	for (const document of documents) {
		const id = path.basename(document.path, '.md');
		const page = path.join(root, INGEST[kind].to, `${id}.md`);
		await mkdir(path.dirname(page), {recursive: true});
		await writeFile(
			page,
			stampSource(
				`---\nid: ${id}\n---\n\nAlready here.\n`,
				document.path,
				hashSource(document.contents),
			),
			'utf8',
		);
	}
}

/**
 * Idempotency is keyed on the note's hash, which is right for the case it was
 * built for and blind to the one that matters when the tool itself changes: a
 * page built before summary blocks existed is stale, and its note has not
 * moved, so no hash can tell.
 */
describe('reading notes the corpus already reflects', () => {
	it('skips them by default, and says how to override', async () => {
		await allSeen('character');
		const result = await run('/ingest character');

		expect(result.ingest).toBeUndefined();
		expect(said(result)).toContain('/ingest character again');
	});

	it('reads them when asked, explicitly', async () => {
		await allSeen('character');
		const result = await run('/ingest character again');

		expect(result.ingest?.again).toBe(true);
		expect(said(result)).toContain('ingesting');
	});

	it('does not mistake `again` for a document name', async () => {
		const result = await run('/ingest character again');
		expect(result.ingest?.focus).toBeUndefined();
	});

	it('still narrows to one document alongside it', async () => {
		const result = await run('/ingest character protagonist again');

		expect(result.ingest?.focus).toBe('protagonist');
		expect(result.ingest?.again).toBe(true);
	});

	it('is off unless asked for, so a normal ingest stays free', async () => {
		const result = await run('/ingest character');
		expect(result.ingest?.again).toBeUndefined();
	});
});
