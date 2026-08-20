/**
 * How often a streaming reply is allowed to repaint, in milliseconds.
 *
 * A provider delivers a reply as hundreds or thousands of deltas, and setting
 * state on each one asks React and Ink to lay out the whole screen that many
 * times a second. Ink debounces its own render, so almost every one of those
 * frames is computed and then discarded — the work is pure waste, and it is
 * done while the terminal is at its busiest.
 *
 * 50ms is twenty frames a second. Text arriving faster than that is not
 * something a reader can follow anyway, so nothing is lost by coalescing it,
 * and the render count drops by one to two orders of magnitude.
 */
export const STREAM_PAINT_MS = 50;

/**
 * Coalesces a token stream into repaints a terminal can keep up with.
 *
 * Wraps the accumulate-and-set loop every streaming screen was writing by
 * hand:
 *
 * ```ts
 * const paint = streamPainter(setStreaming);
 * for await (const delta of session.ask(signal)) {
 *   paint.push(delta);
 * }
 * paint.flush();
 * ```
 *
 * `flush` is not optional. The last few tokens usually arrive inside the final
 * interval, and without it a reply ends visibly truncated until whatever
 * replaces it lands.
 */
export function streamPainter(
	set: (text: string) => void,
	interval = STREAM_PAINT_MS,
): {
	push: (delta: string) => void;
	flush: () => void;
	readonly text: string;
} {
	let text = '';
	let painted = '';
	// Real wall-clock time, deliberately: this is throttling a repaint for a
	// person watching, not anything the ledger has to reproduce.
	let last = 0;

	return {
		push(delta) {
			text += delta;
			// Unchanged text is never worth a frame, however long it has been.
			// Providers do send empty deltas — a keepalive, or a chunk carrying
			// only a finish reason — and repainting on those is the same waste
			// this exists to remove.
			if (text === painted) {
				return;
			}
			const now = Date.now();
			if (now - last >= interval) {
				last = now;
				painted = text;
				set(text);
			}
		},
		flush() {
			if (painted !== text) {
				painted = text;
				set(text);
			}
		},
		get text() {
			return text;
		},
	};
}
