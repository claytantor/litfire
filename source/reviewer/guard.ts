import {findBlocks} from '../vault/markers.js';
import type {GuardVerdict} from './types.js';

/**
 * The structural guard on `/reviewer` proposals.
 *
 * The reviewer is allowed to correct spelling and grammar and nothing else. That
 * is a constraint, not a preference, so it is checked here rather than asked for
 * in a prompt — a system prompt is a request, and one sloppy generation is all
 * that separates "fix my typos" from "improve my prose". P6 already says the
 * tool never rewrites situation prose; this is the narrow, mechanically-bounded
 * exception the author opted into.
 *
 * What this catches with certainty: any frontmatter change, any change to a
 * number or a wikilink target, any change inside a generated marker region, a
 * change in line count, a word swapped for a differently-shaped word, and any
 * inserted word outside the closed function-word class.
 *
 * The residual gap is precise and worth stating: `isCorrection` always admits an
 * edit distance of 1, because without that escape it would refuse `a` → `an`.
 * So a one-character substitution that changes meaning — `cold` → `bold`, `he` →
 * `she` — reads as a typo fix here and passes. Numbers and links are protected
 * by their own rules; single-character prose swaps are not. The review gate is
 * the backstop, which is why this guard narrows what reaches the author rather
 * than replacing their judgement.
 */

/** A corrected word still resembles the word it corrects. */
export const WORD_SIMILARITY_FLOOR = 0.6;

/** Words added or removed on one line before it counts as restructuring. */
export const MAX_STRUCTURAL_EDITS = 5;

/** …and never more than this share of the line, so short lines stay honest. */
export const MAX_STRUCTURAL_RATIO = 0.25;

/**
 * Splits the literal frontmatter block from the body.
 *
 * Deliberately not `parseDocument`: that returns *parsed* YAML, and two
 * different files can parse to the same object. Byte comparison of the raw
 * block is the stronger claim, and the one worth making about data the ledger
 * replays.
 */
function splitDocument(raw: string): {front: string; body: string} {
	const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
	const normalized = text.replace(/\r\n/g, '\n');

	if (!normalized.startsWith('---\n')) {
		return {front: '', body: normalized};
	}

	const end = normalized.indexOf('\n---', 3);
	if (end === -1) {
		return {front: '', body: normalized};
	}

	const after = normalized.slice(end + 4);
	return {
		front: normalized.slice(0, end + 4),
		body: after.startsWith('\n') ? after.slice(1) : after,
	};
}

/**
 * Damerau-Levenshtein (optimal string alignment) over characters.
 *
 * The transposition case is not a refinement here, it is the point: `teh` →
 * `the` is the most common typo there is, and plain Levenshtein scores a swap
 * as two edits — which refuses the single correction this feature most exists
 * to make. Word alignment above stays plain, because two swapped words are a
 * reordering, not a typo.
 */
function charDistance(a: string, b: string): number {
	const from = [...a];
	const to = [...b];
	if (from.length === 0) {
		return to.length;
	}
	if (to.length === 0) {
		return from.length;
	}

	const grid: number[][] = Array.from({length: from.length + 1}, () =>
		Array.from({length: to.length + 1}, () => 0),
	);
	for (let i = 0; i <= from.length; i++) {
		grid[i]![0] = i;
	}
	for (let j = 0; j <= to.length; j++) {
		grid[0]![j] = j;
	}

	for (let i = 1; i <= from.length; i++) {
		for (let j = 1; j <= to.length; j++) {
			const cost = from[i - 1] === to[j - 1] ? 0 : 1;
			let best = Math.min(
				grid[i]![j - 1]! + 1,
				grid[i - 1]![j]! + 1,
				grid[i - 1]![j - 1]! + cost,
			);
			if (i > 1 && j > 1 && from[i - 1] === to[j - 2] && from[i - 2] === to[j - 1]) {
				best = Math.min(best, grid[i - 2]![j - 2]! + 1);
			}
			grid[i]![j] = best;
		}
	}

	return grid[from.length]![to.length]!;
}

function charSimilarity(a: string, b: string): number {
	if (a === b) {
		return 1;
	}
	const longest = Math.max(a.length, b.length);
	return longest === 0 ? 1 : 1 - charDistance(a, b) / longest;
}

