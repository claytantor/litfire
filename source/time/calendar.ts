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
	/**
	 * The same calendar, reading and writing in another time zone.
	 *
	 * Only calendars with time zones implement this, which today is Gregorian
	 * alone. A fictional calendar has no IANA anything and returns nothing,
	 * which is how `readWhen` knows not to offer the feature for one.
	 *
	 * The epoch does not move. A zone is a way of *writing* an instant, not a
	 * different instant — which is the whole reason this can be per-call rather
	 * than a change to the vault's binding.
	 */
	inZone?(zone: string): Calendar | undefined;
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
/**
 * `Z` / `+09:00` / `-0700` → minutes east of UTC.
 *
 * Only ever called on a string the parse regex already matched, so the shape is
 * known; the arithmetic is the whole job. Sign is applied to the total rather
 * than to the hours, or `-00:30` would come out positive.
 */
function offsetMinutes(offset: string): number {
	if (offset === 'Z') {
		return 0;
	}
	const digits = offset.slice(1).replace(':', '');
	const total = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
	return offset.startsWith('-') ? -total : total;
}

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

/**
 * `YYYY-MM-DD`, optionally a time, optionally an explicit offset.
 *
 * One expression for both jobs this calendar has: reading the epoch out of the
 * binding, and reading a date the author wrote. They were separate — `Date.parse`
 * for the epoch, this for everything else — and that gap is where the epoch came
 * to mean something the rest of the calendar could not read back.
 */
const ISO =
	/^\s*(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/;

/**
 * An ISO date → milliseconds, undefined when it is not one.
 *
 * A trailing offset decides the instant on its own and `timeZone` is ignored;
 * without one the zone decides. Never `Date.parse` on a bare string — that is
 * defined to mean *local* time, so the answer would depend on which machine
 * ran it, and the same vault would anchor sixteen hours apart in Los Angeles
 * and Tokyo with nothing anywhere able to detect the difference.
 */
function readIso(text: string, timeZone: string): number | undefined {
	const match = ISO.exec(text);
	if (!match) {
		return undefined;
	}

	const fields = {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
		hour: Number(match[4] ?? 0),
		minute: Number(match[5] ?? 0),
		second: Number(match[6] ?? 0),
	};
	const offset = match[7];

	const ms =
		offset === undefined
			? utcFromFields(fields, timeZone)
			: Date.UTC(
					fields.year,
					fields.month - 1,
					fields.day,
					fields.hour,
					fields.minute,
					fields.second,
				) -
				offsetMinutes(offset) * 60_000;

	return Number.isNaN(ms) ? undefined : ms;
}

/**
 * An epoch rewritten to carry its own offset.
 *
 * What the author typed is a reading; what gets stored should be a fact. A bare
 * epoch is unambiguous *given* the binding beside it — but the two are then
 * coupled, and changing the zone silently moves the anchor, which is the last
 * thing a zone change should do. Resolving it once on write decouples them: the
 * anchor keeps naming the instant it named, whatever the vault is later bound
 * to.
 *
 * Not an invention. The offset is the one the author's own declared zone was at
 * that instant, and the returned string reads back as exactly the same instant
 * it went in as. An epoch that already carries an offset is returned untouched
 * — rewriting `-0700` as `-07:00` would be churn.
 */
export function resolveEpoch(epoch: string, timeZone = 'UTC'): string | undefined {
	if (/(?:Z|[+-]\d{2}:?\d{2})\s*$/.test(epoch)) {
		return epoch.trim();
	}

	const ms = readIso(epoch, timeZone);
	if (ms === undefined) {
		return undefined;
	}

	const f = fieldsIn(ms, timeZone);
	const pad = (value: number) => String(value).padStart(2, '0');
	const minutes = offsetAt(ms, timeZone) / 60_000;
	const sign = minutes < 0 ? '-' : '+';
	const size = Math.abs(minutes);

	return (
		`${String(f.year).padStart(4, '0')}-${pad(f.month)}-${pad(f.day)}` +
		`T${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}` +
		`${sign}${pad(Math.floor(size / 60))}:${pad(size % 60)}`
	);
}

export type GregorianOptions = {
	/**
	 * The real-world instant the vault's origin sits at, as an ISO 8601 string.
	 * This is the whole binding: it is what makes second 0 mean a date rather
	 * than just zero.
	 *
	 * An explicit offset (`-07:00`, `Z`) names the instant outright and is the
	 * clearest thing to write. Without one it is read in `timeZone` — the zone
	 * this vault already writes its dates in — which is a reading taken from
	 * what the author wrote rather than from the machine they typed it on.
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
	// Read through the same expression a written date goes through, and in this
	// vault's own zone when the epoch names no offset. Deterministic either way:
	// the reading comes from the binding, never from the machine.
	const epochMs = readIso(options.epoch, timeZone);
	if (epochMs === undefined) {
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
			const ms = readIso(text, timeZone);
			if (ms === undefined) {
				return undefined;
			}

			const delta = BigInt(ms) - epoch;
			const seconds = delta >= 0n ? delta / 1000n : (delta - 999n) / 1000n;
			return seconds >= MIN_INSTANT && seconds <= MAX_INSTANT ? seconds : undefined;
		},

		inZone(zone) {
			if (!isTimeZone(zone)) {
				return undefined;
			}
			// The anchor is pinned before the zone changes. A bare epoch is read in
			// this calendar's zone, so handing the raw string to a re-zoned
			// calendar moved second zero as well as the reading — and the two
			// shifts cancelled exactly, so `/time at <date> Europe/Berlin` quietly
			// returned the Los Angeles answer. Resolving first makes the epoch name
			// an instant, which is the one thing a zone must not be able to change.
			return gregorian({
				epoch: resolveEpoch(options.epoch, timeZone) ?? options.epoch,
				timeZone: zone,
			});
		},
	};
}

/**
 * Whether a string names a time zone this runtime knows.
 *
 * Asked of `Intl` rather than matched against a pattern, because the list is
 * the runtime's and it changes: `Europe/Kyiv` was not a zone once, and a
 * regular expression that accepted `Area/Location` would also accept
 * `Bag/End`. Throwing is how `Intl` says no, so the answer is the catch.
 */
export function isTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', {timeZone: zone});
		return true;
	} catch {
		return false;
	}
}

