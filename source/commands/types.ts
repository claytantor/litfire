import type {Project} from '../core/project.js';
import type {SourceKind} from '../ingest/index.js';
import type {InterviewKind} from '../interview/prompts.js';
import type {Proposal} from '../review/types.js';

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
		readonly kind: InterviewKind;
		readonly focus?: string | undefined;
		/** Continue the most recent unfinished interview of this kind. */
		readonly resume?: boolean;
		/**
		 * What the checks found unresolved for this kind, already rendered for
		 * the model. Computed by the command because that is what holds the
		 * project; App only carries it to the session.
		 */
		readonly agenda?: string;
	};
	/**
	 * Opens the reviewer over the whole rendered corpus. Unlike an interview,
	 * the author drives — and the only writes it can propose are corrections.
	 */
	readonly reviewer?: boolean;
	/**
	 * Opens the curator over the raw material *and* the corpus. Where the
	 * reviewer may only correct, the curator may restructure — so every write
	 * it proposes goes through the same review gate, one diff at a time.
	 */
	readonly curator?: boolean;
	/**
	 * Turns the author's notes in `raw/<kind>/` into typed pages.
	 *
	 * Runs a model pass, so App owns it: the command's job is to say which kind
	 * and which document, having already checked there is something to read.
	 */
	readonly ingest?: {
		readonly kind: SourceKind;
		/** A filename stem in the raw directory; absent means all of them. */
		readonly focus?: string | undefined;
		/**
		 * Read notes the corpus already reflects, rather than skipping them.
		 *
		 * Idempotency is keyed on the note, so a change to what ingest *asks for*
		 * leaves every page stale with nothing able to tell. This is the author
		 * saying they know, and it costs one request per note.
		 */
		readonly again?: boolean;
	};
	/**
	 * Asks the author one yes-or-no question before going any further.
	 *
	 * `proceed` is an ordinary `CommandResult` — whatever the command would have
	 * returned had it just gone ahead — so a confirmed action is dispatched by
	 * exactly the same code as an unconfirmed one, and a command that asks stays
	 * as testable as one that does not. No callbacks: a handler still returns
	 * plain data, which is the property that lets the whole registry be tested
	 * without a renderer.
	 *
	 * The default is **no**. Every use of this so far is a question about
	 * spending something the author may not want to spend — a model session, a
	 * fifty-diff review — and for those, `return` should be the cheap answer.
	 *
	 * `lines` are printed above the prompt, so a command explains itself before
	 * it asks.
	 */
	readonly confirm?: {
		/** Without the `y/N`, which the prompt renders itself. */
		readonly question: string;
		/**
		 * Dispatched if the author says yes.
		 *
		 * Named `proceed` rather than `then` because an object carrying a `then`
		 * key sits one careless `await` away from being treated as a thenable.
		 */
		readonly proceed: CommandResult;
		/** Printed if they decline. A plain acknowledgement when absent. */
		readonly declined?: string;
	};
	/**
	 * Derives a stats model for one system from the screen its author drew.
	 *
	 * Runs a model pass, so App owns it: the command's job is to say which
	 * system, having already checked there is one and that a provider exists.
	 */
	readonly generateStats?: {
		readonly system: string;
	};
	/**
	 * Gives authored corpus pages a note in `raw/` to have come from.
	 *
	 * Unlike `ingest`, the proposals arrive already computed: adoption is a copy
	 * of what the page says, not an inference about it, so the command does the
	 * whole job and App only has to open the gate. Writing into `raw/` needs
	 * `allowRaw` on the batch — the one other place that is granted is the
	 * curator.
	 */
	readonly adopt?: {
		readonly proposals: readonly Proposal[];
		readonly title: string;
	};
	/**
	 * Opens a vault file in the native prose buffer, by absolute path.
	 *
	 * Only the body is editable; the frontmatter is written back byte-identical.
	 * A situation's frontmatter is the part other commands and the extractor
	 * maintain, and the buffer is for the half that is the author's alone (P6).
	 */
	readonly openEditor?: string;
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
