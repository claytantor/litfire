import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject} from '../source/core/project.js';
import {momentSchema} from '../source/domain/schema.js';
import {ReviewBatch} from '../source/review/index.js';
import {stringifyDocument} from '../source/vault/frontmatter.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-remove-'));
	await scaffoldVault(root, 'arcane');
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

const exists = async (relative: string) =>
	readFile(path.join(root, relative), 'utf8').then(
		() => true,
		() => false,
	);

async function moment(id: string, data: Record<string, unknown> = {}) {
	await mkdir(resolve(root, VAULT.moments), {recursive: true});
	await writeFile(
		resolve(root, VAULT.moments, `${id}.md`),
		stringifyDocument({data: momentSchema.parse({id, ...data}), body: '\nProse.\n'}),
		'utf8',
	);
}

describe('removing a file through the gate', () => {
	const target = 'timeline/moments/duplicate.md';

	it('deletes it once accepted', async () => {
		await moment('duplicate');
		const batch = await ReviewBatch.create(root, [
			{path: target, contents: '', remove: true},
		]);

		batch.decide('accepted');
		const outcome = await batch.apply();

		expect(outcome.removed).toEqual([target]);
		expect(outcome.written).toEqual([]);
		expect(await exists(target)).toBe(false);
	});

	/** P3: a removal is a decision like any other, and pending is not one. */
	it('leaves the file alone when rejected or left pending', async () => {
		await moment('duplicate');

		const rejected = await ReviewBatch.create(root, [
			{path: target, contents: '', remove: true},
		]);
		rejected.decide('rejected');
		await rejected.apply();
		expect(await exists(target)).toBe(true);

		const pending = await ReviewBatch.create(root, [
			{path: target, contents: '', remove: true},
		]);
		await pending.apply();
		expect(await exists(target)).toBe(true);
	});

	it('shows the whole file coming out, not an empty panel', async () => {
		await moment('duplicate');
		const batch = await ReviewBatch.create(root, [
			{path: target, contents: 'ignored', remove: true},
		]);

		const item = batch.items[0]!;
		// Whatever contents came with the proposal are discarded: what is being
		// decided is the deletion, and the diff has to show that.
		expect(item.contents).toBe('');
		expect(item.existing).toContain('id: duplicate');
	});

	it('reports a removal that finds nothing there, rather than claiming success', async () => {
		const batch = await ReviewBatch.create(root, [
			{path: 'timeline/moments/never-existed.md', contents: '', remove: true},
		]);
		batch.decide('accepted');
		const outcome = await batch.apply();

		expect(outcome.removed).toEqual([]);
		expect(outcome.failed).toHaveLength(1);
	});

	/**
	 * The architect may propose into `raw/` (D15). Nothing else may, and the
	 * permission belongs to the batch rather than to the proposal — otherwise a
	 * proposal could grant itself the right to rewrite a transcript.
	 */
	it('keeps raw/ closed to every batch that was not opened to it', async () => {
		const closed = await ReviewBatch.create(root, [
			{path: 'raw/interview.md', contents: 'rewritten'},
		]);
		closed.decide('accepted');
		const refused = await closed.apply();

		expect(refused.written).toEqual([]);
		expect(refused.failed[0]?.reason).toContain('not author-writable');

		const opened = await ReviewBatch.create(
			root,
			[{path: 'raw/interview.md', contents: 'corrected'}],
			{allowRaw: true},
		);
		opened.decide('accepted');
		const applied = await opened.apply();

		expect(applied.written).toEqual(['raw/interview.md']);
	});

	it('never opens the derived directories, even to the architect', async () => {
		for (const derived of ['ledger/index.md', 'wiki/index.md', '.litrpg/state.md']) {
			const batch = await ReviewBatch.create(root, [{path: derived, contents: 'x'}], {
				allowRaw: true,
			});
			batch.decide('accepted');
			const outcome = await batch.apply();

			expect(outcome.written, derived).toEqual([]);
			expect(outcome.failed, derived).toHaveLength(1);
		}
	});

	it('refuses to remove what the author owns or the tool derives', async () => {
		// The same path rules a write passes. A removal naming these is worse.
		for (const forbidden of [
			'raw/interview.md',
			'ledger/index.md',
			'wiki/index.md',
			'../escape.md',
		]) {
			const batch = await ReviewBatch.create(root, [
				{path: forbidden, contents: '', remove: true},
			]);
			batch.decide('accepted');
			const outcome = await batch.apply();

			expect(outcome.removed).toEqual([]);
			expect(outcome.failed).toHaveLength(1);
		}
	});

	it('removes and writes in one batch, reported separately', async () => {
		await moment('duplicate');
		const batch = await ReviewBatch.create(root, [
			{path: target, contents: '', remove: true},
			{path: 'timeline/moments/kept.md', contents: '---\nid: kept\n---\n\nProse.\n'},
		]);
		batch.acceptAllPending();
		const outcome = await batch.apply();

		expect(outcome.removed).toEqual([target]);
		expect(outcome.written).toEqual(['timeline/moments/kept.md']);
		expect(await exists(target)).toBe(false);
		expect(await exists('timeline/moments/kept.md')).toBe(true);
	});
});

