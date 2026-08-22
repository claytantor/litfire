import {grouped, MAX_INSTANT, MIN_INSTANT, toInstant, type Instant} from './instant.js';

/**
 * Turns an instant into something an author can read, and back.
 *
 * A vault stores seconds from origin and nothing else. A calendar is the edge
 * where those seconds become "15 August 2031" or "Third Ember, Year 412" — a
 * presentation concern, chosen per vault, never persisted into a moment.
 *
 * `parse` is optional: reading a fictional calendar's dates back is a harder
 * problem than writing them, and a calendar that can only format is still
 * useful. A calendar without `parse` means `/timeline` takes seconds.
 */
export type Calendar = {
	readonly id: string;
	readonly name: string;
	/** Instant → a date in this calendar. Never throws; see `OUT_OF_RANGE`. */
	format(instant: Instant): string;
	/** A date in this calendar → instant. Undefined when unreadable. */
	parse?(text: string): Instant | undefined;
};

/**
 * What a calendar returns for an instant it cannot express.
 *
 * Every calendar has a horizon — Gregorian's is about ±273,790 years, where
 * the underlying `Date` runs out — and the vault's range is ±1 trillion. Saying
 * so is the honest answer; clamping to the horizon would report a date that is
 * wrong by geological ages, and throwing would take the timeline down over a
 * display concern (P4).
 */
export const OUT_OF_RANGE = 'beyond this calendar';

/**
 * Seconds from origin, with separators. The fallback when no calendar is bound.
 *
 * A vault is perfectly usable on this: the numbers are the truth, and a story
 * whose author has not decided what a year is called should not be forced to.
 */
export const rawSeconds: Calendar = {
	id: 'seconds',
	name: 'Seconds from origin',
	format(instant) {
		return `${grouped(instant)}s`;
	},
	parse(text) {
		const trimmed = text.trim().replace(/s$/, '').replaceAll(',', '');
		if (!/^[+-]?\d+$/.test(trimmed)) {
			return undefined;
		}
		const value = BigInt(trimmed);
		return value >= MIN_INSTANT && value <= MAX_INSTANT ? value : undefined;
	},
};

/** `Date` spans ±8.64e15 ms from 1970 — roughly ±273,790 years. */
const MAX_DATE_MS = 8_640_000_000_000_000n;

const PARTS = new Set(['year', 'month', 'day', 'hour', 'minute', 'second'] as const);

type Fields = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;

/** Reads a UTC instant's wall-clock fields as they appear in `timeZone`. */
function fieldsIn(ms: number, timeZone: string): Fields {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		era: 'short',
	});

	const fields: Partial<Fields> = {};
	let bce = false;
	for (const part of formatter.formatToParts(new Date(ms))) {
		if (part.type === 'era') {
			bce = part.value.startsWith('B');
		} else if ((PARTS as Set<string>).has(part.type)) {
			fields[part.type as keyof Fields] = Number(part.value);
		}
	}

	const year = fields.year ?? 0;
	return {
		// Intl reports year 1 BC as era B, year 1; astronomical numbering makes
		// that year 0, which is what arithmetic on years needs.
		year: bce ? 1 - year : year,
		month: fields.month ?? 1,
		day: fields.day ?? 1,
		// Some zones render midnight as hour 24 rather than 0.
		hour: (fields.hour ?? 0) % 24,
		minute: fields.minute ?? 0,
		second: fields.second ?? 0,
	};
}

/** The offset `timeZone` was at, at a given UTC instant, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
	const f = fieldsIn(ms, timeZone);
	const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
	// Date.UTC maps years 0–99 into 1900–1999 unless corrected.
	const corrected =
		f.year >= 0 && f.year < 100
			? asUtc -
				Date.UTC(1900, 0, 1) +
				Date.UTC(f.year, 0, 1) -
				Date.UTC(f.year + 1900, 0, 1)
			: asUtc;
	return corrected - ms;
}

/**
 * Wall-clock fields in `timeZone` → the UTC instant they name.
 *
 * Two passes, because the offset depends on the instant we are trying to find.
 * The first guess treats the fields as UTC, reads the offset that would have
 * been in force there, and corrects; the second pass catches the case where
 * the correction moved across a transition.
 *
 * One pass is the standard bug here, and it is quiet: it is right all year
 * except within an hour of a transition, where it lands an hour out. A story
 * anchored in a zone that observes daylight saving crosses two of those every
 * year, so "usually right" is not a property worth having.
 */
