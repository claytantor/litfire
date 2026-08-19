import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseDocument, stringifyDocument} from '../vault/frontmatter.js';
import {resolve, VAULT} from '../vault/paths.js';
import {interviewKindSchema, type InterviewKind} from './prompts.js';

export type Exchange = {
	readonly question: string;
	readonly answer: string;
};

/**
 * `in-progress` until the author wraps up. The distinction is what makes an
 * interview resumable: an interview is saved after every exchange, so a stray
 * `esc`, a crash, or simply stopping for the day leaves a transcript that can
 * be picked up later rather than ten exchanges of lost work.
 */
export type TranscriptStatus = 'in-progress' | 'complete';

export type Transcript = {
	readonly id: string;
	readonly kind: InterviewKind;
	readonly startedAt: string;
	readonly focus?: string | undefined;
	readonly status: TranscriptStatus;
	readonly exchanges: readonly Exchange[];
};

export const INTERVIEWS_DIR = `${VAULT.raw}/interviews`;

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

export function transcriptId(kind: InterviewKind, at: Date, focus?: string): string {
	const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
	return focus ? `${kind}-${slug(focus)}-${stamp}` : `${kind}-${stamp}`;
}

/**
 * Transcripts are stored as markdown in `raw/`, not as JSON in `.litrpg/`.
 *
 * The spec is explicit that they *are* corpus — exactly the unstructured
 * author-supplied facts the wiki layer consumes — so they must be readable in
 * Obsidian, survive deleting the cache (DoD 11), and stay re-extractable after
 * the schema evolves.
 */
export function renderTranscript(transcript: Transcript): string {
	const body = transcript.exchanges
		.flatMap((exchange, index) => [
			`### ${index + 1}. Interviewer`,
			'',
			exchange.question.trim(),
			'',
			'### Author',
			'',
			exchange.answer.trim(),
			'',
		])
		.join('\n');

	return stringifyDocument({
		data: {
			id: transcript.id,
			kind: transcript.kind,
			started_at: transcript.startedAt,
			...(transcript.focus === undefined ? {} : {focus: transcript.focus}),
			status: transcript.status,
			exchanges: transcript.exchanges.length,
			generated: false,
		},
		body: `\n# Interview — ${transcript.kind}\n\n${body}`,
	});
}

export function parseTranscript(raw: string): Transcript | undefined {
	const {data, body} = parseDocument(raw);
	const kind = interviewKindSchema.safeParse(data['kind']);
	if (!kind.success || typeof data['id'] !== 'string') {
		return undefined;
	}

	// Split on the heading pairs written by `renderTranscript`.
	const exchanges: Exchange[] = [];
	const blocks = body.split(/^### \d+\. Interviewer$/m).slice(1);
	for (const block of blocks) {
		const [question = '', answer = ''] = block.split(/^### Author$/m);
		exchanges.push({question: question.trim(), answer: answer.trim()});
	}

	return {
		id: data['id'],
		kind: kind.data,
		startedAt: typeof data['started_at'] === 'string' ? data['started_at'] : '',
		...(typeof data['focus'] === 'string' ? {focus: data['focus']} : {}),
		// A transcript with no `status` predates the field. Treat it as resumable
		// rather than complete: offering a resume the author declines costs one
		// keystroke, while refusing one silently costs them the whole interview.
		status: data['status'] === 'complete' ? 'complete' : 'in-progress',
		exchanges,
	};
}

export async function saveTranscript(
	root: string,
	transcript: Transcript,
): Promise<string> {
	const directory = resolve(root, INTERVIEWS_DIR);
	await mkdir(directory, {recursive: true});
	const file = path.join(directory, `${transcript.id}.md`);
	await writeFile(file, renderTranscript(transcript), 'utf8');
	return file;
}

export async function listTranscripts(root: string): Promise<Transcript[]> {
	const directory = resolve(root, INTERVIEWS_DIR);
	const entries = await readdir(directory).catch(() => [] as string[]);
	const found: Transcript[] = [];

	for (const entry of entries.toSorted()) {
		if (!entry.endsWith('.md')) {
			continue;
		}
		const raw = await readFile(path.join(directory, entry), 'utf8').catch(
			() => undefined,
		);
		const parsed = raw === undefined ? undefined : parseTranscript(raw);
		if (parsed) {
			found.push(parsed);
		}
	}

	return found;
}

/**
 * Every transcript of a kind that has answers in it, newest first.
 *
 * Matched on `focus` too, so an abandoned `/character nyx` does not offer
 * itself when the author starts `/character vale`.
 */
const byRecency = (a: Transcript, b: Transcript) =>
	b.startedAt.localeCompare(a.startedAt);

async function candidates(
	root: string,
	kind: InterviewKind,
	focus?: string | undefined,
): Promise<Transcript[]> {
	const all = (await listTranscripts(root)).filter(
		transcript => transcript.kind === kind && transcript.exchanges.length > 0,
	);
	const exact = all.filter(transcript => transcript.focus === focus);
	if (focus === undefined || exact.length > 0) {
		return exact.toSorted(byRecency);
	}

	// Systems became namespaced after transcripts already existed, so every
	// `/system` interview recorded before then has no focus at all. Falling back
	// to those rather than reporting nothing is what keeps an author's own
	// answers reachable: the alternative is a vault full of interviews the tool
	// declines to find.
	return all.filter(transcript => transcript.focus === undefined).toSorted(byRecency);
}

/**
 * Every transcript of a kind that has answers in it, oldest first.
 *
 * `/<kind> extract all` sweeps in this order so the earliest interview to
 * mention something is the one credited with raising it, and the newest one —
 * which saw the most corpus — is the one whose corpus writes survive.
 */
export async function transcriptsForKind(
	root: string,
	kind: InterviewKind,
	focus?: string | undefined,
): Promise<Transcript[]> {
	return (await candidates(root, kind, focus)).toReversed();
}

/**
 * The most recent unfinished interview of a kind, if there is one.
 *
 * This drives the *unprompted* offer, so it is deliberately strict: a bare
 * `/system` should not nag about reopening work the author already wrapped up.
 */
export async function findResumable(
	root: string,
	kind: InterviewKind,
	focus?: string | undefined,
): Promise<Transcript | undefined> {
	return (await candidates(root, kind, focus)).find(
		transcript => transcript.status === 'in-progress',
	);
}

/**
 * What `/<kind> resume` should continue — an explicit ask, so it is deliberately
 * permissive where {@link findResumable} is strict.
 *
 * Unfinished work wins. Failing that it reopens the most recent transcript even
 * if it was marked complete, because "there is no interview to resume" is a lie
 * when one is sitting in `raw/interviews/` with the author's answers in it. An
 * author who wraps up and then thinks of more to say is asking a reasonable
 * question; refusing them costs real work, and reopening costs an `esc`.
 */
export async function findForResume(
	root: string,
	kind: InterviewKind,
	focus?: string | undefined,
): Promise<{transcript: Transcript; reopened: boolean} | undefined> {
	const all = await candidates(root, kind, focus);
	const unfinished = all.find(transcript => transcript.status === 'in-progress');
	if (unfinished) {
		return {transcript: unfinished, reopened: false};
	}

	const latest = all[0];
	return latest === undefined ? undefined : {transcript: latest, reopened: true};
}
