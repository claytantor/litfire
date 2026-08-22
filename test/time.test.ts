import {describe, expect, it} from 'vitest';
import {gregorian, OUT_OF_RANGE, rawSeconds} from '../source/time/calendar.js';
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
