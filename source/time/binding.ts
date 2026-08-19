import {z} from 'zod';
import type {Calendar} from './calendar.js';
import {gregorian, rawSeconds} from './calendar.js';
import {customCalendar, type FormattedInstants} from './custom.js';

/**
 * How a vault binds its clock, from `timeline/time.md`.
 *
 * Absent is a complete answer: a vault with no binding reads instants as
 * seconds from origin, which is what they are. An author who has not decided
 * what a year is called in their world should not have to before writing a
 * scene.
 */
export const timeSchema = z.object({
	/**
	 * `seconds` (the default), `gregorian` for Earth/Sol, or `custom` for a
	 * calendar formula in this vault.
	 */
	calendar: z.enum(['seconds', 'gregorian', 'custom']).default('seconds'),
	/**
	 * What the origin is, in the author's words. Never parsed — it is the label
	 * on second zero, and the one place the clock says what it is anchored to.
	 */
	origin: z.string().optional(),
	/** Gregorian only: the real instant the origin sits at, ISO 8601. */
	epoch: z.string().optional(),
	/** Gregorian only: IANA zone the dates are written in. */
	timezone: z.string().default('UTC'),
});

export type TimeBinding = z.infer<typeof timeSchema>;

/**
 * The calendar a binding names, or seconds when it names none.
 *
 * Never throws. A binding that asks for Gregorian without a usable epoch, or
 * for a custom calendar in a vault whose formulas were not consented to, falls
 * back to raw seconds and reports why — a display concern must not be able to
 * stop a vault loading (P4).
 */
export function calendarFor(
	binding: TimeBinding | undefined,
	options: {readonly formatted?: FormattedInstants | undefined} = {},
): {calendar: Calendar; note: string | undefined} {
	if (binding === undefined || binding.calendar === 'seconds') {
		return {calendar: rawSeconds, note: undefined};
	}

	if (binding.calendar === 'gregorian') {
		if (binding.epoch === undefined) {
			return {
				calendar: rawSeconds,
				note: 'gregorian needs an epoch: the real instant the origin sits at',
			};
		}
		try {
			return {
				calendar: gregorian({epoch: binding.epoch, timeZone: binding.timezone}),
				note: undefined,
			};
		} catch (caught) {
			return {
				calendar: rawSeconds,
				note: caught instanceof Error ? caught.message : String(caught),
			};
		}
	}

	if (options.formatted === undefined) {
		return {
			calendar: rawSeconds,
			note: 'custom calendar needs this vault’s formulas — run /consent',
		};
	}

	return {calendar: customCalendar(options.formatted), note: undefined};
}
