import {describe, expect, it} from 'vitest';
import {calendarFor} from '../source/time/binding.js';
import {
	gregorian,
	isTimeZone,
	OUT_OF_RANGE,
	rawSeconds,
	readWhen,
	resolveEpoch,
	splitZone,
} from '../source/time/calendar.js';
import {
	compareInstants,
	describeDuration,
	grouped,
	MAX_INSTANT,
	MIN_INSTANT,
	toInstant,
} from '../source/time/instant.js';

describe('the range', () => {
	it('reaches a trillion years either side of the origin', () => {
		// The requirement, stated as arithmetic: 1e12 Julian years in seconds.
		expect(MAX_INSTANT).toBe(31_557_600_000_000_000_000n);
		expect(MIN_INSTANT).toBe(-31_557_600_000_000_000_000n);
		// Comfortably past what a double can hold exactly.
		expect(MAX_INSTANT > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
	});

	it('refuses an instant beyond it rather than clamping', () => {
		expect(toInstant(MAX_INSTANT + 1n)).toBeUndefined();
		expect(toInstant(MIN_INSTANT - 1n)).toBeUndefined();
		expect(toInstant(MAX_INSTANT)).toBe(MAX_INSTANT);
	});
});

describe('reading an instant', () => {
	it('takes a bigint, an exact number, or a quoted integer', () => {
		expect(toInstant(-1_000n)).toBe(-1_000n);
		expect(toInstant(-1_000)).toBe(-1_000n);
		expect(toInstant('-1000')).toBe(-1_000n);
		expect(toInstant(' 42 ')).toBe(42n);
	});

	/**
	 * The bug this type exists to prevent. A double cannot hold this value, and
	 * YAML hands it over already rounded — adopting it would bake the damage in.
	 */
	it('refuses a number the parser has already damaged', () => {
		// Built the way YAML builds it, from the digits on the page — which is
		// precisely how the damage happens in a real vault.
		const damaged = Number('-26174880000000123');
		expect(Number.isSafeInteger(damaged)).toBe(false);
		expect(String(damaged)).toBe('-26174880000000124');
		expect(toInstant(damaged)).toBeUndefined();

		// The same digits as a bigint are exact and accepted.
		expect(toInstant(-26_174_880_000_000_123n)).toBe(-26_174_880_000_000_123n);
	});

	it('refuses a fraction and anything that is not a number at all', () => {
		expect(toInstant(1.5)).toBeUndefined();
		expect(toInstant('yesterday')).toBeUndefined();
		expect(toInstant(null)).toBeUndefined();
		expect(toInstant(undefined)).toBeUndefined();
	});

	it('sorts without going through Number', () => {
		const a = MAX_INSTANT - 1n;
		const b = MAX_INSTANT;
		// Both collapse to the same double; only bigint keeps them apart.
		expect(Number(a)).toBe(Number(b));
		expect(compareInstants(a, b)).toBe(-1);
		expect([b, a].toSorted(compareInstants)).toEqual([a, b]);
	});
});

describe('reading it back to a person', () => {
	it('groups digits and marks long spans as approximate', () => {
		expect(grouped(-26_174_880_000_000_000n)).toBe('-26,174,880,000,000,000');
		expect(describeDuration(90n)).toBe('1m');
		expect(describeDuration(-7_200n)).toBe('-2h');
		expect(describeDuration(31_557_600n * 1_000_000n)).toBe('~1,000,000 years');
	});
});

describe('no calendar bound', () => {
	it('shows the seconds, and reads them back', () => {
		expect(rawSeconds.format(-1_000n)).toBe('-1,000s');
		expect(rawSeconds.parse?.('-1,000s')).toBe(-1_000n);
		expect(rawSeconds.parse?.('nope')).toBeUndefined();
	});
});

describe('Earth/Sol time', () => {
	// A real vault's binding: an anchor in a zone that observes daylight saving,
	// which is what makes the cases below more than theory.
	const cal = gregorian({
		epoch: '2031-08-15T19:33:00-07:00',
		timeZone: 'America/Los_Angeles',
	});

	it('puts the origin at the epoch it was bound to', () => {
		expect(cal.format(0n)).toBe('2031-08-15 19:33:00');
	});

	it('round-trips a date through seconds and back', () => {
		const instant = cal.parse?.('2031-08-16 19:33:00');
		expect(instant).toBe(86_400n);
		expect(cal.format(instant!)).toBe('2031-08-16 19:33:00');
	});

	/**
	 * Subtracting wall-clock fields across a transition ignores that the offset
	 * changed, and the answer is out by exactly the hour that repeated. Easy to
	 * get wrong twice over: the expected value here is 49 hours, not 25, and
	 * reasoning about it casually produces both.
	 */
	it('crosses a daylight-saving boundary without losing the hour', () => {
		// 2031-11-02 is the US fall-back. Midnight before, midnight after.
		const before = cal.parse?.('2031-11-01 12:00:00');
		const after = cal.parse?.('2031-11-03 12:00:00');
		expect(before).toBeDefined();
		expect(after).toBeDefined();
		// Two calendar days is 48 hours of wall clock; the repeated hour makes it
		// 49 of real time. A naive field subtraction would report 48.
		expect(after! - before!).toBe(49n * 3_600n);
	});

	it('handles dates before the common era', () => {
		const ancient = cal.parse?.('-0044-03-15 12:00:00');
		expect(ancient).toBeDefined();
		expect(cal.format(ancient!)).toContain('BC');
	});

	it('says so rather than lying when an instant is past its horizon', () => {
		expect(cal.format(MAX_INSTANT)).toBe(OUT_OF_RANGE);
		expect(cal.format(MIN_INSTANT)).toBe(OUT_OF_RANGE);
		// A million years is already beyond Gregorian's reach.
		expect(cal.format(31_557_600n * 1_000_000n)).toBe(OUT_OF_RANGE);
	});

	it('refuses an epoch that is not an instant', () => {
		expect(() => gregorian({epoch: 'sometime'})).toThrow(/ISO 8601/);
	});

	it('defaults to UTC when no zone is named', () => {
		const utc = gregorian({epoch: '2000-01-01T00:00:00Z'});
		expect(utc.format(0n)).toBe('2000-01-01 00:00:00');
		expect(utc.format(3_600n)).toBe('2000-01-01 01:00:00');
	});
});

/**
 * A zone is a way of writing an instant, not a different instant — so naming
 * one on a single date is a conversion, and must not require rebinding the
 * vault. This is the whole argument for reading it per call.
 */
describe('reading a date in a named zone', () => {
	// Bound to Los Angeles, deliberately: every assertion below would pass by
	// accident against a UTC vault.
	const la = gregorian({
		epoch: '2031-08-15T19:33:00-07:00',
		timeZone: 'America/Los_Angeles',
	});

	it('reads a trailing IANA zone instead of the bound one', () => {
		const utc = readWhen('2031-02-13 09:26:11 Etc/UTC', la);
		const bound = readWhen('2031-02-13 09:26:11', la);

		expect(utc).toBeDefined();
		expect(bound).toBeDefined();
		// February in Los Angeles is UTC-8, so the same wall time is eight hours
		// apart depending on which zone it was written in.
		expect(bound! - utc!).toBe(8n * 3_600n);
	});

	it('leaves the binding alone — the vault still writes in its own zone', () => {
		const instant = readWhen('2031-02-13 09:26:11 Etc/UTC', la)!;
		expect(la.format(instant)).toBe('2031-02-13 01:26:11');
	});

	it('round-trips a date named in the bound zone', () => {
		expect(readWhen('2031-02-13 09:26:11 America/Los_Angeles', la)).toBe(
			readWhen('2031-02-13 09:26:11', la),
		);
	});

	it('rejects a zone that is not one rather than guessing', () => {
		expect(readWhen('2031-02-13 09:26:11 Bag/End', la)).toBeUndefined();
		expect(isTimeZone('Bag/End')).toBe(false);
		expect(isTimeZone('Etc/UTC')).toBe(true);
	});

	it('still reads a bare instant, zone syntax or not', () => {
		expect(readWhen('-15,844,009', la)).toBe(-15_844_009n);
	});

	it('splits only a trailing token that really is a zone', () => {
		expect(splitZone('2031-02-13 09:26:11 Etc/UTC')).toEqual({
			when: '2031-02-13 09:26:11',
			zone: 'Etc/UTC',
		});
		expect(splitZone('2031-02-13 09:26:11')).toEqual({
			when: '2031-02-13 09:26:11',
			zone: undefined,
		});
	});

	it('offers nothing to a calendar without zones', () => {
		expect(rawSeconds.inZone).toBeUndefined();
		// The whole string goes to the calendar, in case that last word is part
		// of how it writes a date.
		expect(readWhen('2031-02-13 09:26:11 Etc/UTC', rawSeconds)).toBeUndefined();
	});
});

/**
 * The epoch is written as an ISO timestamp carrying its own offset, and until
 * now that exact notation was the one thing the calendar could not read back —
 * so pasting a vault's own anchor into `/time at` was rejected as "not a date".
 */
describe('an explicit UTC offset', () => {
	const utc = gregorian({epoch: '2031-08-15T19:33:00-07:00', timeZone: 'Etc/UTC'});
	const la = gregorian({
		epoch: '2031-08-15T19:33:00-07:00',
		timeZone: 'America/Los_Angeles',
	});

	it('reads the anchor back as instant zero', () => {
		expect(readWhen('2031-08-15T19:33:00-07:00', utc)).toBe(0n);
		expect(readWhen('2031-08-16T02:33:00Z', utc)).toBe(0n);
	});

	it('outranks the bound zone, because it already names the instant', () => {
		// A timestamp that carries its own offset means one instant, whatever the
		// vault is bound to. A bare wall time does not, and is read in the zone.
		expect(readWhen('2031-08-16T02:33:00Z', la)).toBe(0n);
		expect(readWhen('2031-08-16 02:33:00', la)).toBe(7n * 3_600n);
	});

	it('accepts Z, colon and compact forms alike', () => {
		const target = 157_791_420n;
		expect(readWhen('2036-08-15T09:30:00Z', utc)).toBe(target);
		expect(readWhen('2036-08-15T02:30:00-07:00', utc)).toBe(target);
		expect(readWhen('2036-08-15T02:30:00-0700', utc)).toBe(target);
	});

	it('applies the sign to the whole offset, not just the hours', () => {
		// -07:30 is half an hour further from UTC than the anchor's -07:00, so
		// the same wall time is 1800 seconds later.
		expect(readWhen('2031-08-15T19:33:00-07:30', utc)).toBe(1_800n);
		expect(readWhen('2031-08-15T19:33:00-06:30', utc)).toBe(-1_800n);
	});
});

describe('an epoch with no offset', () => {
	/**
	 * `Date.parse` reads an ISO date-time with no offset as *local* time, so
	 * reading the epoch that way anchored the vault to whichever machine ran the
	 * command — the same string sixteen hours apart in Los Angeles and Tokyo,
	 * with nothing downstream able to detect it.
	 *
	 * The answer is not to refuse it. The binding already says which zone this
	 * vault writes its dates in, so that is the zone a bare epoch is read in:
	 * taken from what the author wrote, not from where they were sitting.
	 */
	it('is read in the vault’s own zone, not the machine’s', () => {
		const tokyo = gregorian({
			epoch: '2031-08-15T22:33:00',
			timeZone: 'Asia/Tokyo',
		});
		const la = gregorian({
			epoch: '2031-08-15T22:33:00',
			timeZone: 'America/Los_Angeles',
		});

		// Second zero reads back as exactly what was written, in each zone.
		expect(tokyo.format(0n)).toBe('2031-08-15 22:33:00');
		expect(la.format(0n)).toBe('2031-08-15 22:33:00');

		// And they are different instants — sixteen hours apart, stated rather
		// than inherited from the machine.
		expect(la.parse!('2031-08-15 22:33:00 ')).toBe(0n);
		expect(tokyo.parse!(tokyo.format(0n))).toBe(0n);
	});

	it('matches the explicit form it stands for', () => {
		const bare = gregorian({
			epoch: '2031-08-15T22:33:00',
			timeZone: 'America/Los_Angeles',
		});
		const explicit = gregorian({
			// August in Los Angeles is UTC-7.
			epoch: '2031-08-15T22:33:00-07:00',
			timeZone: 'America/Los_Angeles',
		});
		expect(bare.format(0n)).toBe(explicit.format(0n));
		expect(bare.format(157_791_420n)).toBe(explicit.format(157_791_420n));
	});

	it('keeps a vault readable rather than falling back to seconds', () => {
		const {calendar, note} = calendarFor({
			calendar: 'gregorian',
			epoch: '2031-08-15T22:33:00',
			timezone: 'America/Los_Angeles',
		});
		expect(calendar.id).toBe('gregorian');
		expect(note).toBeUndefined();
	});

	it('still refuses something that is not a date at all', () => {
		expect(() => gregorian({epoch: 'sometime'})).toThrow(/ISO 8601/);
	});
});

describe('a zone changes the reading and never the anchor', () => {
	/**
	 * The bug this pins: a bare epoch is read in the calendar's own zone, so
	 * re-zoning a calendar without first resolving the epoch moved second zero
	 * as well as the date being read — and the two shifts cancelled exactly.
	 * `/time at <date> Europe/Berlin` returned the Los Angeles answer, which is
	 * the worst possible failure: a plausible number, silently wrong.
	 */
	it('gives the same answer whether the epoch carries an offset or not', () => {
		const bare = gregorian({
			epoch: '2031-08-15T22:33:00',
			timeZone: 'America/Los_Angeles',
		});
		const explicit = gregorian({
			epoch: '2031-08-15T22:33:00-07:00',
			timeZone: 'America/Los_Angeles',
		});

		for (const written of [
			'2028-11-12T21:23:10 Europe/Berlin',
			'2028-11-12T21:23:10 America/Los_Angeles',
			'2028-11-12T21:23:10 Asia/Tokyo',
		]) {
			expect(readWhen(written, bare), written).toBe(readWhen(written, explicit));
		}
	});

	it('actually moves the instant when the zone moves', () => {
		const la = gregorian({
			epoch: '2031-08-15T22:33:00',
			timeZone: 'America/Los_Angeles',
		});
		const inLa = readWhen('2028-11-12T21:23:10 America/Los_Angeles', la)!;
		const inBerlin = readWhen('2028-11-12T21:23:10 Europe/Berlin', la)!;
		// November: Los Angeles is UTC-8, Berlin UTC+1.
		expect(inLa - inBerlin).toBe(9n * 3_600n);
	});
});

describe('resolveEpoch', () => {
	it('gives a bare epoch the offset its own zone was at', () => {
		expect(resolveEpoch('2031-08-15T22:33:00', 'America/Los_Angeles')).toBe(
			'2031-08-15T22:33:00-07:00',
		);
		// November, so the same zone is an hour further out.
		expect(resolveEpoch('2028-11-12T21:23:10', 'America/Los_Angeles')).toBe(
			'2028-11-12T21:23:10-08:00',
		);
		expect(resolveEpoch('2031-08-15T22:33:00', 'Asia/Kolkata')).toBe(
			'2031-08-15T22:33:00+05:30',
		);
	});

	it('leaves one that already names its offset alone', () => {
		expect(resolveEpoch('2031-08-15T19:33:00-07:00', 'Asia/Tokyo')).toBe(
			'2031-08-15T19:33:00-07:00',
		);
		expect(resolveEpoch('2031-08-15T19:33:00Z', 'Asia/Tokyo')).toBe(
			'2031-08-15T19:33:00Z',
		);
	});

	it('resolves to the same instant it was given', () => {
		const zone = 'America/Los_Angeles';
		const before = gregorian({epoch: '2031-08-15T22:33:00', timeZone: zone});
		const after = gregorian({
			epoch: resolveEpoch('2031-08-15T22:33:00', zone)!,
			timeZone: zone,
		});
		expect(after.format(0n)).toBe(before.format(0n));
		expect(after.format(157_791_420n)).toBe(before.format(157_791_420n));
	});

	it('says nothing about a string that is not a date', () => {
		expect(resolveEpoch('sometime', 'Etc/UTC')).toBeUndefined();
	});
});
