import {describe, expect, it} from 'vitest';
import {resolveTargets} from '../source/editor/targets.js';
import type {CorpusEntry, CorpusMap} from '../source/editor/types.js';

const entry = (
	path: string,
	id: string,
	frontmatter: Record<string, unknown> = {},
): CorpusEntry => ({
	path,
	kind: path.split('/')[0] ?? '',
	id,
	title: undefined,
	chars: 100,
	frontmatter,
});

const map: CorpusMap = {
	entries: [
		entry('situations/sit-901.md', 'sit-901', {arc: 'arc-90'}),
		entry('situations/sit-902.md', 'sit-902', {arc: 'arc-90'}),
		entry('situations/sit-903.md', 'sit-903', {arc: 'arc-91'}),
		entry('characters/carl.md', 'carl'),
		entry('themes/debt.md', 'debt'),
	],
	openQuestions: [],
	examplesSkipped: 0,
};

describe('resolveTargets', () => {
	it('takes the whole corpus and flags it as such', () => {
		const selection = resolveTargets(map, 'everything');

		expect(selection.paths).toHaveLength(5);
		expect(selection.whole).toBe(true);
	});

	it('resolves a single id', () => {
		const selection = resolveTargets(map, 'sit-902');

		expect(selection.paths).toEqual(['situations/sit-902.md']);
		expect(selection.whole).toBe(false);
	});

	it('resolves every situation in an arc', () => {
		const selection = resolveTargets(map, 'arc-90');

		expect(selection.paths).toEqual(['situations/sit-901.md', 'situations/sit-902.md']);
	});

	/**
	 * The bug this pins: an arc file carries `id: arc-90` and its scenes carry
	 * `arc: arc-90`. Matching the id first made `fix arc-90` select the arc's own
	 * page and none of its scenes.
	 */
	it('an arc id means the arc AND everything in it', () => {
		const withArcFile: CorpusMap = {
			...map,
			entries: [...map.entries, entry('timeline/arcs/arc-90.md', 'arc-90')],
		};

		const selection = resolveTargets(withArcFile, 'arc-90');

		expect(selection.paths).toEqual([
			'situations/sit-901.md',
			'situations/sit-902.md',
			'timeline/arcs/arc-90.md',
		]);
	});

	it('falls back to a path match', () => {
		expect(resolveTargets(map, 'characters').paths).toEqual(['characters/carl.md']);
	});

	/** An id must not be shadowed by a directory that happens to contain the word. */
	it('prefers an exact id over a path substring', () => {
		const selection = resolveTargets(map, 'carl');
		expect(selection.paths).toEqual(['characters/carl.md']);
	});

	it('is case-insensitive', () => {
		expect(resolveTargets(map, 'SIT-901').paths).toEqual(['situations/sit-901.md']);
	});

	/**
	 * The expensive failure mode: a near-match that silently proofreads the wrong
	 * forty scenes. An empty selection the author can retype is strictly better.
	 */
	it('returns nothing rather than guessing', () => {
		expect(resolveTargets(map, 'sit-9').paths).toEqual([]);
		expect(resolveTargets(map, 'nonsense').paths).toEqual([]);
	});

	it('treats an empty spec as no selection', () => {
		expect(resolveTargets(map, '   ').paths).toEqual([]);
	});
});
