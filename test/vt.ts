const ESC = String.fromCharCode(27);

/** One physical row. `wrapped` means it continues onto the row below. */
type Row = {text: string; wrapped: boolean};

const CSI = new RegExp(`${ESC}\\[([0-9;?]*)([A-Za-z])`, 'y');

/**
 * A terminal emulator good enough to catch what a frame-collecting stub cannot.
 *
 * `test/terminal.tsx` used to keep the raw `write()` calls and measure the
 * newest one. That can never see a rendering bug, because a rendering bug is by
 * definition about what is left on the screen *after* the escapes are applied:
 * erases that clear too few rows, cursor moves that land in the wrong place,
 * and rows from earlier frames that nobody cleaned up.
 *
 * So this composites. It applies the escapes Ink actually emits (captured from
 * a live drag: `2K`, `1A`, `G`, `2J`/`3J`, `?2026h/l`, `?25l/h`, plus text and
 * newlines), wraps text at the current width, and — the part that matters —
 * **reflows on resize** the way xterm, VTE, and iTerm2 do: contiguous wrapped
 * rows are rejoined into one logical line and re-split at the new width. That
 * reflow is what turns a row written at 100 columns into two rows at 96, which
 * is what makes Ink's line-counted erase come up short.
 */
export class Vt {
	width: number;
	height: number;
	private rows: Row[] = [{text: '', wrapped: false}];
	private row = 0;
	private column = 0;
	/** Set when the cursor is parked at the right margin, as VT terminals do. */
	private pendingWrap = false;

	constructor(width: number, height: number) {
		this.width = Math.max(1, width);
		this.height = Math.max(1, height);
	}

	private at(index: number): Row {
		while (this.rows.length <= index) {
			this.rows.push({text: '', wrapped: false});
		}
		const row = this.rows[index];
		if (row === undefined) {
			const fresh = {text: '', wrapped: false};
			this.rows[index] = fresh;
			return fresh;
		}
		return row;
	}

	private putChar(char: string): void {
		if (this.pendingWrap) {
			this.at(this.row).wrapped = true;
			this.row += 1;
			this.column = 0;
			this.pendingWrap = false;
		}
		const row = this.at(this.row);
		const padded = row.text.padEnd(this.column, ' ');
		row.text = padded.slice(0, this.column) + char + padded.slice(this.column + 1);
		this.column += 1;
		if (this.column >= this.width) {
			this.column = this.width;
			this.pendingWrap = true;
		}
	}

	/** Feeds one chunk of what a program wrote to stdout. */
	write(chunk: string): void {
		let index = 0;
		while (index < chunk.length) {
			const char = chunk[index] ?? '';

			if (char === ESC) {
				CSI.lastIndex = index;
				const match = CSI.exec(chunk);
				if (match) {
					this.csi(match[1] ?? '', match[2] ?? '');
					index = CSI.lastIndex;
					continue;
				}
				// Any other escape (OSC, single-char) is skipped, not printed.
				index += 2;
				continue;
			}

			if (char === '\n') {
				// stdout keeps ONLCR, so a bare LF is a carriage return + line feed.
				this.row += 1;
				this.column = 0;
				this.pendingWrap = false;
				this.at(this.row);
				index += 1;
				continue;
			}

			if (char === '\r') {
				this.column = 0;
				this.pendingWrap = false;
				index += 1;
				continue;
			}

			this.putChar(char);
			index += 1;
		}
	}

