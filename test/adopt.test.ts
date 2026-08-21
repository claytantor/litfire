import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {planAdoption} from '../source/ingest/adopt.js';
import {buildIngest, readRaw} from '../source/ingest/index.js';
import type {Proposal} from '../source/review/types.js';
import {parseDocument} from '../source/vault/frontmatter.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-adopt-sweep-'));
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

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

const find = (proposals: readonly Proposal[], wanted: string) =>
	proposals.find(proposal => proposal.path === wanted);

/** A page the author typed directly, the way every pre-raw-first vault has. */
async function authoredPage() {
	await file(
		'corpus/factions/the-gnostics.md',
		'---\nid: the-gnostics\nname: The Gnostics\ngoal: Recover what was hidden\n---\n\nThey keep the older reading.\n',
	);
}

describe('what adoption is for', () => {
	it('writes the note an authored page never had', async () => {
		await authoredPage();
		const plan = await planAdoption(root, ['faction']);

		const note = find(plan.proposals, 'raw/factions/the-gnostics.md');
		expect(note).toBeDefined();

		const {data, body} = parseDocument(note!.contents);
		expect(data['id']).toBe('the-gnostics');
		expect(data['goal']).toBe('Recover what was hidden');
		// The whole page, so the note is a complete record rather than a stub
		// whose body the next ingest would drop.
		expect(body).toContain('They keep the older reading.');
	});

	it('stamps the page to cite it', async () => {
		await authoredPage();
		const plan = await planAdoption(root, ['faction']);

		const page = find(plan.proposals, 'corpus/factions/the-gnostics.md');
		const {data} = parseDocument(page!.contents);

		expect(data['source']).toBe('raw/factions/the-gnostics.md');
		expect(data['source_hash']).toEqual(expect.any(String));
	});

	it('leaves the page’s prose exactly as it was', async () => {
		await authoredPage();
		const plan = await planAdoption(root, ['faction']);

		const page = find(plan.proposals, 'corpus/factions/the-gnostics.md');
		expect(parseDocument(page!.contents).body).toContain('They keep the older reading.');
	});

	it('proposes both halves, so neither lands unseen', async () => {
		await authoredPage();
		const plan = await planAdoption(root, ['faction']);

		expect(plan.proposals).toHaveLength(2);
		expect(plan.adopting).toHaveLength(1);
	});
});

describe('what adoption refuses to touch', () => {
	/**
	 * The case that matters most. A note may say far more than the page ever
	 * caught — one real vault had a 6.8KB system note behind a 2.2KB page — and
	 * overwriting it with the thinner derivative would destroy the very thing
	 * raw-first exists to protect.
	 */
	it('never overwrites a note the author already wrote', async () => {
		await authoredPage();
		await file(
			'raw/factions/the-gnostics.md',
			'Everything I actually know about them.\n',
		);

		const plan = await planAdoption(root, ['faction']);

		expect(plan.proposals).toEqual([]);
		expect(plan.skipped[0]?.page).toBe('corpus/factions/the-gnostics.md');
		expect(plan.skipped[0]?.reason).toContain('already exists');
	});

	it('skips a page that already cites a note', async () => {
		// Every scaffolded page does, which is the point of seeding both layers.
		const plan = await planAdoption(root, ['character']);

		expect(plan.adopting).toEqual([]);
		expect(plan.alreadyAdopted).toBeGreaterThan(0);
	});

	it('leaves a page in a legacy location alone', async () => {
		// Adopting it would give one id a note, a canonical page and a legacy
		// page — making the duplicate harder to resolve, not easier.
		await file(VAULT.inbox + '/sit-900.md', '---\nid: sit-900\n---\n\nLoose.\n');
		const plan = await planAdoption(root, ['situation']);

		expect(plan.proposals.some(p => p.path.includes('sit-900'))).toBe(false);
	});
});

describe('/ingest adopt', () => {
	it('reports what it would adopt, by kind', async () => {
		await authoredPage();
		const result = await run('/ingest adopt faction');

		expect(said(result)).toContain('adopting 1 page(s)');
		expect(result.adopt?.proposals).toHaveLength(2);
	});

	it('names a page it will not touch, and why', async () => {
		await authoredPage();
		await file('raw/factions/the-gnostics.md', 'Mine.\n');

		const output = said(await run('/ingest adopt faction'));
		expect(output).toContain('already exists');
		expect(output).toContain('/ingest faction the-gnostics');
	});

	it('says so plainly when a fresh vault has nothing to adopt', async () => {
		const result = await run('/ingest adopt');

		expect(said(result)).toContain('already cite a note');
		expect(result.adopt).toBeUndefined();
	});

	it('sweeps every kind when none is named', async () => {
		await authoredPage();
		await file('corpus/places/the-moon.md', '---\nid: the-moon\n---\n\nFar side.\n');

		const result = await run('/ingest adopt');
		expect(result.adopt?.proposals).toHaveLength(4);
	});

	it('refuses interview, which has no corpus to adopt from', async () => {
		expect(said(await run('/ingest adopt interview'))).toContain('to adopt');
	});
});

/**
 * A moment's `at` is parsed as a bigint so deep time survives the round trip.
 * The ingest context was built with `JSON.stringify`, and JSON has no bigint —
 * so the first raw note to carry `at:` threw `Do not know how to serialize a
 * BigInt`. The scaffold now seeds exactly such a note.
 */
describe('a note that carries a time', () => {
	it('builds an ingest context instead of throwing', async () => {
		const {documents} = await readRaw(root, 'moment');
		const dated = documents.filter(document => document.data['at'] !== undefined);
		expect(dated.length).toBeGreaterThan(0);

		await expect(
			buildIngest(root, context.project!, 'moment', dated),
		).resolves.toBeDefined();
	});

	it('writes the instant as digits, not as a quoted string', async () => {
		await file(
			'raw/moments/deep.md',
			'---\nid: deep\nat: -31557600000000\n---\n\nBefore.\n',
		);
		const {documents} = await readRaw(root, 'moment', 'deep');

		const {context: block} = await buildIngest(
			root,
			context.project!,
			'moment',
			documents,
		);
		expect(block).toContain('at: -31557600000000');
	});
});
