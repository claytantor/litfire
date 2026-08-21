import type {Calendar} from '../time/calendar.js';
import {readWhen} from '../time/calendar.js';
import {parseDocument, stringifyDocument} from '../vault/frontmatter.js';

/**
 * Turning a date a note states into a position on the clock.
 *
 * `at` is whole seconds from the origin, and a model asked for that number has
 * been asked to do arithmetic — across a timezone with daylight saving, over
 * spans of hundreds of millions of years. It will produce something
 * plausible-looking, and plausible-looking arithmetic that lands in a ledger
 * and is computed with is the exact failure this project exists to prevent.
 *
 * So the model is asked for the date, which is a thing it can read off the
 * page, and the conversion happens here. That is the same division everything
 * else in litfire draws: the model reads, code computes.
 *
 * Only reachable when a calendar is bound. Without one there is nothing to
 * convert against, and `at` stays what it always was — seconds, or absent.
 */

export type Resolved = {
	readonly contents: string;
	/** What was converted or dropped, for the author to see before accepting. */
	readonly notes: readonly string[];
};

/**
 * Replaces a written date in `at:` with the instant it names.
 *
 * A value that is already a number is left exactly alone: it came from the
 * author or from a previous pass, and re-reading it through a calendar could
 * only ever change it.
 */
export function resolveDates(contents: string, calendar: Calendar): Resolved {
	let data;
	let body;
	try {
		({data, body} = parseDocument(contents));
	} catch {
		// Malformed frontmatter is the review gate's problem to show, not this
		// function's to fail on.
		return {contents, notes: []};
	}

	const written = data['at'];
	if (typeof written !== 'string') {
		return {contents, notes: []};
	}

	const id = typeof data['id'] === 'string' ? data['id'] : 'this page';
	const instant = readWhen(written, calendar);

	// Anything `readWhen` returns is already in range: both halves of it —
	// `toInstant` and every shipped calendar's `parse` — refuse an instant
	// outside ±1 trillion years and return undefined instead. A custom calendar
	// cannot widen that, because a custom calendar formats and never parses.
	if (instant === undefined) {
		// Dropped rather than kept as a string, which would fail the schema and
		// land as a load issue — a page that will not parse is worse than a page
		// that is honestly undated, and `moment_undated` already says so.
		const {at: _dropped, ...rest} = data;
		return {
			contents: stringifyDocument({data: rest, body}),
			notes: [
				`${id}: '${written}' is not a date this vault's calendar can read — left undated`,
			],
		};
	}

	return {
		contents: stringifyDocument({data: {...data, at: instant}, body}),
		notes: [`${id}: read '${written}' as ${instant.toString()}s from the origin`],
	};
}
