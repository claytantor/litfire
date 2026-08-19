import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {INTERVIEWS_DIR, listTranscripts, type Transcript} from '../interview/index.js';
import {resolve} from '../vault/paths.js';

/**
 * What the architect can see of `raw/`.
 *
 * An inventory always ships; full text arrives only for the transcripts a
 * question is actually about. A vault with a dozen 45KB interviews would spend
 * its whole context on material nobody asked about, and the architect would
 * answer its fifth question with the transcripts that mattered to its first.
 */

export type TranscriptSummary = {
	readonly id: string;
	readonly kind: string;
	readonly focus: string | undefined;
	readonly exchanges: number;
	readonly chars: number;
	readonly startedAt: string;
	readonly status: string;
};

export function summarise(transcript: Transcript): TranscriptSummary {
	return {
		id: transcript.id,
		kind: transcript.kind,
		focus: transcript.focus,
		exchanges: transcript.exchanges.length,
		chars: transcript.exchanges.reduce(
			(total, exchange) => total + exchange.question.length + exchange.answer.length,
			0,
		),
		startedAt: transcript.startedAt,
		status: transcript.status,
	};
}

export function renderInventory(summaries: readonly TranscriptSummary[]): string {
	if (summaries.length === 0) {
		return '_No interviews recorded yet._';
	}
	return summaries
		.map(
			summary =>
				`- \`${summary.id}\` — ${summary.kind}${summary.focus === undefined ? '' : ` · ${summary.focus}`}, ${String(summary.exchanges)} exchange(s), ${String(summary.chars)} chars, ${summary.status}`,
		)
		.join('\n');
}

/**
 * Scores a transcript against the question, the same shape `selectRelevant`
 * uses for corpus files: an id or a distinctive word the author typed is a
 * better relevance signal than recency, because the author is usually asking
 * about the thing they just named.
 */
function scoreFor(summary: TranscriptSummary, question: string): number {
	const asked = question.toLowerCase();
	let score = 0;
	if (asked.includes(summary.id.toLowerCase())) {
		score += 100;
	}
	if (asked.includes(summary.kind)) {
		score += 10;
	}
	if (summary.focus !== undefined && asked.includes(summary.focus.toLowerCase())) {
		score += 50;
	}
	return score;
}

export type RawContext = {
	readonly inventory: readonly TranscriptSummary[];
	/** Vault-relative path → full markdown, for the transcripts worth shipping. */
	readonly included: ReadonlyMap<string, string>;
};

/** Characters of transcript text a single turn may carry. */
const BUDGET = 40_000;

export async function buildRawContext(
	root: string,
	question: string,
	limit = BUDGET,
): Promise<RawContext> {
	const transcripts = await listTranscripts(root);
	const inventory = transcripts.map(summarise);

	const ranked = inventory
		.map(summary => ({summary, score: scoreFor(summary, question)}))
		.filter(entry => entry.score > 0)
		.toSorted(
			(a, b) =>
				b.score - a.score || b.summary.startedAt.localeCompare(a.summary.startedAt),
		);

	// Nothing named: the most recent one is the best guess at what "the
	// interview" means, and shipping one beats shipping none.
	const chosen =
		ranked.length > 0
			? ranked.map(entry => entry.summary)
			: inventory.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 1);

	const included = new Map<string, string>();
	let used = 0;
	for (const summary of chosen) {
		const relative = `${INTERVIEWS_DIR}/${summary.id}.md`;
		const body = await readFile(resolve(root, relative), 'utf8').catch(() => undefined);
		if (body === undefined || used + body.length > limit) {
			continue;
		}
		included.set(relative.split(path.sep).join('/'), body);
		used += body.length;
	}

	return {inventory, included};
}

export function renderRawContext(context: RawContext): string {
	const sections = ['## Interviews on record', '', renderInventory(context.inventory)];

	for (const [file, body] of context.included) {
		sections.push('', `## ${file}`, '', body.trim());
	}

	return sections.join('\n');
}
