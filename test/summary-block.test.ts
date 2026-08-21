import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject} from '../source/core/project.js';
import {buildIngest, INGEST, INGEST_KINDS, readRaw} from '../source/ingest/index.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';
import {buildWiki} from '../source/wiki/build.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-summary-'));
	await scaffoldVault(root, 'arcane');
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function file(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), {recursive: true});
	await writeFile(target, contents, 'utf8');
}

const SUMMARY = [
	'<!-- litrpg:summary -->',
	'**Wants** — to be believed, and cannot say so out loud.',
	'**Leverage** — her brother, who does not know he has any.',
	'<!-- /litrpg:summary -->',
].join('\n');

describe('what /ingest is asked for', () => {
	it('asks for a summary block, in the exact marker format', async () => {
		const {documents} = await readRaw(root, 'character');
		const {instruction} = await buildIngest(
			root,
			await computeProject(root),
			'character',
			documents,
		);

		expect(instruction).toContain('<!-- litrpg:summary -->');
		expect(instruction).toContain('**Label** — value');
	});

	it('names the points that matter for the kind being read', async () => {
		const {documents} = await readRaw(root, 'character');
		const {instruction} = await buildIngest(
			root,
			await computeProject(root),
			'character',
			documents,
		);

		expect(instruction).toContain(INGEST.character.summary);
		// Not another kind's — a character page should not be told what a faction
		// wants at a glance.
		expect(instruction).not.toContain(INGEST.faction.summary);
	});

	/**
	 * P5, restated where it is most tempting to break. A summary is exactly the
	 * shape of thing a model will fill in to look complete.
	 */
	it('forbids guessing a point the notes do not answer', async () => {
		const {documents} = await readRaw(root, 'moment');
		const {instruction} = await buildIngest(
			root,
			await computeProject(root),
			'moment',
			documents,
		);

		expect(instruction).toContain('Omit any point the notes do not answer');
		expect(instruction).toContain('do not write "unknown"');
	});

	it('has a summary spec for every kind', () => {
		for (const kind of INGEST_KINDS) {
			expect(INGEST[kind].summary, kind).toBeTruthy();
		}
	});
});

describe('what the wiki does with it', () => {
	async function characterWith(body: string) {
		await file(`${VAULT.characters}/nyx.md`, `---\nid: nyx\nname: Nyx\n---\n\n${body}\n`);
		const wiki = buildWiki(await computeProject(root));
		return wiki.pages.find(page => page.path.endsWith('characters/nyx.md'))?.body ?? '';
	}

	it('lifts the block into its own section, above the prose', async () => {
		const page = await characterWith(`${SUMMARY}\n\nShe took the stairs twice.`);

		expect(page).toContain('## At a glance');
		expect(page).toContain('**Wants** — to be believed');
		expect(page.indexOf('## At a glance')).toBeLessThan(page.indexOf('## From `'));
	});

	it('leaves the markers behind, since they are page bookkeeping', async () => {
		const page = await characterWith(`${SUMMARY}\n\nShe took the stairs twice.`);

		expect(page).not.toContain('litrpg:summary');
	});

	it('keeps the prose, without the block in the middle of it', async () => {
		const page = await characterWith(`${SUMMARY}\n\nShe took the stairs twice.`);

		expect(page).toContain('She took the stairs twice.');
		const prose = page.slice(page.indexOf('## From `'));
		expect(prose).not.toContain('**Wants**');
	});

	it('says nothing at all when a page carries no block', async () => {
		const page = await characterWith('She took the stairs twice.');

		expect(page).not.toContain('## At a glance');
		expect(page).toContain('She took the stairs twice.');
	});

	it('treats an empty block as no block', async () => {
		const page = await characterWith(
			'<!-- litrpg:summary -->\n\n<!-- /litrpg:summary -->\n\nProse.',
		);

		expect(page).not.toContain('## At a glance');
	});
});
