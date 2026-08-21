import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	ReviewBatch,
	diffStat,
	renderDiff,
	resolveInsideVault,
	UnsafePathError,
	type Proposal,
} from '../source/review/index.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-rev-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
	path: 'characters/donut.md',
	contents: '---\nid: donut\n---\n\n# Donut\n',
	...over,
});

/**
 * Proposal paths come from a model, so this is the security boundary of the
 * whole gate — the same class of check as the formula sandbox.
 */
describe('resolveInsideVault', () => {
	it('accepts an ordinary vault-relative markdown path', () => {
		expect(resolveInsideVault(root, 'characters/protagonist.md')).toBe(
			path.join(root, 'characters/protagonist.md'),
		);
	});

	const rejected: [string, string][] = [
		['../escape.md', 'parent traversal'],
		['../../etc/passwd.md', 'deep traversal'],
		['characters/../../outside.md', 'traversal after a valid segment'],
		['/etc/passwd.md', 'absolute path'],
		['', 'empty path'],
		['.litrpg/config.md', 'tool-owned cache'],
		['ledger/state.md', 'derived output'],
		['raw/notes.md', 'author-owned input'],
		['system/stats.txt', 'non-markdown'],
	];

	for (const [candidate, why] of rejected) {
		it(`rejects ${why}: ${candidate || '(empty)'}`, () => {
			expect(() => resolveInsideVault(root, candidate)).toThrow(UnsafePathError);
		});
	}

	it('lands a sneaky path where it actually points, not where it is spelled', () => {
		// `a/../b.md` is legitimate and resolves inside; the guard must allow it
		// rather than string-matching on '..'.
		expect(resolveInsideVault(root, 'system/../themes/x.md')).toBe(
			path.join(root, 'themes/x.md'),
		);
	});
});

describe('diff rendering', () => {
	it('renders a new file as all additions', async () => {
		const batch = await ReviewBatch.create(root, [proposal()]);
		const lines = renderDiff(batch.items[0]!);

		expect(lines.some(l => l.text.startsWith('@@'))).toBe(true);
		expect(lines.filter(l => l.text.startsWith('+')).length).toBeGreaterThan(0);
		expect(lines.filter(l => l.text.startsWith('-'))).toHaveLength(0);
	});

	it('shows both sides when the file already exists', async () => {
		await scaffoldVault(root);
		const batch = await ReviewBatch.create(root, [
			proposal({
				path: 'corpus/characters/protagonist.md',
				contents: '---\nid: carl\n---\n\n# Protagonist\n\nRewritten.\n',
			}),
		]);

		const stat = diffStat(batch.items[0]!);
		expect(stat.added).toBeGreaterThan(0);
		expect(stat.removed).toBeGreaterThan(0);
	});

	it('colours additions and removals differently', async () => {
		await scaffoldVault(root);
		const batch = await ReviewBatch.create(root, [
			proposal({path: 'characters/protagonist.md', contents: 'totally different\n'}),
		]);

		const lines = renderDiff(batch.items[0]!);
		const add = lines.find(l => l.text.startsWith('+'));
		const remove = lines.find(l => l.text.startsWith('-'));
		expect(add?.color).not.toBe(remove?.color);
	});
});

describe('ReviewBatch decisions', () => {
	const three = [
		proposal({path: 'characters/a.md'}),
		proposal({path: 'characters/b.md'}),
		proposal({path: 'characters/c.md'}),
	];

	it('starts every item pending', async () => {
		const batch = await ReviewBatch.create(root, three);
		expect(batch.counts()).toEqual({pending: 3, accepted: 0, rejected: 0});
		expect(batch.settled).toBe(false);
	});

	it('advances to the next pending item after a decision', async () => {
		const batch = await ReviewBatch.create(root, three);

		batch.decide('accepted');
		expect(batch.cursor).toBe(1);
		batch.decide('rejected');
		expect(batch.cursor).toBe(2);
		expect(batch.counts()).toEqual({pending: 1, accepted: 1, rejected: 1});
	});

	it('accept-all only touches items still pending', async () => {
		const batch = await ReviewBatch.create(root, three);
		batch.decide('rejected'); // a is rejected on purpose

		batch.acceptAllPending();

		expect(batch.counts()).toEqual({pending: 0, accepted: 2, rejected: 1});
		expect(batch.items[0]?.decision).toBe('rejected');
		expect(batch.settled).toBe(true);
	});

	it('records a hand edit and flags it', async () => {
		const batch = await ReviewBatch.create(root, [proposal()]);

		batch.edit('---\nid: donut\n---\n\n# Donut\n\nHand written.\n');

		expect(batch.items[0]?.edited).toBe(true);
		expect(batch.items[0]?.contents).toContain('Hand written');
	});

	it('does not flag an edit that changed nothing', async () => {
		const p = proposal();
		const batch = await ReviewBatch.create(root, [p]);

		batch.edit(p.contents);

		expect(batch.items[0]?.edited).toBe(false);
	});
});