function utcFromFields(fields: Fields, timeZone: string): number {
	const naive = Date.UTC(
		fields.year,
		fields.month - 1,
		fields.day,
		fields.hour,
		fields.minute,
		fields.second,
	);
	let guess = naive - offsetAt(naive, timeZone);
	guess = naive - offsetAt(guess, timeZone);
	return guess;
}

export type GregorianOptions = {
	/**
	 * The real-world instant the vault's origin sits at, as an ISO 8601 string
	 * carrying an offset or `Z`. This is the whole binding: it is what makes
	 * second 0 mean a date rather than just zero.
	 */
	readonly epoch: string;
	/** IANA zone the dates are written in. Defaults to UTC. */
	readonly timeZone?: string;
};

/**
 * Earth/Sol time: the standard timezone-aware Gregorian calendar.
 *
 * Shipped as the worked example of a `Calendar`, and useful on its own for any
 * story set on Earth or keeping a real-world production clock. A fictional
 * calendar replaces this wholesale rather than configuring it.
 */
export function gregorian(options: GregorianOptions): Calendar {
	const timeZone = options.timeZone ?? 'UTC';
	const epochMs = Date.parse(options.epoch);
	if (Number.isNaN(epochMs)) {
		throw new Error(
			`epoch '${options.epoch}' is not an ISO 8601 instant (try 2031-08-15T19:33:00-07:00)`,
		);
	}
	const epoch = BigInt(epochMs);

	return {
		id: 'gregorian',
		name: `Gregorian (${timeZone})`,

		format(instant) {
			const ms = epoch + instant * 1000n;
			if (ms > MAX_DATE_MS || ms < -MAX_DATE_MS) {
				return OUT_OF_RANGE;
			}

			const f = fieldsIn(Number(ms), timeZone);
			const year =
				f.year <= 0
					? `${String(1 - f.year).padStart(4, '0')} BC`
					: String(f.year).padStart(4, '0');
			const pad = (value: number) => String(value).padStart(2, '0');

			return `${year}-${pad(f.month)}-${pad(f.day)} ${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`;
		},

		parse(text) {
			const match =
				/^\s*(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(
					text,
				);
			if (!match) {
				return undefined;
			}

			const ms = utcFromFields(
				{
					year: Number(match[1]),
					month: Number(match[2]),
					day: Number(match[3]),
					hour: Number(match[4] ?? 0),
					minute: Number(match[5] ?? 0),
					second: Number(match[6] ?? 0),
				},
				timeZone,
			);
			if (Number.isNaN(ms)) {
				return undefined;
			}

			// Seconds, floored toward negative infinity so the instant is never
			// nudged forward past the second the author wrote.
			const delta = BigInt(ms) - epoch;
			const seconds = delta >= 0n ? delta / 1000n : (delta - 999n) / 1000n;
			return seconds >= MIN_INSTANT && seconds <= MAX_INSTANT ? seconds : undefined;
		},
	};
}

/**
 * Reads a written time as an instant, either notation.
 *
 * A bare integer is already an instant; anything else is a date for the bound
 * calendar to read. Deciding from the input rather than asking is what lets
 * `/time at` and `/moment <id> at` take the same argument, and it means an
 * author who has the seconds in hand never has to convert them first.
 *
 * Grouped digits are accepted because that is how the tool prints them, and
 * pasting back what was just read out should work.
 */
export function readWhen(written: string, calendar: Calendar): Instant | undefined {
	const trimmed = written.trim();
	if (trimmed === '') {
		return undefined;
	}
	return toInstant(trimmed.replaceAll(',', '')) ?? calendar.parse?.(trimmed);
}
