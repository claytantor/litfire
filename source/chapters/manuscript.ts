import type {Situation} from '../domain/schema.js';
import {findBlocks} from '../vault/markers.js';
import type {Partition} from './partition.js';

/**
 * Renders the assembled manuscript (§6 step 6).
 *
 * Scene prose is copied, never rewritten — P6 holds through assembly. The
 * manuscript is a *derived* artifact in the same sense `ledger/state.md` is:
 * regenerated wholesale from the corpus, never edited in place, and never the
 * source of truth for a single word it contains.
 *
 * Connective text lives in the chapter file rather than between the scenes it
 * joins, because the scenes are author-owned files the tool must not touch. A
 * transition is positioned by a marker naming the situation it follows:
 *
 * ```
 * <!-- litrpg:transition after=sit-001 -->
 * Three days passed before the summons came.
 * <!-- /litrpg:transition -->
 * ```
 *
 * That is the D1 marker syntax already committed to in vault/markers.ts, which
 * means a transition is an ordinary reviewable file write rather than a new
 * format nobody else understands.
 */

export const GENERATED_BANNER =
	'> [!warning] Generated file\n> Assembled by litfire from `chapters/` and `situations/`. Edit those, not this.';

export type ManuscriptInput = {
	readonly partition: Partition;
	readonly situations: readonly Situation[];
	/** Situation id → prose body, frontmatter already stripped. */
	readonly bodies: ReadonlyMap<string, string>;
	/** Chapter id → the chapter file's body, which carries the transitions. */
	readonly chapterBodies: ReadonlyMap<string, string>;
	readonly title: string;
};

/** Transitions in one chapter body, keyed by the situation each follows. */
export function transitionsIn(chapterBody: string): Map<string, string> {
	const found = new Map<string, string>();

	for (const block of findBlocks(chapterBody)) {
		if (block.name !== 'transition') {
			continue;
		}
		const after = block.attributes['after'];
		if (after !== undefined && block.content.trim() !== '') {
			found.set(after, block.content.trim());
		}
	}

	return found;
}

function heading(index: number, title: string | undefined): string {
	return title === undefined || title.trim() === ''
		? `## ${index}`
		: `## ${index}. ${title}`;
}

export function renderManuscript(input: ManuscriptInput): string {
	const titles = new Map(
		input.situations.map(situation => [situation.id, situation.title]),
	);
	const parts: string[] = [`# ${input.title}`, '', GENERATED_BANNER];

	for (const [index, span] of input.partition.spans.entries()) {
		const transitions = transitionsIn(input.chapterBodies.get(span.chapter.id) ?? '');
		parts.push('', heading(index + 1, span.chapter.title));

		for (const id of span.situations) {
			const body = input.bodies.get(id)?.trim() ?? '';

			// A placed situation with nothing written yet is called out rather than
			// silently skipped: an author assembling a draft needs to see the hole.
			parts.push(
				'',
				body === '' ? `_[${titles.get(id) ?? id} — not written yet]_` : body,
			);

			const transition = transitions.get(id);
			if (transition !== undefined) {
				parts.push('', transition);
			}
		}
	}

	// Unclaimed scenes are appended under their own heading rather than dropped.
	// Losing a scene from the manuscript because no chapter opened early enough
	// is exactly the silent failure assembly exists to prevent.
	const unclaimed = input.partition.unclaimed.filter(step => step.kind === 'situation');
	if (unclaimed.length > 0) {
		parts.push('', '## Not yet in a chapter');
		for (const step of unclaimed) {
			const body = input.bodies.get(step.id)?.trim() ?? '';
			parts.push('', body === '' ? `_[${titles.get(step.id) ?? step.id}]_` : body);
		}
	}

	return `${parts.join('\n')}\n`;
}