/**
 * Whether one word replacing another reads as a correction.
 *
 * The distance-1 escape matters as much as the ratio: `a` → `an` and `the` →
 * `The` are exactly the fixes this feature is for, and on words that short a
 * ratio alone would refuse them.
 */
function isCorrection(from: string, to: string): boolean {
	if (from.toLowerCase() === to.toLowerCase()) {
		return true;
	}
	if (charDistance(from, to) <= 1) {
		return true;
	}
	return charSimilarity(from.toLowerCase(), to.toLowerCase()) >= WORD_SIMILARITY_FLOOR;
}

/**
 * The closed class of words a grammar fix may add.
 *
 * Inserting `the` is a grammar fix; inserting `cold` is writing. Counting
 * insertions alone cannot tell those apart, and the second is exactly what this
 * feature must never do — so an insertion is allowed only from this list.
 * Closed-class words are a finite set that authors do not invent, which is what
 * makes the rule safe to enforce rather than merely plausible.
 */
const FUNCTION_WORDS = new Set([
	'a',
	'an',
	'the',
	'is',
	'are',
	'was',
	'were',
	'be',
	'been',
	'being',
	'am',
	'do',
	'does',
	'did',
	'has',
	'have',
	'had',
	'will',
	'would',
	'can',
	'could',
	'shall',
	'should',
	'may',
	'might',
	'must',
	'to',
	'of',
	'in',
	'on',
	'at',
	'by',
	'for',
	'from',
	'with',
	'into',
	'onto',
	'over',
	'under',
	'up',
	'down',
	'out',
	'off',
	'through',
	'about',
	'and',
	'or',
	'but',
	'nor',
	'so',
	'yet',
	'as',
	'than',
	'then',
	'if',
	'that',
	'which',
	'who',
	'whom',
	'whose',
	'not',
	'no',
	'it',
	'its',
	"it's",
	'he',
	'she',
	'they',
	'them',
	'his',
	'her',
	'hers',
	'their',
	'theirs',
	'him',
	'i',
	'you',
	'your',
	'yours',
	'we',
	'us',
	'our',
]);

/** Compares words the way a reader would: without case or bounding punctuation. */
function bare(word: string): string {
	return word.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

type LineEdits = {
	readonly substitutions: readonly (readonly [string, string])[];
	readonly inserted: readonly string[];
	readonly removed: readonly string[];
};

/**
 * Aligns two lines word by word and reports what changed.
 *
 * Word-level rather than character-level on purpose: it separates "this word
 * became a similar word" (a correction) from "this word became a different
 * word" (a style edit), which a whole-line similarity score cannot distinguish
 * once the line is long enough to dilute it.
 */
function alignWords(from: readonly string[], to: readonly string[]): LineEdits {
	const rows = from.length;
	const cols = to.length;

	const cost: number[][] = Array.from({length: rows + 1}, () =>
		Array.from({length: cols + 1}, () => 0),
	);
	for (let i = 0; i <= rows; i++) {
		cost[i]![0] = i;
	}
	for (let j = 0; j <= cols; j++) {
		cost[0]![j] = j;
	}
	for (let i = 1; i <= rows; i++) {
		for (let j = 1; j <= cols; j++) {
			const same = from[i - 1] === to[j - 1] ? 0 : 1;
			cost[i]![j] = Math.min(
				cost[i]![j - 1]! + 1,
				cost[i - 1]![j]! + 1,
				cost[i - 1]![j - 1]! + same,
			);
		}
	}

	const substitutions: (readonly [string, string])[] = [];
	const inserted: string[] = [];
	const removed: string[] = [];
	let i = rows;
	let j = cols;

	while (i > 0 || j > 0) {
		const same = i > 0 && j > 0 && from[i - 1] === to[j - 1];
		if (i > 0 && j > 0 && cost[i]![j] === cost[i - 1]![j - 1]! + (same ? 0 : 1)) {
			if (!same) {
				substitutions.push([from[i - 1]!, to[j - 1]!]);
			}
			i--;
			j--;
		} else if (j > 0 && cost[i]![j] === cost[i]![j - 1]! + 1) {
			inserted.push(to[j - 1]!);
			j--;
		} else {
			removed.push(from[i - 1]!);
			i--;
		}
	}

	return {substitutions, inserted, removed};
}

const NUMBER = /\d+(?:[.,]\d+)*/g;
const WIKILINK = /\[\[([^\]]+)\]\]/g;

