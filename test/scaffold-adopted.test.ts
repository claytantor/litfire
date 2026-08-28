import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject} from '../source/core/project.js';
import {INGEST_KINDS, readRaw} from '../source/ingest/index.js';
import {readIngestState, statusOf} from '../source/ingest/state.js';
import {parseDocument} from '../source/vault/frontmatter.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-scaffold-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

const read = (relative: string) => readFile(path.join(root, relative), 'utf8');
const exists = (relative: string) =>
	read(relative).then(
		() => true,
		() => false,
	);

/**
 * `/init` used to seed the corpus and nothing else, which under raw-first meant
 * a fresh vault's example content was exactly what the author is no longer
 * meant to edit, with no note to regenerate it from. It now seeds both layers
 * at once, already stamped — so the scaffold demonstrates the loop instead of
 * standing outside it.
 */
describe('a fresh vault is already adopted', () => {
	it('writes every seed to raw and to the corpus', async () => {
		await scaffoldVault(root);

		for (const [raw, page] of [
			['raw/systems/system-01.md', 'corpus/systems/system-01.md'],
			['raw/moments/we-001.md', 'corpus/moments/we-001.md'],
			['raw/arcs/arc-01.md', 'corpus/arcs/arc-01.md'],
			['raw/characters/protagonist.md', 'corpus/characters/protagonist.md'],
			['raw/themes/commodification.md', 'corpus/themes/commodification.md'],
			['raw/situations/sit-001.md', 'corpus/situations/sit-001.md'],
		]) {
			expect(await exists(raw!), raw).toBe(true);
			expect(await exists(page!), page).toBe(true);
		}
	});

	it('leaves ingest with nothing to do', async () => {
		await scaffoldVault(root);

		for (const kind of INGEST_KINDS) {
			const state = await readIngestState(root, kind);
			const {documents} = await readRaw(root, kind);
			for (const document of documents) {
				expect(statusOf(state, document.path, document.contents), document.path).toBe(
					'unchanged',
				);
			}
		}
	});

	it('points each page at the note it came from', async () => {
		await scaffoldVault(root);
		const {data} = parseDocument(await read('corpus/characters/protagonist.md'));

		expect(data['source']).toBe('raw/characters/protagonist.md');
		expect(data['source_hash']).toEqual(expect.any(String));
	});

	it('keeps provenance out of the note itself', async () => {
		await scaffoldVault(root);
		const {data} = parseDocument(await read('raw/characters/protagonist.md'));

		// The note is the record. A hash of itself, stamped inside itself, would
		// never match — and raw is not where the tool keeps its bookkeeping.
		expect(data['source']).toBeUndefined();
		expect(data['source_hash']).toBeUndefined();
	});
});

describe('what /init no longer creates', () => {
	it('writes no file it cannot write', async () => {
		// `timeline/moments` was seeded as a *file* at a path already created as a
		// directory: the write threw EEXIST and was filed under `skipped`, so the
		// seed had never once landed.
		const {skipped} = await scaffoldVault(root);
		expect(skipped).toEqual([]);
	});

	it('leaves the superseded system layout alone', async () => {
		await scaffoldVault(root);

		for (const legacy of [VAULT.stats, VAULT.legacySkills, VAULT.curves]) {
			expect(await exists(legacy), legacy).toBe(false);
		}
		// The shared formula file is not legacy — it is deliberately unscoped, the
		// escape hatch for a rule that genuinely applies to every system.
		expect(await exists(VAULT.formulas)).toBe(true);
	});

	it('does not recreate the inbox', async () => {
		await scaffoldVault(root);
		expect(await exists(VAULT.inbox)).toBe(false);
	});

	it('loads with no legacy file and no issue', async () => {
		await scaffoldVault(root);
		const project = await computeProject(root);

		expect(project.vault.legacy).toEqual([]);
		expect(project.vault.issues).toEqual([]);
		expect(project.questions.filter(q => q.kind === 'legacy_location')).toEqual([]);
	});

	it('still resolves one system, without needing it named', async () => {
		await scaffoldVault(root);
		const project = await computeProject(root);

		// Not `system`: that stem already belongs to the setting page, and two
		// files answering one `[[system]]` is an ambiguity Obsidian inherits.
		expect(project.vault.systems.map(s => s.id)).toEqual(['system-01']);
		expect(project.vault.systems[0]?.stats.length).toBeGreaterThan(0);
	});

	it('seeds moments as pages, not as the single-file list', async () => {
		await scaffoldVault(root);
		const project = await computeProject(root);

		expect(await exists(VAULT.legacyMoments)).toBe(false);
		expect(project.vault.moments.map(m => m.id)).toEqual(['we-001', 'we-002']);
		expect(project.vault.moments[0]?.at).toBe(0n);
	});
});
