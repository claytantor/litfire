import type {Project} from '../core/project.js';
import {buildWiki} from './build.js';
import type {Wiki, WikiPage} from './types.js';

/**
 * The wiki as agent grounding (§9).
 *
 * Added to the existing grounding rather than replacing it: the corpus carries
 * the author's own words, and a computed summary must never stand in for how
 * they actually wrote a scene. What this adds is the half the prose cannot say
 * — that a skill was acquired at `sit-014`, that two characters have shared
 * eight scenes — which is exactly the kind of fact an interviewer needs to press
 * on a contradiction instead of re-asking something already established.
 *
 * Built in memory from the same `buildWiki` that writes `wiki/`, rather than
 * parsed back out of the markdown it produced. Re-reading our own generated
 * output would couple grounding to a rendering format and go quietly stale
 * whenever the corpus changed without a rebuild.
 */

/** Bounded so the cross-reference cannot crowd out the corpus it annotates. */
const DEFAULT_BUDGET = 3_000;

export type WikiBriefingOptions = {
	readonly budget?: number;
	/** Ids to put first — the character under interview, scenes in question. */
	readonly focus?: readonly string[];
};

function relevance(page: WikiPage, focus: ReadonlySet<string>): number {
	if (focus.size === 0) {
		return 0;
	}
	if (focus.has(page.id)) {
		return 2;
	}
	// A page whose summary names something in focus is still worth lifting: it is
	// how a character's page surfaces when the question was about a place.
	return [...focus].some(id => page.summary.toLowerCase().includes(id.toLowerCase()))
		? 1
		: 0;
}

/**
 * A compact block of computed facts, highest-relevance first.
 *
 * Summaries only. A full wiki page is long and mostly restates what the corpus
 * files already in context say; the summary line is the part that is genuinely
 * new information per token.
 */
export function wikiBriefing(wiki: Wiki, options: WikiBriefingOptions = {}): string {
	const budget = options.budget ?? DEFAULT_BUDGET;
	const focus = new Set(options.focus ?? []);

	const pages = wiki.pages
		.filter(page => page.kind !== 'index' && page.summary.trim() !== '')
		.toSorted(
			(a, b) =>
				relevance(b, focus) - relevance(a, focus) ||
				a.kind.localeCompare(b.kind) ||
				a.id.localeCompare(b.id),
		);

	const lines: string[] = [];
	let used = 0;
	let dropped = 0;

	for (const page of pages) {
		const line = `- ${page.title} (${page.kind}) — ${page.summary}`;
		if (used + line.length > budget) {
			dropped += 1;
			continue;
		}
		lines.push(line);
		used += line.length;
	}

	if (lines.length === 0) {
		return '';
	}

	// Saying what was left out matters: an interviewer that believes it has seen
	// the whole cast will assert things about a character it was never shown.
	if (dropped > 0) {
		lines.push(`- (${dropped} further entries not shown)`);
	}

	return [
		'## Wiki — computed cross-reference',
		'',
		'Derived from the corpus and the replayed ledger. These are facts the tool',
		'computed, not things the author wrote; treat them as true and do not',
		're-ask what they already establish.',
		'',
		...lines,
	].join('\n');
}

/** Convenience for callers that hold a `Project` rather than a built `Wiki`. */
export function wikiBriefingFor(
	project: Project,
	options: WikiBriefingOptions = {},
): string {
	return wikiBriefing(buildWiki(project), options);
}
