import {readdir, stat} from 'node:fs/promises';
import type {InterviewKind} from './prompts.js';
import {resolve, VAULT} from '../vault/paths.js';
import {INGEST} from '../ingest/index.js';
import {listTranscripts, type Transcript} from './transcript.js';

/**
 * Interviews whose answers never reached the corpus.
 *
 * The interview → extraction → review → disk chain has three places it can end
 * without writing anything: extraction fails, the model proposes nothing, or
 * the author cancels the gate. All three are legitimate, and all three are
 * currently silent — the transcript sits in `raw/interviews/` holding real
 * answers while the corpus stays empty, and nothing says so.
 *
 * The signal is timestamps, not emptiness. `/init` seeds `system/stats.md` from
 * the profile's archetypes, so "the corpus is empty" is never true in a
 * scaffolded vault and a check built on it would never fire for anybody. What is
 * true is that a successful extraction writes its target *after* the interview
 * that produced it — so a transcript newer than everything its kind writes to is
 * an interview that went nowhere. That is exactly the mtime split that diagnosed
 * this the first time: transcript at 04:47, every corpus file still at 04:06.
 *
 * P4 holds — it reports, it never blocks, and it never re-runs anything itself.
 */

export type OrphanedInterview = {
	readonly kind: InterviewKind;
	readonly focus: string | undefined;
	readonly exchanges: number;
	readonly startedAt: string;
	/** What is missing, in the author's terms. */
	readonly detail: string;
};

/** The files each interview writes to, as `{files, directories}`. */
function targetsFor(
	kind: InterviewKind,
	focus: string | undefined,
): {files: string[]; directories: string[]} {
	// The two names that never matched a primitive, and so cannot be answered
	// from the ingest spec: `timeline` covers two folders, and the legacy
	// `system` interview wrote the pre-`systems/` trio.
	if (kind === 'timeline') {
		return {files: [], directories: [VAULT.moments, VAULT.arcs]};
	}
	if (kind === 'system') {
		return {
			files: [VAULT.stats, VAULT.skills, VAULT.curves, VAULT.formulas],
			directories: [VAULT.systems],
		};
	}

	// Everything else writes one folder, and a focused interview writes one page
	// inside it. Taken from the ingest spec rather than listed again here, so a
	// primitive cannot gain a folder and quietly stop being checked.
	const directory = INGEST[kind === 'themes' ? 'theme' : kind].to;
	return focus === undefined
		? {files: [], directories: [directory]}
		: {files: [`${directory}/${focus}.md`], directories: []};
}

/** The most recent write to anything this interview should have produced. */
async function newestWrite(
	root: string,
	targets: {files: string[]; directories: string[]},
): Promise<number> {
	const candidates = [...targets.files];

	for (const directory of targets.directories) {
		const entries = await readdir(resolve(root, directory)).catch(() => [] as string[]);
		for (const entry of entries.filter(name => name.endsWith('.md'))) {
			candidates.push(`${directory}/${entry}`);
		}
	}

	let newest = 0;
	for (const candidate of candidates) {
		const info = await stat(resolve(root, candidate)).catch(() => undefined);
		if (info !== undefined) {
			newest = Math.max(newest, info.mtimeMs);
		}
	}

	return newest;
}

function describe(kind: InterviewKind, focus: string | undefined): string {
	if (kind === 'timeline') {
		return 'nothing on the timeline has changed since';
	}
	if (kind === 'system') {
		return 'nothing under setting/ or corpus/systems/ has changed since';
	}

	const directory = INGEST[kind === 'themes' ? 'theme' : kind].to;
	return focus === undefined
		? `nothing under ${directory}/ has changed since`
		: `${directory}/${focus}.md has not changed since`;
}

/** Most recent first, so the reported exchange count is the freshest attempt. */
function newestFirst(a: Transcript, b: Transcript): number {
	return b.startedAt.localeCompare(a.startedAt);
}

export async function findOrphanedInterviews(root: string): Promise<OrphanedInterview[]> {
	const transcripts = (await listTranscripts(root)).filter(
		transcript => transcript.exchanges.length > 0,
	);

	// One finding per interview, not per transcript: three resumed sessions about
	// the same character are one problem, and listing them three times buries it.
	const bySubject = new Map<string, Transcript[]>();
	for (const transcript of transcripts) {
		const key = `${transcript.kind}\0${transcript.focus ?? ''}`;
		bySubject.set(key, [...(bySubject.get(key) ?? []), transcript]);
	}

	const orphans: OrphanedInterview[] = [];

	for (const group of bySubject.values()) {
		const [newest] = group.toSorted(newestFirst);
		if (newest === undefined) {
			continue;
		}

		const wrote = await newestWrite(root, targetsFor(newest.kind, newest.focus));
		// A successful extraction writes after the interview it came from, so a
		// corpus older than the transcript means nothing landed.
		if (wrote > Date.parse(newest.startedAt)) {
			continue;
		}

		orphans.push({
			kind: newest.kind,
			focus: newest.focus,
			// Summed across the group: resuming splits one interview's answers over
			// several files, and the total is what tells the author how much is at
			// stake in re-running it.
			exchanges: group.reduce((total, one) => total + one.exchanges.length, 0),
			startedAt: newest.startedAt,
			detail: describe(newest.kind, newest.focus),
		});
	}

	return orphans.toSorted((a, b) => a.kind.localeCompare(b.kind));
}
