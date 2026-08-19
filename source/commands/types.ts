import type {Project} from '../core/project.js';

export type Line = {
	readonly text: string;
	readonly color?: string;
	readonly dim?: boolean;
	readonly bold?: boolean;
};

export type CommandResult = {
	readonly lines: readonly Line[];
	/**
	 * Tall output goes to the windowed pager instead of the dynamic region, so
	 * Ink never has to clear-and-redraw a screenful (§10 Layout).
	 */
	readonly paged?: boolean;
	readonly title?: string;
	/** Set when the command changed the vault and state must be recomputed. */
	readonly dirty?: boolean;
	/** Hands the screen to an interactive flow instead of printing output. */
	readonly wizard?: 'provider';
	/** Starts a conversational interview (§9) on this vault. */
	readonly interview?: {
		readonly kind: 'system' | 'timeline' | 'character' | 'themes';
		readonly focus?: string | undefined;
		/** Continue the most recent unfinished interview of this kind. */
		readonly resume?: boolean;
	};
	/**
	 * Re-runs extraction over a saved interview transcript. Separate from
	 * `interview` because nothing is asked — the answers already exist, and only
	 * the corpus proposals are recomputed.
	 */
	readonly extract?: {
		readonly kind: 'system' | 'timeline' | 'character' | 'themes';
		readonly focus?: string | undefined;
		/**
		 * Sweep every transcript of this kind rather than only the latest. Costs
		 * one request per transcript, so it is never the default.
		 */
		readonly all?: boolean;
	};
	/**
	 * Opens the literary editor over the whole corpus. Unlike an interview, the
	 * author drives — and the only writes it can propose are corrections.
	 */
	readonly editor?: boolean;
	/**
	 * Opens the architect over the raw material *and* the corpus. Where the
	 * editor may only correct, the architect may restructure — so every write it
	 * proposes goes through the same review gate, one diff at a time.
	 */
	readonly architect?: boolean;
	/** Switches the active project to this absolute path. */
	readonly switchProject?: string;
	readonly exit?: boolean;
};

export type CommandContext = {
	readonly root: string;
	readonly project: Project | undefined;
	readonly activeCharacter: string | undefined;
	readonly setActiveCharacter: (id: string) => void;
	readonly consentFormulas: (hash: string) => void;
};

export type Command = {
	readonly name: string;
	readonly usage: string;
	readonly summary: string;
	run(args: readonly string[], context: CommandContext): Promise<CommandResult>;
};

export const text = (value: string, extra: Omit<Line, 'text'> = {}): Line => ({
	text: value,
	...extra,
});

export const blank = (): Line => ({text: ''});

export const heading = (value: string): Line => ({
	text: value,
	bold: true,
	color: '#ff6b35',
});

export const muted = (value: string): Line => ({text: value, dim: true});

export const error = (value: string): Line => ({text: value, color: '#f7768e'});

export const ok = (value: string): Line => ({text: value, color: '#9ece6a'});

/** Something worth saying that is not a failure — amber, the same as a contradiction. */
export const warn = (value: string): Line => ({text: value, color: '#e0af68'});

/** Left-pads a column set so tabular output lines up without a table lib. */
export function columns(rows: readonly (readonly string[])[], gap = 2): string[] {
	const widths: number[] = [];
	for (const row of rows) {
		row.forEach((cell, index) => {
			widths[index] = Math.max(widths[index] ?? 0, cell.length);
		});
	}

	return rows.map(row =>
		row
			.map((cell, index) =>
				index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0),
			)
			.join(' '.repeat(gap))
			.trimEnd(),
	);
}