function numbersIn(text: string): string[] {
	return [...text.matchAll(NUMBER)].map(match => match[0]).toSorted();
}

function linksIn(text: string): string[] {
	return [...text.matchAll(WIKILINK)].map(match => match[1] ?? '').toSorted();
}

function generatedRegions(text: string): string[] {
	return findBlocks(text)
		.map(block => `${block.name}:${block.content}`)
		.toSorted();
}

const refuse = (reason: string, line?: number): GuardVerdict => ({
	ok: false,
	reason,
	line,
});

/**
 * Decides whether `proposed` is a spelling/grammar correction of `existing`.
 *
 * Ordered cheapest and most decisive first, so a refusal names the first thing
 * that actually disqualified the proposal rather than an incidental symptom.
 */
export function guardCorrection(existing: string, proposed: string): GuardVerdict {
	// Defensive rather than theoretical: with no prior text every rule below has
	// nothing to compare against, and a short enough proposal would slip through
	// as "one line, one word added". The reviewer corrects; it never authors.
	if (existing.trim() === '') {
		return refuse('no existing file — the reviewer never creates a file');
	}

	const before = splitDocument(existing);
	const after = splitDocument(proposed);

	if (before.front !== after.front) {
		return refuse('frontmatter changed — the reviewer may not touch data');
	}

	if (
		JSON.stringify(generatedRegions(before.body)) !==
		JSON.stringify(generatedRegions(after.body))
	) {
		return refuse('a generated block changed — regenerate it instead of editing it');
	}

	if (JSON.stringify(numbersIn(before.body)) !== JSON.stringify(numbersIn(after.body))) {
		return refuse('a number changed — that is a story edit, not a correction');
	}

	if (JSON.stringify(linksIn(before.body)) !== JSON.stringify(linksIn(after.body))) {
		return refuse('a wikilink target changed — that would rewire the graph');
	}

	const fromLines = before.body.split('\n');
	const toLines = after.body.split('\n');

	if (fromLines.length !== toLines.length) {
		return refuse(
			`line count changed (${fromLines.length} → ${toLines.length}) — corrections stay in place`,
		);
	}

	let changedLines = 0;

	for (const [index, fromLine] of fromLines.entries()) {
		const toLine = toLines[index] ?? '';
		if (fromLine === toLine) {
			continue;
		}
		changedLines++;

		const fromWords = fromLine.split(/\s+/).filter(word => word !== '');
		const toWords = toLine.split(/\s+/).filter(word => word !== '');
		const {substitutions, inserted, removed} = alignWords(fromWords, toWords);

		for (const [from, to] of substitutions) {
			if (!isCorrection(from, to)) {
				return refuse(`"${from}" → "${to}" is a rewrite, not a correction`, index + 1);
			}
		}

		for (const word of inserted) {
			if (!FUNCTION_WORDS.has(bare(word))) {
				return refuse(
					`"${word}" was added — that is writing, not a correction`,
					index + 1,
				);
			}
		}

		// A removal is allowed for a function word, or for a word the original
		// repeated — the doubled-word fix, where the removed token can be anything.
		const doubled = new Set(
			fromWords
				.map(word => bare(word))
				.filter((word, at, all) => word !== '' && all.indexOf(word) !== at),
		);
		for (const word of removed) {
			if (!FUNCTION_WORDS.has(bare(word)) && !doubled.has(bare(word))) {
				return refuse(
					`"${word}" was removed — that is writing, not a correction`,
					index + 1,
				);
			}
		}

		const structural = inserted.length + removed.length;
		const allowance = Math.min(
			MAX_STRUCTURAL_EDITS,
			Math.max(1, Math.floor(fromWords.length * MAX_STRUCTURAL_RATIO)),
		);
		if (structural > allowance) {
			return refuse(
				`${structural} words added or removed (limit ${allowance}) — that restructures the line`,
				index + 1,
			);
		}
	}

	if (changedLines === 0) {
		return refuse('nothing changed');
	}

	return {ok: true, changedLines};
}