/**
 * Splits a trailing IANA time zone off a written date.
 *
 * `2031-02-13 09:26:11 Etc/UTC` is a date and the zone to read it in, and the
 * zone is the last token when there is one. Validated through `Intl` rather
 * than guessed at, so the only way a word is treated as a zone is by being one.
 *
 * A date with no zone comes back unchanged, which is the ordinary case.
 */
export function splitZone(written: string): {when: string; zone: string | undefined} {
	const trimmed = written.trim();
	const match = /^([\S\s]*\S)\s+(\S+)$/.exec(trimmed);
	const head = match?.[1];
	const candidate = match?.[2];
	return head !== undefined && candidate !== undefined && isTimeZone(candidate)
		? {when: head, zone: candidate}
		: {when: trimmed, zone: undefined};
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
 *
 * A trailing IANA zone is read as part of the date: `2031-02-13 09:26:11
 * Etc/UTC` is that wall time in UTC, whatever zone the vault is bound to. The
 * binding says how instants are *written back*, and needing to change it to
 * enter one date in another zone would be reconfiguring a vault to do a
 * conversion. Zones only apply to a calendar that has them; a fictional one
 * returns nothing from `inZone` and gets the whole string as written, in case
 * that last word is a real part of its date.
 */
export function readWhen(written: string, calendar: Calendar): Instant | undefined {
	const trimmed = written.trim();
	if (trimmed === '') {
		return undefined;
	}

	const direct = toInstant(trimmed.replaceAll(',', ''));
	if (direct !== undefined) {
		return direct;
	}

	const {when, zone} = splitZone(trimmed);
	if (zone !== undefined) {
		const zoned = calendar.inZone?.(zone);
		if (zoned !== undefined) {
			return zoned.parse?.(when);
		}
	}

	return calendar.parse?.(trimmed);
}