	private csi(parameters: string, final: string): void {
		if (parameters.startsWith('?')) {
			// Private modes: cursor visibility, synchronised output. No effect here.
			return;
		}
		const parts = parameters.split(';');
		const first = Number.parseInt(parts[0] ?? '', 10);
		const count = Number.isNaN(first) ? 1 : first;
		const mode = Number.isNaN(first) ? 0 : first;

		switch (final) {
			case 'A': {
				this.row = Math.max(0, this.row - count);
				this.pendingWrap = false;
				break;
			}
			case 'B': {
				this.row += count;
				this.at(this.row);
				this.pendingWrap = false;
				break;
			}
			case 'C': {
				this.column = Math.min(this.width - 1, this.column + count);
				this.pendingWrap = false;
				break;
			}
			case 'D': {
				this.column = Math.max(0, this.column - count);
				this.pendingWrap = false;
				break;
			}
			case 'E': {
				this.row += count;
				this.column = 0;
				this.at(this.row);
				this.pendingWrap = false;
				break;
			}
			case 'G': {
				this.column = Math.max(0, (Number.isNaN(first) ? 1 : first) - 1);
				this.pendingWrap = false;
				break;
			}
			case 'H': {
				// Positions are relative to the visible window, not the buffer.
				const top = Math.max(0, this.rows.length - this.height);
				const wantedRow = Number.parseInt(parts[0] ?? '', 10);
				const wantedColumn = Number.parseInt(parts[1] ?? '', 10);
				this.row = top + (Number.isNaN(wantedRow) ? 1 : wantedRow) - 1;
				this.column = (Number.isNaN(wantedColumn) ? 1 : wantedColumn) - 1;
				this.at(this.row);
				this.pendingWrap = false;
				break;
			}
			case 'J': {
				if (mode === 2) {
					// Clear the visible screen; scrollback above it survives.
					const top = Math.max(0, this.rows.length - this.height);
					for (let index = top; index < this.rows.length; index++) {
						this.rows[index] = {text: '', wrapped: false};
					}
				} else if (mode === 3) {
					this.rows = [{text: '', wrapped: false}];
					this.row = 0;
					this.column = 0;
				} else {
					this.at(this.row).text = this.at(this.row).text.slice(0, this.column);
					this.at(this.row).wrapped = false;
					this.rows.length = this.row + 1;
				}
				this.pendingWrap = false;
				break;
			}
			case 'K': {
				const row = this.at(this.row);
				if (mode === 1) {
					row.text = ' '.repeat(this.column) + row.text.slice(this.column);
				} else if (mode === 2) {
					row.text = '';
					row.wrapped = false;
				} else {
					row.text = row.text.slice(0, this.column);
					row.wrapped = false;
				}
				this.pendingWrap = false;
				break;
			}
			default: {
				// SGR and friends carry no geometry.
				break;
			}
		}
	}

	/**
	 * Re-wraps the buffer the way a real terminal does when the window is
	 * dragged: wrapped runs are rejoined, then split again at the new width.
	 */
	resize(width: number, height: number): void {
		const next = Math.max(1, width);
		this.height = Math.max(1, height);
		if (next === this.width) {
			return;
		}

		// Rejoin, remembering where the cursor sits inside its logical line.
		const logical: string[] = [];
		let cursorLine = 0;
		let cursorOffset = 0;
		let current = '';
		let started = true;
		for (const [index, row] of this.rows.entries()) {
			if (started) {
				current = '';
				started = false;
			}
			if (index === this.row) {
				cursorLine = logical.length;
				cursorOffset = current.length + this.column;
			}
			current += row.text.padEnd(row.wrapped ? this.width : 0, ' ');
			if (!row.wrapped) {
				logical.push(current);
				started = true;
			}
		}
		if (!started) {
			logical.push(current);
		}

		this.width = next;
		this.rows = [];
		let cursorRow = 0;
		for (const [index, line] of logical.entries()) {
			const start = this.rows.length;
			const chunks = Math.max(1, Math.ceil(line.length / next));
			for (let piece = 0; piece < chunks; piece++) {
				this.rows.push({
					text: line.slice(piece * next, (piece + 1) * next).replace(/\s+$/, ''),
					wrapped: piece < chunks - 1,
				});
			}
			if (index === cursorLine) {
				cursorRow = start + Math.floor(cursorOffset / next);
				this.column = cursorOffset % next;
			}
		}
		if (this.rows.length === 0) {
			this.rows.push({text: '', wrapped: false});
		}
		this.row = Math.min(cursorRow, this.rows.length - 1);
		this.pendingWrap = false;
	}

	/** Every row the buffer holds, oldest first, trailing blanks trimmed. */
	buffer(): string[] {
		const all = this.rows.map(row => row.text.replace(/\s+$/, ''));
		while (all.length > 0 && all.at(-1) === '') {
			all.pop();
		}
		return all;
	}

	/** What the window is showing right now. */
	screen(): string[] {
		return this.buffer().slice(-this.height);
	}
}
