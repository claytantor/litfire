import {EventEmitter} from 'node:events';
import {render, type Instance} from 'ink';
import type {ReactNode} from 'react';
import {Vt} from './vt.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Frames arrive coloured; width assertions have to measure the text alone. */
export const strip = (frame: string): string => frame.replace(ANSI, '');

/** Widest visible row in a block of text, in columns. */
export const widest = (block: string): number =>
	Math.max(
		0,
		...strip(block)
			.split('\n')
			.map(row => row.length),
	);

/** Rows a block occupies, ignoring a trailing newline. */
export const heightOf = (block: string): number =>
	strip(block).replace(/\n$/, '').split('\n').length;

/**
 * A resizable stand-in for `process.stdout` that also *composites*.
 *
 * Two different questions get asked of this in tests and they need two
 * different answers:
 *
 * - `frame()` — what a single render drew. Good for "did this screen lay itself
 *   out inside its budget".
 * - `screen()` — what the terminal is actually showing, after every escape has
 *   been applied and after any resize has reflowed the buffer. Only this can
 *   see rows left behind by earlier frames, which is the entire class of bug a
 *   write-collecting stub is blind to.
 *
 * `ink-testing-library` offers neither: it hard-codes 100 columns and never
 * emits `resize`.
 */
class FakeStdout extends EventEmitter {
	columns: number;
	rows: number;
	readonly isTTY = true;
	readonly frames: string[] = [];
	readonly vt: Vt;

	constructor(columns: number, rows: number) {
		super();
		this.columns = columns;
		this.rows = rows;
		this.vt = new Vt(columns, rows);
	}

	write = (frame: string): boolean => {
		this.frames.push(frame);
		this.vt.write(frame);
		return true;
	};

	/**
	 * The last write that carried text.
	 *
	 * Ink brackets each frame with escape-only writes — synchronised-output
	 * markers, cursor hide/show, the erase that precedes a redraw — so the newest
	 * write is very often pure ANSI.
	 */
	get lastFrame(): string {
		for (let index = this.frames.length - 1; index >= 0; index--) {
			const frame = this.frames[index] ?? '';
			if (frame.replace(ANSI, '').trim() !== '') {
				return frame;
			}
		}
		return '';
	}

	/**
	 * Mimics a window being dragged: the terminal reflows what it is already
	 * showing *before* the program hears about it, which is exactly the ordering
	 * that leaves Ink's line-counted erase short.
	 */
	resize(columns: number, rows: number): void {
		this.vt.resize(columns, rows);
		this.columns = columns;
		this.rows = rows;
		this.emit('resize');
	}
}

class FakeStdin extends EventEmitter {
	readonly isTTY = true;
	private data: string | null = null;

	setEncoding(): void {}
	setRawMode(): void {}
	resume(): void {}
	pause(): void {}
	ref(): void {}
	unref(): void {}

	read = (): string | null => {
		const {data} = this;
		this.data = null;
		return data;
	};

	write = (data: string): void => {
		this.data = data;
		this.emit('readable');
		this.emit('data', data);
	};
}

export type Terminal = {
	readonly stdout: FakeStdout;
	readonly stdin: FakeStdin;
	readonly instance: Instance;
	/** The most recent frame a render drew, ANSI stripped. */
	frame(): string;
	/** Wait until something has been drawn, then let one more frame land. */
	paint(): Promise<void>;
	/** What the window is showing, after compositing. */
	screen(): string;
	/** Everything the terminal holds, scrollback included. */
	buffer(): string;
	/** Resize and wait for the frame that follows. */
	resize(columns: number, rows: number): Promise<void>;
	/** A drag: many small resizes, the way a window manager delivers them. */
	drag(steps: readonly (readonly [number, number])[]): Promise<void>;
	unmount(): void;
};

/** Ink batches frames; a tick is enough to see the next one. */
export const flush = (ms = 40): Promise<void> =>
	new Promise(done => {
		setTimeout(done, ms);
	});

/**
 * Waits for the screen to satisfy a predicate, rather than for a fixed delay.
 *
 * `flush(250)` encodes how long *this* machine happens to take to mount an app
 * and paint a frame. A slower shared CI runner takes longer, the assertion then
 * runs against an empty screen, and the failure reads as a rendering bug rather
 * than as a race. Polling costs nothing when the condition already holds, and
 * removes the guess when it does not.
 */
export async function waitFor(
	check: () => boolean,
	{timeout = 5000, interval = 25}: {timeout?: number; interval?: number} = {},
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (check()) {
			return;
		}
		await flush(interval);
	}
	throw new Error(`waitFor: condition still false after ${String(timeout)}ms`);
}

export function mount(
	node: ReactNode,
	columns = 80,
	rows = 24,
	// Left off by default so a frame is the *live* region alone, and so the
	// emulator sees the same escape stream a real terminal would. `debug: true`
	// re-emits every `<Static>` line on every render and skips the erase logic
	// entirely, which is not what ships.
	debug = false,
	/** Extra Ink render options, for probing modes like `incrementalRendering`. */
	extra: Record<string, unknown> = {},
): Terminal {
	const stdout = new FakeStdout(columns, rows);
	const stderr = new FakeStdout(columns, rows);
	const stdin = new FakeStdin();

	const instance = render(node, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: stderr as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug,
		exitOnCtrlC: false,
		patchConsole: false,
		...extra,
	});

	return {
		stdout,
		stdin,
		instance,
		frame: () => strip(stdout.lastFrame),
		/**
		 * Waits until something has actually been drawn, then lets one more frame
		 * land.
		 *
		 * Replaces `await flush()` after a mount. A fixed delay encodes how fast
		 * the machine running the suite happens to be, and on a shared CI runner
		 * the assertion lands on an empty screen — which reads as "the hints are
		 * missing" rather than as "nothing has painted yet". When content is
		 * already present this costs one tick, exactly as the old flush did.
		 */
		async paint() {
			await waitFor(() => strip(stdout.lastFrame).trim() !== '');
			await flush();
		},
		screen: () => stdout.vt.screen().join('\n'),
		buffer: () => stdout.vt.buffer().join('\n'),
		async resize(nextColumns: number, nextRows: number) {
			stdout.resize(nextColumns, nextRows);
			await flush();
		},
		async drag(steps) {
			for (const [nextColumns, nextRows] of steps) {
				stdout.resize(nextColumns, nextRows);
				await flush(60);
			}
		},
		unmount: () => {
			instance.unmount();
		},
	};
}
