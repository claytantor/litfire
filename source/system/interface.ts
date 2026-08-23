import type {SystemDef} from '../domain/schema.js';
import type {CharacterState} from '../ledger/replay.js';

/**
 * The status screen a system shows, as the author drew it.
 *
 * Until now the shape of a status block came from the genre profile: an arcane
 * vault got `sheet`, a technological one got `hud`, and an author who wanted
 * their System to look like their System had no way to say so. That is exactly
 * backwards for the thing a reader actually sees on the page.
 *
 * An interface is a fenced block in the system's own body, drawn however the
 * author likes, with the values marked. It is a rendering and a specification
 * at once: every placeholder in it is a stat that has to exist, which is what
 * lets the stats model be derived from the screen rather than the other way
 * round.
 *
 * ````markdown
 * ```interface
 * ┌─ THE LATHE ──────────────┐
 * │ {name}      TIER {level} │
 * │ COHERENCE   {coherence}  │
 * └──────────────────────────┘
 * ```
 * ````
 *
 * Substitution and nothing else. No bars, no formats, no conditionals — a
 * placeholder becomes a value and everything around it is the author's own
 * drawing, kept byte for byte. Anything cleverer is a template language, and a
 * template language in a vault is a second thing to learn, a second thing to
 * document, and a second thing for a generated interface to get wrong.
 *
 * The one thing a placeholder can be that is not a stat's value is that stat's
 * *reading* — `{coherence-interpretation}` for what the system makes of 31.
 * That is still substitution: the phrase comes from a band table the author
 * accepted, looked up in code, not from a model asked at render time. A system
 * that judges is most of what makes one worth having, and judgement that
 * changed between two renderings of the same number would be a continuity bug
 * rather than a feature.
 */

/** `{stat-id}` — ids are kebab-case, and so is everything else addressable. */
const PLACEHOLDER = /\{([a-z0-9][a-z0-9-]*)\}/g;

/**
 * The fields that are not stats.
 *
 * Kept small on purpose. Every one of these is a thing an author might
 * reasonably put on a status screen and cannot express as a stat, and the list
 * stops there — an interface is for showing state, not for computing over it.
 */
export const BUILT_IN_FIELDS = ['name', 'level', 'xp', 'skills'] as const;

/** The interface block in a system's body, or undefined when it has none. */
export function extractInterface(markdown: string): string | undefined {
	const pattern = /^(`{3,})interface[^\n]*\n([\S\s]*?)^\1\s*$/m;
	const match = pattern.exec(markdown);
	// Trailing newline only: leading whitespace may be part of the drawing, and
	// an author who indented their box meant to.
	return match?.[2]?.replace(/\n$/, '');
}

/** Every field an interface asks for, in the order it first asks. */
export function fieldsOf(template: string): string[] {
	const seen = new Set<string>();
	for (const match of template.matchAll(PLACEHOLDER)) {
		const field = match[1];
		if (field !== undefined) {
			seen.add(field);
		}
	}
	return [...seen];
}

/** The suffix that asks for a stat's reading rather than its value. */
const INTERPRETATION = '-interpretation';

/**
 * What the system says about a value, or undefined when it says nothing.
 *
 * Bands are ascending and `upto` is inclusive, so the first one the value fits
 * under is the answer. A stat with no bands has no reading — the system has not
 * been asked what it makes of the number, which is different from making
 * nothing of it.
 */
export function readingOf(
	system: SystemDef | undefined,
	statId: string,
	value: number,
): string | undefined {
	const bands = system?.stats.find(stat => stat.id === statId)?.bands ?? [];
	for (const band of bands) {
		if (band.upto === undefined || value <= band.upto) {
			return band.reads;
		}
	}
	return undefined;
}

/**
 * Fills an interface in for one character.
 *
 * A placeholder with nothing behind it is left standing rather than blanked.
 * An author looking at their own screen with `{coherence}` still on it can see
 * what is missing; one looking at a blank space cannot tell it from a zero, and
 * the checks report the same gap in words at the same time.
 */
export function renderInterface(
	template: string,
	character: CharacterState,
	options: {readonly displayName?: string; readonly system?: SystemDef} = {},
): string {
	return template.replaceAll(PLACEHOLDER, (whole, field: string) => {
		switch (field) {
			case 'name': {
				return options.displayName ?? character.id;
			}
			case 'level': {
				return String(character.level);
			}
			case 'xp': {
				return String(character.xp);
			}
			case 'skills': {
				return character.skills.length === 0 ? '—' : character.skills.join(', ');
			}
			default: {
				if (field.endsWith(INTERPRETATION)) {
					const statId = field.slice(0, -INTERPRETATION.length);
					const value = character.stats[statId];
					const reading =
						value === undefined ? undefined : readingOf(options.system, statId, value);
					return reading ?? whole;
				}

				const value = character.stats[field];
				return value === undefined ? whole : String(value);
			}
		}
	});
}
