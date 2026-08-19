import {useMemo} from 'react';
import type {Line} from '../commands/types.js';

/**
 * Layout arithmetic for the windowed screens (§10).
 *
 * Ink wraps `<Text>` at paint time, which is too late for a screen that slices
 * its content into a fixed number of rows: one long logical line silently
 * becomes three terminal rows, the slice overshoots the viewport, and the frame
 * ends up taller than the terminal. Ink's response to an over-tall frame is to
 * write `clearTerminal + every <Static> line it has ever emitted + the frame` on
 * *each* render (see `shouldClearTerminalForFrame` in ink/build/ink.js), which
 * is what duplicated scrollback and resize flicker actually are.
 *
 * So the screens wrap first and window over rows. One array element then means
 * exactly one terminal row, at any width.
 */

/** Widest a `<Box borderStyle="round" paddingX={1}>` can be drawn into. */
export const BORDERED_CHROME = 4;

/**
 * Content width inside a chrome of `chrome` columns, floored at 1 so a terminal
 * narrower than the chrome yields a usable width instead of a negative one.
 */
export const contentWidth = (columns: number, chrome = BORDERED_CHROME): number =>
	Math.max(1, Math.floor(columns) - chrome);

/**
 * Rows left for content after `chrome` rows of frame, floored at `floor`.
 *
 * The floor is 1 rather than the old magic 3/4: on a very short terminal a
 * three-row minimum is what pushes the frame past the viewport, and one visible
 * row plus intact chrome beats three rows the author cannot see.
 */
export const viewportHeight = (rows: number, chrome: number, floor = 1): number =>
	Math.max(floor, Math.floor(rows) - chrome);

/**
 * Greedy word wrap that preserves every character it is given.
 *
 * Leading and interior whitespace survives, which a `split(' ')` wrap does not:
 * diff bodies mark context lines with a leading space and `columns()` aligns
 * tables with runs of them, so collapsing whitespace would rewrite the output
 * rather than reflow it. A token wider than the viewport is broken mid-word —
 * one pasted path or URL would otherwise cost the screen however many rows it
 * spilled onto.
 */
export function wrapText(text: string, width: number): string[] {
	const limit = Math.max(1, Math.floor(width));
	const out: string[] = [];

	for (const paragraph of text.split('\n')) {
		let rest = paragraph;

		while (rest.length > limit) {
			// The last space that still fits, so the break lands between words.
			let cut = -1;
			for (let index = limit; index > 0; index--) {
				if (rest[index] === ' ') {
					cut = index;
					break;
				}
			}

			if (cut <= 0) {
				out.push(rest.slice(0, limit));
				rest = rest.slice(limit);
			} else {
				out.push(rest.slice(0, cut));
				// The break space rides on the next row rather than being dropped.
				// That is what `wrap-ansi` does under Ink's `trim: false`, and it is
				// the conservative side to be on: a row over-counted costs the
				// viewport one line, a row under-counted overflows the terminal.
				rest = rest.slice(cut);
			}
		}

		// Pushed even when empty, so a blank line stays a blank line on screen.
		out.push(rest);
	}

	return out;
}

/** Terminal rows `text` occupies at `width`. Never less than one. */
export const rowsFor = (text: string, width: number): number =>
	wrapText(text, width).length;

/** Rows a run of strings occupies at `width`, chrome included. */
export const rowsForAll = (texts: readonly string[], width: number): number =>
	texts.reduce((total, text) => total + rowsFor(text, width), 0);

export type SplitRow = {
	/** Render the two halves stacked in a column rather than side by side. */
	readonly stacked: boolean;
	/** Terminal rows the row will take once rendered. */
	readonly rows: number;
};

/**
 * A header row with a label on the left and a status on the right.
 *
 * Ink lays these out with `justifyContent="space-between"`, and when the two
 * halves no longer fit Yoga shrinks *both* — which is how `• pending` ends up
 * split across two rows as `•` and `pending`. Stacking them instead keeps each
 * half readable and makes the row's height exactly knowable, which the screens
 * around it need in order to budget their viewports.
 */
export function splitRow(left: string, right: string, width: number): SplitRow {
	const stacked = left.length + 1 + right.length > width;
	return {
		stacked,
		rows: stacked ? rowsFor(left, width) + rowsFor(right, width) : 1,
	};
}

/** Wraps styled lines, carrying each line's styling onto every row it takes. */
export function wrapLines(lines: readonly Line[], width: number): Line[] {
	const out: Line[] = [];

	for (const line of lines) {
		for (const row of wrapText(line.text, width)) {
			out.push({...line, text: row});
		}
	}

	return out;
}

/**
 * Memoised {@link wrapLines}. Wrapping is pure in `(lines, width)`, so a resize
 * recomputes and a re-render for any other reason does not.
 */
export function useWrappedLines(lines: readonly Line[], width: number): Line[] {
	return useMemo(() => wrapLines(lines, width), [lines, width]);
}
