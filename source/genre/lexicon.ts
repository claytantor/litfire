import type {Lexicon, ResolvedProfile} from './types.js';

/** Fallbacks used when a profile leaves a key unset. */
const NEUTRAL: Required<Lexicon> = {
	resource: 'resource',
	resource_plural: 'resources',
	ability: 'ability',
	ability_group: 'ability group',
	artifact: 'artifact',
	artifact_plural: 'artifacts',
	role: 'role',
	space: 'area',
	threat: 'threat',
	upgrade: 'upgrade',
	currency: 'currency',
	advancement: 'level',
};

export type LexiconKey = keyof Lexicon;

/**
 * The canonical keys, at runtime, for `/idiom set` to validate against.
 *
 * Derived from `NEUTRAL` rather than written out again: it is typed
 * `Required<Lexicon>`, so adding a key to the schema without adding it here
 * fails to compile. A hand-maintained second list would silently drift.
 */
export const LEXICON_KEYS: readonly LexiconKey[] = Object.keys(NEUTRAL) as LexiconKey[];

export function isLexiconKey(value: string): value is LexiconKey {
	return (LEXICON_KEYS as readonly string[]).includes(value);
}

/** Resolves one canonical key to its display term. */
export function term(profile: ResolvedProfile, key: LexiconKey): string {
	return profile.lexicon[key] ?? NEUTRAL[key];
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/**
 * Substitutes `{{key}}` placeholders with the profile's display terms.
 *
 * Display and prompting only (§4) — this never runs over anything on its way to
 * disk. P6 already forbids rewriting situation prose, and keeping substitution
 * one-way is what lets a profile change re-render the corpus without migrating
 * a file. An unknown placeholder is left verbatim so a typo is visible rather
 * than silently blank.
 *
 * One carve-out: generated regions bounded by the `vault/markers.ts` markers may
 * carry display terms to disk, because they are regenerated wholesale and never
 * parsed back into state — so the words in them never become a second source of
 * truth competing with the canonical keys. `system/status.ts` is the case this
 * was written for.
 */
export function applyLexicon(text: string, profile: ResolvedProfile): string {
	return text.replace(PLACEHOLDER, (whole, raw: string) => {
		const key = raw as LexiconKey;
		return key in NEUTRAL ? term(profile, key) : whole;
	});
}

/**
 * The vocabulary block injected into interview prompts, so the interviewer
 * speaks the author's idiom without a per-genre copy of every brief.
 */
export function lexiconBriefing(profile: ResolvedProfile): string {
	const entries = Object.entries(profile.lexicon).filter(
		([, value]) => typeof value === 'string' && value !== '',
	);

	if (entries.length === 0) {
		return '';
	}

	const lines = entries.map(([key, value]) => `- ${key.replace(/_/g, ' ')}: ${value}`);
	return [
		`This world's idiom is ${profile.name}. Use the author's vocabulary:`,
		'',
		...lines,
		'',
		'These are the words this author uses. Do not introduce vocabulary from a',
		'different idiom, and do not explain the substitution to them.',
	].join('\n');
}

/** Canonical → display pairs, for `/idiom` diagnostics (§9 risk mitigation). */
export function lexiconPairs(
	profile: ResolvedProfile,
): {key: LexiconKey; display: string; explicit: boolean}[] {
	return (Object.keys(NEUTRAL) as LexiconKey[]).map(key => ({
		key,
		display: term(profile, key),
		explicit: profile.lexicon[key] !== undefined,
	}));
}