describe('applying a batch', () => {
	it('writes only accepted items', async () => {
		const batch = await ReviewBatch.create(root, [
			proposal({path: 'characters/keep.md', contents: 'kept\n'}),
			proposal({path: 'characters/drop.md', contents: 'dropped\n'}),
		]);

		batch.decide('accepted');
		batch.decide('rejected');
		const outcome = await batch.apply();

		expect(outcome.written).toEqual(['characters/keep.md']);
		expect(outcome.skipped).toEqual(['characters/drop.md']);
		expect(await readFile(path.join(root, 'characters/keep.md'), 'utf8')).toBe('kept\n');
		await expect(
			readFile(path.join(root, 'characters/drop.md'), 'utf8'),
		).rejects.toThrow();
	});

	it('never writes a pending item — nothing lands without a decision', async () => {
		const batch = await ReviewBatch.create(root, [proposal()]);

		const outcome = await batch.apply();

		expect(outcome.written).toHaveLength(0);
		expect(outcome.skipped).toEqual(['characters/donut.md']);
	});

	it('writes the edited contents, not the original proposal', async () => {
		const batch = await ReviewBatch.create(root, [
			proposal({path: 'characters/donut.md', contents: 'original\n'}),
		]);

		batch.edit('edited by hand\n');
		batch.decide('accepted');
		await batch.apply();

		expect(await readFile(path.join(root, 'characters/donut.md'), 'utf8')).toBe(
			'edited by hand\n',
		);
	});

	it('creates missing parent directories', async () => {
		const batch = await ReviewBatch.create(root, [
			proposal({path: 'timeline/arcs/arc-02.md', contents: 'arc\n'}),
		]);
		batch.decide('accepted');

		const outcome = await batch.apply();

		expect(outcome.written).toEqual(['timeline/arcs/arc-02.md']);
	});

	it('reports an unsafe path as a failure instead of escaping the vault', async () => {
		const outside = path.join(root, '..', 'ESCAPED.md');
		const batch = await ReviewBatch.create(root, [
			proposal({path: '../ESCAPED.md', contents: 'pwned\n'}),
		]);
		batch.decide('accepted');

		const outcome = await batch.apply();

		expect(outcome.written).toHaveLength(0);
		expect(outcome.failed[0]?.reason).toContain('escapes the vault');
		await expect(readFile(outside, 'utf8')).rejects.toThrow();
	});

	it('validatePaths surfaces bad proposals before the author reviews them', async () => {
		const batch = await ReviewBatch.create(root, [
			proposal(),
			proposal({path: '../bad.md'}),
			proposal({path: 'ledger/state.md'}),
		]);

		const problems = batch.validatePaths();

		expect(problems.map(p => p.path)).toEqual(['../bad.md', 'ledger/state.md']);
	});

	it('applies one bad item without losing the good ones', async () => {
		const batch = await ReviewBatch.create(root, [
			proposal({path: 'characters/good.md', contents: 'fine\n'}),
			proposal({path: '../bad.md', contents: 'nope\n'}),
		]);
		batch.acceptAllPending();

		const outcome = await batch.apply();

		expect(outcome.written).toEqual(['characters/good.md']);
		expect(outcome.failed).toHaveLength(1);
	});

	it('overwrites an existing file only once accepted', async () => {
		await scaffoldVault(root);
		const before = await readFile(
			path.join(root, 'corpus/characters/protagonist.md'),
			'utf8',
		);
		const batch = await ReviewBatch.create(root, [
			proposal({path: 'corpus/characters/protagonist.md', contents: 'replaced\n'}),
		]);

		await batch.apply(); // still pending
		expect(
			await readFile(path.join(root, 'corpus/characters/protagonist.md'), 'utf8'),
		).toBe(before);

		batch.decide('accepted');
		await batch.apply();
		expect(
			await readFile(path.join(root, 'corpus/characters/protagonist.md'), 'utf8'),
		).toBe('replaced\n');
	});

	it('shows the real prior contents in the diff when a file exists', async () => {
		await writeFile(path.join(root, 'existing.md'), 'first line\n', 'utf8');
		const batch = await ReviewBatch.create(root, [
			proposal({path: 'existing.md', contents: 'second line\n'}),
		]);

		expect(batch.items[0]?.existing).toBe('first line\n');
	});
});
