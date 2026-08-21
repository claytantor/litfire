import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {Project} from '../core/project.js';
import {parseDocument} from '../vault/frontmatter.js';
import {wikiBriefingFor} from '../wiki/grounding.js';
import {resolve, VAULT} from '../vault/paths.js';
import type {InterviewKind} from './prompts.js';

/**
 * Character budget for injected corpus. Generous enough for a real vault,
 * bounded so a large one cannot crowd out the persona or the conversation.
 * Characters rather than tokens because the four providers tokenize
 * differently and this only needs to be a safety rail.
 */
const DEFAULT_BUDGET = 24_000;

/**
 * Held back from the corpus budget so the placeholder caution always fits. It
 * is the one section that must never be dropped — without it the interviewer
 * can reach for a scaffold name and interview the author about a character they
 * never invented.
 */
const CAUTION_RESERVE = 460;

/**
 * Directories that matter to each interview, most relevant first.
 *
 * `factions/` and `places/` are in almost all of them, which looks like
 * over-inclusion and is not. They are where spillover lands, and nothing else in
 * the corpus points at a faction file (see `wiki/build.ts`) — so if no interview
 * reads them back, a faction raised during `/system` is a page nobody ever sees
 * again. The next interview re-asks about the same group, spillover drops the
 * stub because the file already exists, and the author answers the same question
 * twice for nothing. Reading them back is what makes spillover compound instead
 * of loop.
 *
 * The budget is unchanged and spent in this order, so they fill what is left
 * after each interview's own corpus rather than crowding it out.
 */
const RELEVANT: Readonly<Record<InterviewKind, readonly string[]>> = {
	system: [VAULT.setting, VAULT.systems, VAULT.artifacts, VAULT.factions],
	character: [
		VAULT.characters,
		VAULT.systems,
		VAULT.artifacts,
		VAULT.factions,
		VAULT.places,
	],
	// A moment is defined by what it changed, so the pages that record
	// consequences come before the ones that record structure.
	moment: [VAULT.moments, VAULT.arcs, VAULT.factions, VAULT.places],
	arc: [VAULT.arcs, VAULT.moments, VAULT.characters, VAULT.situations],
	place: [VAULT.places, VAULT.situations, VAULT.factions],
	// A scene is placed by its cast, its where and its when — which is exactly
	// what this interview is for, so those three come first.
	situation: [VAULT.situations, VAULT.characters, VAULT.places, VAULT.moments],
	faction: [VAULT.factions, VAULT.characters, VAULT.places, VAULT.themes],
	artifact: [VAULT.artifacts, VAULT.systems, VAULT.characters],
	theme: [VAULT.themes, VAULT.characters, VAULT.factions],
	chapter: [VAULT.chapters, VAULT.situations, VAULT.arcs],
};

async function readIfPresent(file: string): Promise<string | undefined> {
	return readFile(file, 'utf8').catch(() => undefined);
}

async function listMarkdown(directory: string): Promise<string[]> {
	const entries = await readdir(directory, {withFileTypes: true}).catch(() => []);
	return entries
		.filter(entry => entry.isFile() && entry.name.endsWith('.md'))
		.map(entry => path.join(directory, entry.name))
		.toSorted();
}

export type GroundingOptions = {
	readonly budget?: number;
	/** Narrows `character` grounding to one character page. */
	readonly focus?: string | undefined;
	/**
	 * When supplied, the computed wiki cross-reference is appended. It is not
	 * charged against the corpus budget: the corpus says what the author wrote,
	 * the wiki says what the ledger worked out, and dropping one to fit the other
	 * would trade a whole category of fact for a few more paragraphs of prose.
	 */
	readonly project?: Project;
};

/**
 * Builds the corpus context injected into the interviewer's system prompt.
 *
 * "You established that the System takes memory as payment — does that apply to
 * Donut too?" is the whole point: an interviewer that has read the vault never
 * re-asks and can push on contradictions. Files are included whole, in
 * relevance order, until the budget runs out; a file that would overflow is
 * skipped rather than truncated mid-sentence.
 */
export async function buildGrounding(
	root: string,
	kind: InterviewKind,
	options: GroundingOptions = {},
): Promise<string> {
	const fullBudget = options.budget ?? DEFAULT_BUDGET;
	const sections: string[] = [];
	let used = 0;
	const seen = new Set<string>();

	// Reserved up front rather than spent at the end, so a large corpus cannot
	// crowd the caution out.
	let budget = Math.max(0, fullBudget - CAUTION_RESERVE);

	const add = (label: string, body: string) => {
		const trimmed = body.trim();
		if (trimmed === '') {
			return;
		}
		const block = `## ${label}\n\n${trimmed}`;
		if (used + block.length > budget) {
			return;
		}
		sections.push(block);
		used += block.length;
	};

	let examplesSkipped = 0;

	const addFile = async (file: string) => {
		if (seen.has(file)) {
			return;
		}
		seen.add(file);
		const body = await readIfPresent(file);
		if (body === undefined) {
			return;
		}

		// `/init` seeds narrative placeholders so the vault opens as a connected
		// graph in Obsidian. They are NOT the author's world, and an interviewer
		// that reads them will interview the author about a character they never
		// invented — asking "where was Carl standing?" of someone who has no Carl.
		if (parseDocument(body).data['example'] === true) {
			examplesSkipped += 1;
			return;
		}

		add(path.relative(root, file), body);
	};

	// index.md first: it is the LLM-maintained catalog and the cheapest possible
	// map of what exists.
	await addFile(resolve(root, VAULT.index));

	for (const directory of RELEVANT[kind]) {
		for (const file of await listMarkdown(resolve(root, directory))) {
			// A focused interview reads its own subject's page and skips its
			// siblings: interviewing about the Lathe should not hand the model
			// another system's stats to confuse it with.
			const namespaced =
				(kind === 'character' && directory === VAULT.characters) ||
				(kind === 'system' && directory === VAULT.systems);
			if (
				namespaced &&
				options.focus !== undefined &&
				path.basename(file, '.md') !== options.focus
			) {
				continue;
			}
			await addFile(file);
		}
	}

	if (examplesSkipped > 0) {
		// The caution ships even if a pathologically small budget cannot hold it:
		// dropping it would let a scaffold name reach the interviewer, which is
		// the failure this whole filter exists to prevent.
		budget = fullBudget;
		// Always say this, not only when the corpus is otherwise empty: the
		// system schema files are legitimately present, and without the caution
		// the interviewer can still reach for a placeholder name it saw earlier.
		sections.push(
			[
				'## Not established',
				'',
				`This vault contains ${examplesSkipped} scaffold placeholder file(s) written`,
				'by `/init`, and they have been withheld from you deliberately. No',
				'character, place, event, or theme in them was invented by this author.',
				'Do not use any name or title from them, and do not refer to them.',
				'Until the author names their protagonist, say "your protagonist".',
			].join('\n'),
		);
	}

	if (options.project !== undefined) {
		const briefing = wikiBriefingFor(
			options.project,
			options.focus === undefined ? {} : {focus: [options.focus]},
		);
		if (briefing !== '') {
			sections.push(briefing);
		}
	}

	return sections.join('\n\n');
}
