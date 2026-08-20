import {describe, expect, it, vi} from 'vitest';
import {STREAM_PAINT_MS, streamPainter} from '../source/hooks/use-stream-paint.js';

describe('coalescing a token stream', () => {
	it('paints far less often than tokens arrive', () => {
		vi.useFakeTimers();
		try {
			const set = vi.fn<(text: string) => void>();
			const paint = streamPainter(set);

			// A realistic reply: ~1200 tokens over ~12 seconds.
			for (let index = 0; index < 1200; index++) {
				paint.push('word ');
				vi.advanceTimersByTime(10);
			}
			paint.flush();

			// Was one render per token. Now bounded by elapsed time over the
			// interval: 12s at 50ms is ~240 frames, not 1200.
			expect(set.mock.calls.length).toBeLessThan(300);
			expect(set.mock.calls.length).toBeGreaterThan(100);
		} finally {
			vi.useRealTimers();
		}
	});

	it('never loses a token, however hard it throttles', () => {
		vi.useFakeTimers();
		try {
			const set = vi.fn<(text: string) => void>();
			const paint = streamPainter(set);

			// Everything inside one interval: only the flush should paint.
			for (const token of ['the ', 'ledger ', 'room']) {
				paint.push(token);
			}
			paint.flush();

			expect(paint.text).toBe('the ledger room');
			expect(set).toHaveBeenLastCalledWith('the ledger room');
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * The tail is where truncation would show: the last tokens almost always
	 * arrive inside the final interval, so without a flush a reply ends short
	 * until whatever replaces it lands.
	 */
	it('flushes the tail that arrived inside the last interval', () => {
		vi.useFakeTimers();
		try {
			const set = vi.fn<(text: string) => void>();
			const paint = streamPainter(set);

			paint.push('start');
			vi.advanceTimersByTime(STREAM_PAINT_MS + 1);
			paint.push(' middle');
			// Inside the interval, so this one does not paint on its own.
			paint.push(' end');

			expect(set).not.toHaveBeenCalledWith('start middle end');
			paint.flush();
			expect(set).toHaveBeenLastCalledWith('start middle end');
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not paint again when nothing changed since the last one', () => {
		vi.useFakeTimers();
		try {
			const set = vi.fn<(text: string) => void>();
			const paint = streamPainter(set);

			paint.push('once');
			vi.advanceTimersByTime(STREAM_PAINT_MS + 1);
			paint.push('');
			paint.flush();
			paint.flush();

			expect(set.mock.calls.filter(([text]) => text === 'once')).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('paints an empty stream not at all', () => {
		const set = vi.fn<(text: string) => void>();
		const paint = streamPainter(set);

		paint.flush();

		expect(set).not.toHaveBeenCalled();
		expect(paint.text).toBe('');
	});
});
