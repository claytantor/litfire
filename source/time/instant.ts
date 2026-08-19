/**
 * The in-world clock.
 *
 * Every point in time in a vault is an `Instant`: whole seconds from the
 * story's origin, negative before it. There is no other representation. A date
 * an author can read is produced by a `Calendar` at the edge, never stored.
 *
 * ## Why bigint
 *
 * A double carries 53 bits of integer precision, so it is exact only to
 * ±9,007,199,254,740,991 — about ±285 million years in seconds. That sounds
 * generous until a vault sets its origin at a story's present day and dates the
 * formation of a world before it. Past that bound the arithmetic does not fail;
 * it silently rounds, and two moments a minute apart compare equal.
 *
 * The failure is worse than it sounds because the rounding is invisible in
 * round numbers. `-26174880000000000` survives a round trip through a double
 * intact, while `-26174880000000123` comes back as `...124`. A format that is
 * lossless for the values used in testing and lossy for the ones used in
 * writing is the kind of bug that is found years later, in someone's book.
 */
export type Instant = bigint;

/** The origin. Every other instant is measured from here. */
export const ORIGIN: Instant = 0n;

/**
 * Seconds in a Julian year — 365.25 days exactly.
 *
 * Used only to convert the ±1 trillion year bound into seconds and to express
 * durations in years for display. Not a claim about any calendar: a fictional
 * world's year is whatever its calendar says, and this constant never reaches
 * one.
 */
export const SECONDS_PER_JULIAN_YEAR = 31_557_600n;

/** The supported range: ±1 trillion years from the origin, in seconds. */
export const MAX_INSTANT: Instant = SECONDS_PER_JULIAN_YEAR * 1_000_000_000_000n;
export const MIN_INSTANT: Instant = -MAX_INSTANT;

export function isInstant(value: unknown): value is Instant {
	return typeof value === 'bigint' && value >= MIN_INSTANT && value <= MAX_INSTANT;
}

/**
 * Reads an instant from whatever the frontmatter parser produced.
 *
 * A `number` is accepted, because vaults written before the clock was widened
 * hold plain YAML integers and refusing them would strand every existing
 * timeline. It is rejected when it is not an exact integer, or when it is
 * outside the safe range and therefore already rounded — silently adopting a
 * value the parser has damaged would bake the damage in.
 */
export function toInstant(value: unknown): Instant | undefined {
	if (typeof value === 'bigint') {
		return value >= MIN_INSTANT && value <= MAX_INSTANT ? value : undefined;
	}

	if (typeof value === 'number') {
		if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
			return undefined;
		}
		return BigInt(value);
	}

	// A quoted integer is how an author or another tool may have written it, and
	// it is the one string form that is unambiguous.
	if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
		const parsed = BigInt(value.trim());
		return parsed >= MIN_INSTANT && parsed <= MAX_INSTANT ? parsed : undefined;
	}

	return undefined;
}

/** Ascending comparator, for `toSorted`. */
export function compareInstants(a: Instant, b: Instant): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A signed duration in seconds, rendered in the largest unit that keeps it
 * legible.
 *
 * Deliberately approximate above days, and says so with `~`: a Julian year is
 * not any particular world's year, and printing "1,000,000 years" as though it
 * were exact would be inventing a number (P5).
 */
export function describeDuration(seconds: Instant): string {
	const magnitude = seconds < 0n ? -seconds : seconds;
	const sign = seconds < 0n ? '-' : '';

	if (magnitude < 60n) {
		return `${sign}${magnitude}s`;
	}
	if (magnitude < 3600n) {
		return `${sign}${magnitude / 60n}m`;
	}
	if (magnitude < 86_400n) {
		return `${sign}${magnitude / 3600n}h`;
	}
	if (magnitude < SECONDS_PER_JULIAN_YEAR) {
		return `${sign}${magnitude / 86_400n}d`;
	}

	const years = magnitude / SECONDS_PER_JULIAN_YEAR;
	return `~${sign}${grouped(years)} years`;
}

/** Thousands separators, done on the digits because these exceed Number. */
export function grouped(value: Instant): string {
	const negative = value < 0n;
	const digits = (negative ? -value : value).toString();
	const withSeparators = digits.replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');
	return negative ? `-${withSeparators}` : withSeparators;
}
