import type {FormulaRunner} from '../system/sandbox.js';
import type {Calendar} from './calendar.js';
import {OUT_OF_RANGE} from './calendar.js';
import {MAX_INSTANT, MIN_INSTANT, type Instant} from './instant.js';

/**
 * A calendar the author wrote, run in the formula sandbox.
 *
 * A fictional world's calendar cannot be configured — it has to be computed.
 * Ten months of thirty-five days, a year that skips a day every seventh, four
 * moons on different cycles: these are functions, and any declarative schema
 * that covered them would be a worse programming language than the one already
 * in the vault.
 *
 * So a custom calendar is a formula, in `system/formulas.md` or on a system's
 * page, under the same rules as `xp_for_level`: it runs in an isolate with no
 * clock, no network and no filesystem, under a 100ms CPU limit, and only after
 * the author has consented to this vault's formulas by hash (§6.4). Being
 * unable to name the current date is precisely what makes it safe to run.
 *
 * ```js
 * // ```js id=calendar
 * (seconds) => {
 *   const DAY = 86400n, YEAR = DAY * 320n;
 *   const year = seconds / YEAR;
 *   const day = (seconds % YEAR) / DAY;
 *   return `Year ${year}, day ${day + 1n}`;
 * }
 * // ```
 * ```
 *
 * It receives a BigInt and must return a string. Both are deliberate: a double
 * would round the very instants the clock was widened to hold, and a string is
 * the only thing a date can be once a world stops using months.
 */
export const CALENDAR_FORMULA_ID = 'calendar';

/**
 * Formatting is async and the wiki and views are not, so every instant a page
 * needs is resolved up front and read from this map afterwards.
 *
 * The alternative — a synchronous calendar — would mean running author code on
 * the main thread, which is the one thing the sandbox exists to prevent.
 */
export type FormattedInstants = ReadonlyMap<string, string>;

export function customCalendar(
	formatted: FormattedInstants,
	id = CALENDAR_FORMULA_ID,
): Calendar {
	return {
		id,
		name: 'Custom calendar',
		format(instant) {
			return formatted.get(instant.toString()) ?? OUT_OF_RANGE;
		},
	};
}

/**
 * Runs the author's calendar over every instant that will be displayed.
 *
 * Failures are per-instant and never thrown: a calendar that returns nothing
 * for the year the world was made should leave that one moment reading as raw
 * seconds, not take the timeline down with it (P4).
 */
export async function formatAll(
	runner: FormulaRunner,
	instants: readonly Instant[],
	id = CALENDAR_FORMULA_ID,
): Promise<{formatted: Map<string, string>; failures: string[]}> {
	const formatted = new Map<string, string>();
	const failures: string[] = [];

	for (const instant of new Set(instants)) {
		if (instant < MIN_INSTANT || instant > MAX_INSTANT) {
			continue;
		}
		try {
			formatted.set(instant.toString(), await runner.callText(id, instant));
		} catch (caught) {
			failures.push(caught instanceof Error ? caught.message : String(caught));
		}
	}

	return {formatted, failures};
}