describe('pages claiming to be the same thing', () => {
	it('reports two pages sharing an id', async () => {
		await mkdir(resolve(root, VAULT.moments), {recursive: true});
		// Distinct filenames, same declared id — everything that resolves it sees
		// only one, and the other is invisible while still on disk.
		for (const file of ['one.md', 'two.md']) {
			await writeFile(
				resolve(root, VAULT.moments, file),
				'---\nid: the-breach\n---\n\nProse.\n',
				'utf8',
			);
		}

		const project = await computeProject(root);
		const finding = project.questions.find(q => q.kind === 'duplicate_id');

		expect(finding?.detail).toContain('the-breach');
		// Named, not counted: "two of these somewhere" is a fact you then have to
		// go hunting for.
		expect(finding?.detail).toContain('one.md');
		expect(finding?.detail).toContain('two.md');
	});

	/**
	 * The reported case: two extraction passes slug one event two ways. The ids
	 * differ, so no id check would ever catch it.
	 */
	it('reports two pages sharing a name under different ids', async () => {
		await moment('inannas-first-memory', {name: "Inanna's First Memory"});
		await moment('the-first-memory', {name: "Inanna's First Memory"});

		const project = await computeProject(root);
		const finding = project.questions.find(q => q.kind === 'duplicate_name');

		expect(finding?.detail).toContain('inannas-first-memory');
		expect(finding?.detail).toContain('the-first-memory');
		expect(finding?.detail).toContain('same thing written twice');
	});

	/**
	 * Two files under one id are already `duplicate_id`. Reporting them again as
	 * a name clash produced "situations sit-001, sit-001 share one name", which
	 * reads as a bug in the tool rather than a fact about the vault.
	 */
	it('does not also report a shared name when the ids are the same', async () => {
		await mkdir(resolve(root, VAULT.moments), {recursive: true});
		for (const file of ['one.md', 'two.md']) {
			await writeFile(
				resolve(root, VAULT.moments, file),
				'---\nid: the-breach\nname: The Breach\n---\n\nProse.\n',
				'utf8',
			);
		}

		const project = await computeProject(root);
		const kinds = project.questions.map(q => q.kind);

		expect(kinds).toContain('duplicate_id');
		expect(kinds).not.toContain('duplicate_name');
	});

	it('matches names case-insensitively and ignoring surrounding space', async () => {
		await moment('one', {name: 'The Breach'});
		await moment('two', {name: '  the breach '});

		const project = await computeProject(root);
		expect(project.questions.map(q => q.kind)).toContain('duplicate_name');
	});

	it('says nothing when names genuinely differ', async () => {
		await moment('one', {name: 'The Breach'});
		await moment('two', {name: 'The Aftermath'});

		const project = await computeProject(root);
		const kinds = project.questions.map(q => q.kind);
		expect(kinds).not.toContain('duplicate_name');
		expect(kinds).not.toContain('duplicate_id');
	});

	it('does not treat unnamed pages as sharing a name', async () => {
		await moment('one');
		await moment('two');

		const project = await computeProject(root);
		expect(project.questions.map(q => q.kind)).not.toContain('duplicate_name');
	});
});
