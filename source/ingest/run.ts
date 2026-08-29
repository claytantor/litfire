import {runPlan} from '../curator/index.js';
import type {Project} from '../core/project.js';
import {loadSetting} from '../genre/index.js';
import type {Provider} from '../llm/index.js';
import type {Proposal} from '../review/types.js';
import {calendarFor} from '../time/binding.js';
import {resolveDates} from './dates.js';
import {buildIngest, readRaw, type SourceKind} from './index.js';
import {
	hashSource,
	honourAuthored,
	readIngestState,
	stampSource,
	statusOf,
} from './state.js';

/**
 * The ingest pass, with no screen attached.
 *
 * This was inline in `App`'s `runIngest`, woven through `append` and
 * `setBusyLabel`. It moved here the moment a second caller existed — the
 * headless exec surface has to run *this* pass and not a second one written to
 * look like it, or the two drift and the vault gets pages that depend on which
 * door the author came through.
 *
 * Progress and problems are reported through callbacks rather than returned at
 * the end, because a pass over twelve notes that says nothing for two minutes
 * reads as a hang. What it returns is only what the gate needs.
 */

export type IngestPass = {
	readonly proposals: readonly Proposal[];
	/** Things worth telling the author that are not failures. */
	readonly notes: readonly string[];
	/** How many notes were actually read this time. */
	readonly read: number;
	/** Notes that exist but were skipped because the corpus already reflects them. */
	readonly unchanged: number;
};

export type IngestHooks = {
	/** Called before each note, with a 1-based position. */
	readonly onProgress?: (path: string, index: number, total: number) => void;
	/** A per-note failure. The pass continues; one bad note is not the batch. */
	readonly onProblem?: (message: string) => void;
};

export async function runIngestPass(
	root: string,
	project: Project,
	provider: Provider,
	kind: SourceKind,
	options: {
		readonly focus?: string | undefined;
		readonly again?: boolean;
		readonly signal?: AbortSignal;
	} = {},
	hooks: IngestHooks = {},
): Promise<IngestPass> {
	const {documents} = await readRaw(root, kind, options.focus);
	const {profile} = await loadSetting(root);
	const {calendar} = calendarFor(project.vault.time);
	const state = await readIngestState(root, kind);

	// `again` reads them all, including the ones the corpus already reflects: a
	// change to what ingest *asks for* leaves every page stale with no hash able
	// to see it, because the note did not move.
	const pending =
		options.again === true
			? documents
			: documents.filter(
					document => statusOf(state, document.path, document.contents) !== 'unchanged',
				);

	const proposals: Proposal[] = [];
	const notes: string[] = [];

	/**
	 * One note per pass, rather than all of them in one context.
	 *
	 * Provenance needs it: a page has to record which note it came from, and a
	 * single pass over four notes cannot say which of them produced what. It is
	 * also better curation — four characters in one request bleed into each
	 * other, and one at a time each gets the whole instruction.
	 */
	for (const [index, document] of pending.entries()) {
		hooks.onProgress?.(document.path, index + 1, pending.length);

		const {instruction, context} = await buildIngest(root, project, kind, [document]);
		const outcome = await runPlan(
			provider,
			root,
			instruction,
			context,
			profile.register ?? '',
			// A headless run has nothing to press ctrl+c into mid-pass, so it
			// supplies no signal; the TUI does.
			options.signal ?? new AbortController().signal,
		);

		if (outcome.error !== undefined) {
			hooks.onProblem?.(`${document.path}: ${outcome.error}`);
			continue;
		}
		for (const refusal of outcome.refusals) {
			hooks.onProblem?.(`refused ${refusal.path}: ${refusal.reason}`);
		}

		// Stamped here, in code. The model cannot compute a digest, and a page
		// carrying a plausible-looking one would be trusted by every later ingest.
		const hash = hashSource(document.contents);
		for (const proposal of outcome.proposals) {
			if (proposal.remove === true) {
				proposals.push(proposal);
				continue;
			}

			// A date the note stated becomes a position on the clock here, in code.
			// The model was asked for the date because it can read one off the page;
			// it was not asked for the arithmetic, across a timezone with daylight
			// saving and spans of geological time, because a plausible-looking
			// number that lands in the ledger is the failure this tool exists to
			// prevent.
			const dated = resolveDates(proposal.contents, calendar);
			notes.push(...dated.notes.map(note => `${document.path}: ${note}`));

			proposals.push({
				...proposal,
				// The author's own fields go back on last, so a decision they made
				// outranks anything the model chose.
				contents: stampSource(
					honourAuthored(dated.contents, document),
					document.path,
					hash,
				),
			});
		}
		notes.push(...outcome.notes.map(note => `${document.path}: ${note}`));
	}

	return {
		proposals,
		notes,
		read: pending.length,
		unchanged: documents.length - pending.length,
	};
}
