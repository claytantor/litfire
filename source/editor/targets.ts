import type {CorpusEntry, CorpusMap} from './types.js';

export type TargetSelection = {
	readonly paths: readonly string[];
	/** How the selection is described back to the author. */
	readonly label: string;
	/** True when the author asked for the whole corpus, which warrants a warning. */
	readonly whole: boolean;
};

const WHOLE_CORPUS = new Set(['everything', 'all', 'the whole corpus', 'the corpus']);

function frontmatterValue(entry: CorpusEntry, key: string): string | undefined {
	const value = entry.frontmatter[key];
	return typeof value === 'string' ? value : undefined;
}

/**
 * Turns `fix arc-02` or `fix sit-014` into the files a correction pass will read.
 *
 * Deliberately not a fuzzy search. A correction pass costs tokens and produces a
 * review queue, so "I matched something close to what you typed" is the wrong
 * behaviour — an empty selection the author can retype beats silently
 * proofreading the wrong forty scenes.
 */
export function resolveTargets(map: CorpusMap, spec: string): TargetSelection {
	const wanted = spec.trim().toLowerCase();

	if (wanted === '') {
		return {paths: [], label: '', whole: false};
	}

	if (WHOLE_CORPUS.has(wanted)) {
		return {
			paths: map.entries.map(entry => entry.path).toSorted(),
			label: 'the whole corpus',
			whole: true,
		};
	}

	const byId = map.entries.filter(entry => entry.id?.toLowerCase() === wanted);
	const byArc = map.entries.filter(
		entry => frontmatterValue(entry, 'arc')?.toLowerCase() === wanted,
	);

	// Unioned rather than id-first. An arc file carries `id: arc-90` and its
	// scenes carry `arc: arc-90`, so matching the id alone made `fix arc-90`
	// proofread the arc's own page and none of the forty scenes in it — the
	// opposite of what the words mean.
	if (byId.length > 0 || byArc.length > 0) {
		const paths = [...new Set([...byId, ...byArc].map(entry => entry.path))].toSorted();
		return {
			paths,
			label:
				byArc.length > 0
					? `${paths.length} file(s) in ${wanted}`
					: (byId[0]?.id ?? wanted),
			whole: false,
		};
	}

	// Path match last, so a directory name never shadows a file that is actually
	// called that. Whole segments only — a substring test would let `sit-9` quietly
	// select every scene from 900 to 999, which is the expensive mistake this
	// function exists to avoid.
	const byPath = map.entries.filter(entry => {
		const lowered = entry.path.toLowerCase();
		return lowered === wanted || lowered.replace(/\.md$/, '').split('/').includes(wanted);
	});
	if (byPath.length > 0) {
		return {
			paths: byPath.map(entry => entry.path).toSorted(),
			label: byPath.length === 1 ? (byPath[0]?.path ?? wanted) : `${byPath.length} files`,
			whole: false,
		};
	}

	return {paths: [], label: '', whole: false};
}
