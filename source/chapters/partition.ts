import type {Chapter} from '../domain/schema.js';
import type {Step} from '../ledger/replay.js';

export type ChapterSpan = {
	readonly chapter: Chapter;
	readonly steps: readonly Step[];
	readonly situations: readonly string[];
};

export type PartitionIssue = {
	readonly kind: 'unknown-start' | 'duplicate-start' | 'out-of-order' | 'empty';
	readonly chapter: string;
	readonly detail: string;
};

export type Partition = {
	readonly spans: readonly ChapterSpan[];
	/** Steps before the first chapter opens. */
	readonly unclaimed: readonly Step[];
	readonly issues: readonly PartitionIssue[];
};

type Resolved = {readonly chapter: Chapter; readonly startIndex: number};

/**
 * A chapter is a cut, not a container (§6 step 6; see the doc comment on
 * `chapterSchema`). `buildSequence` already fixes the reading order, so a
 * span is nothing but the slice between one cut and the next — which is what
 * lets a situation inserted mid-arc land in the right chapter without a
 * chapter file changing: the cut is a situation id, and the slice follows
 * wherever the sequence puts that id.
 *
 * P4: a malformed chapter set must never stop the author writing. Every
 * failure mode below becomes an issue plus a best-effort span rather than a
 * thrown error, and issues are allowed to stack on one chapter — a chapter
 * that opens out of order and ends up with nothing in it gets both.
 */
export function partitionChapters(
	chapters: readonly Chapter[],
	sequence: readonly Step[],
): Partition {
	const issues: PartitionIssue[] = [];

	const startIndexOf = new Map<string, number>();
	sequence.forEach((step, index) => {
		if (step.kind === 'situation') {
			startIndexOf.set(step.id, index);
		}
	});

	// D3: sparse integers, ties broken by id — the same convention arcs use.
	const declared = chapters.toSorted(
		(a, b) => a.order - b.order || a.id.localeCompare(b.id),
	);

	const resolved: Resolved[] = [];
	for (const chapter of declared) {
		const startIndex = startIndexOf.get(chapter.starts_at);
		if (startIndex === undefined) {
			issues.push({
				kind: 'unknown-start',
				chapter: chapter.id,
				detail: `chapter '${chapter.id}' starts_at '${chapter.starts_at}', which is not in the sequence`,
			});
			continue;
		}
		resolved.push({chapter, startIndex});
	}

	// The earliest-declared chapter keeps a contested starts_at; the rest are
	// flagged so the author knows which pages disagree.
	const claimedBy = new Map<string, string>();
	for (const {chapter} of resolved) {
		const owner = claimedBy.get(chapter.starts_at);
		if (owner === undefined) {
			claimedBy.set(chapter.starts_at, chapter.id);
		} else {
			issues.push({
				kind: 'duplicate-start',
				chapter: chapter.id,
				detail: `chapter '${chapter.id}' shares starts_at '${chapter.starts_at}' with chapter '${owner}'`,
			});
		}
	}

	const spans: ChapterSpan[] = [];
	for (const [index, entry] of resolved.entries()) {
		const next = resolved[index + 1];

		if (next && entry.startIndex > next.startIndex) {
			issues.push({
				kind: 'out-of-order',
				chapter: entry.chapter.id,
				detail: `chapter '${entry.chapter.id}' (order ${entry.chapter.order}) opens at '${entry.chapter.starts_at}', after chapter '${next.chapter.id}' (order ${next.chapter.order}) which opens earlier in the sequence at '${next.chapter.starts_at}'`,
			});
		}

		// A declared-later chapter that opens no later in the sequence collapses
		// this span to nothing — the boundary never runs backward.
		const end = next ? Math.max(entry.startIndex, next.startIndex) : sequence.length;
		const steps = sequence.slice(entry.startIndex, end);
		const situations = steps
			.filter(step => step.kind === 'situation')
			.map(step => step.id);

		if (situations.length === 0) {
			issues.push({
				kind: 'empty',
				chapter: entry.chapter.id,
				detail: `chapter '${entry.chapter.id}' contains no situations`,
			});
		}

		spans.push({chapter: entry.chapter, steps, situations});
	}

	const first = resolved[0];
	const unclaimed = first ? sequence.slice(0, first.startIndex) : sequence;

	return {spans, unclaimed, issues};
}
