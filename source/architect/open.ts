import {readFile} from 'node:fs/promises';
import path from 'node:path';

/** Files one request may open, and the bytes it may pull in total. */
export const MAX_FILES = 6;
export const MAX_BYTES = 40_000;

/**
 * How many times a question may go back for more files before answering.
 *
 * Two is enough for the case this exists for: read a page, discover it links a
 * second, read that. A third round is nearly always the model circling, and
 * each one costs a full request against the whole context.
 */
export const MAX_ROUNDS = 2;

/** Where a request starts. Everything after it is taken to be paths. */
const REQUEST_START = /^\s*READ:/im;

/** A vault-relative markdown path, as it appears in a request. */
const PATH = /[\w./@+-]+\.md/g;

/**
 * A single line that is a request rather than prose.
 *
 * Matched per line, because the prefix-of-the-reply test this replaced did not
 * survive contact with a real model. Told to "reply with nothing but a READ
 * line", it reliably explains itself first:
 *
 *     Before I propose the merge, I want to pin provenance — ...
 *
 *     READ: raw/interviews/timeline-2026-08-19T08-51-59.md
 *
 * That is reasonable behaviour and worth keeping; the author gets to see why it
 * is asking. What must not happen is the request reaching the screen while
 * nothing opens the files, which is exactly what a prefix test produced.
 */
export const REQUEST_LINE = /^\s*READ:/i;

/**
 * Paths the architect asked for, or undefined when this is an ordinary reply.
 *
 * Everything from the first `READ:` to the end of the reply is treated as the
 * request, and every markdown path in it is taken. A request is the last thing
 * in a reply — there is nothing to say after asking — and reading the whole
 * tail is what survives the ways a real one is written: wrapped across lines,
 * comma-separated, backticked, or split into two READ lines.
 *
 * Taking a stray path from prose is the harmless direction to be wrong in. This
 * only ever opens a file for the model to read.
 */
export function parseRequest(reply: string): string[] | undefined {
	const start = REQUEST_START.exec(reply);
	if (!start) {
		return undefined;
	}

	const found = reply.slice(start.index + start[0].length).match(PATH) ?? [];
	const paths = [...new Set(found)].slice(0, MAX_FILES);
	return paths.length > 0 ? paths : undefined;
}

export class UnreadablePathError extends Error {
	constructor(candidate: string, reason: string) {
		super(`refused to open '${candidate}': ${reason}`);
		this.name = 'UnreadablePathError';
	}
}

/**
 * Resolves a path the architect may *read*.
 *
 * Deliberately not `resolveInsideVault`, which governs writing and is stricter
 * in the one place that matters here: it forbids `raw/` outright, because the
 * tool never writes to the author's own record. Reading it is the opposite —
 * seeing the transcript beside the corpus is the entire reason `/architect`
 * exists, and refusing to open the material it is reasoning about would make
 * the feature pointless.
 *
 * Everything else stays: inside the vault, canonically, and markdown only.
 * `.litrpg/` is excluded because it is the tool's own cache and holds nothing
 * an architect should reason from.
 */
export function resolveReadable(root: string, candidate: string): string {
	const trimmed = candidate.trim();
	if (trimmed === '') {
		throw new UnreadablePathError(candidate, 'empty path');
	}
	if (path.isAbsolute(trimmed)) {
		throw new UnreadablePathError(candidate, 'absolute paths are not allowed');
	}
	if (trimmed.includes('\0')) {
		throw new UnreadablePathError(candidate, 'null byte in path');
	}

	const vaultRoot = path.resolve(root);
	const target = path.resolve(vaultRoot, trimmed);
	const relative = path.relative(vaultRoot, target);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new UnreadablePathError(candidate, 'path escapes the vault');
	}

	const normalized = relative.split(path.sep).join('/');
	if (normalized === '.litrpg' || normalized.startsWith('.litrpg/')) {
		throw new UnreadablePathError(candidate, '.litrpg/ is the tool’s own cache');
	}
	if (!normalized.endsWith('.md')) {
		throw new UnreadablePathError(candidate, 'only markdown files can be opened');
	}

	return target;
}

export type Opened = {
	/** One block per file, ready to append to the context. */
	readonly blocks: readonly string[];
	/** Paths opened, for the status line the author sees. */
	readonly paths: readonly string[];
	/** Why a path was not opened. Reported, never silent. */
	readonly refusals: readonly string[];
};

/**
 * Opens what was asked for, within the budget.
 *
 * A refusal is handed back to the architect rather than dropped: an agent told
 * "that file does not exist" stops asking for it, while one told nothing asks
 * again and burns the next round.
 */
export async function openFiles(
	root: string,
	candidates: readonly string[],
): Promise<Opened> {
	const blocks: string[] = [];
	const paths: string[] = [];
	const refusals: string[] = [];
	let spent = 0;

	for (const candidate of candidates.slice(0, MAX_FILES)) {
		let target: string;
		try {
			target = resolveReadable(root, candidate);
		} catch (caught) {
			refusals.push(caught instanceof Error ? caught.message : String(caught));
			continue;
		}

		const contents = await readFile(target, 'utf8').catch(() => undefined);
		if (contents === undefined) {
			refusals.push(`'${candidate}' does not exist`);
			continue;
		}

		const remaining = MAX_BYTES - spent;
		if (remaining <= 0) {
			refusals.push(`'${candidate}' not opened — no budget left this round`);
			continue;
		}

		// Truncation is marked rather than quiet: an architect that rewrites a
		// file from a silently clipped copy would delete whatever was cut.
		const clipped = contents.length > remaining;
		const text = clipped ? contents.slice(0, remaining) : contents;
		spent += text.length;

		blocks.push(
			[
				`### ${candidate}`,
				'',
				text.trim(),
				...(clipped
					? ['', '_[truncated — do not rewrite this file from this copy]_']
					: []),
			].join('\n'),
		);
		paths.push(candidate);
	}

	return {blocks, paths, refusals};
}

/** The opened files and refusals, as a message the architect can read. */
export function renderOpened(opened: Opened): string {
	return [
		'# Files you asked for',
		'',
		...(opened.blocks.length > 0 ? [opened.blocks.join('\n\n'), ''] : []),
		...(opened.refusals.length > 0
			? ['## Not opened', '', ...opened.refusals.map(reason => `- ${reason}`), '']
			: []),
		'Answer now. Do not ask for more files unless you genuinely cannot proceed.',
	].join('\n');
}

/** Where a plan directive starts. Everything after it is the instruction. */
const PLAN_START = /^\s*PLAN:/im;

/**
 * A line that hands the reply to the structural pass rather than to the author.
 *
 * The architect used to end a reply by asking the author to type its own
 * conclusion back as a `plan` command. That is friction protecting nothing —
 * the review gate is what makes a change safe, not the keystrokes that reached
 * it — and it was worse than friction, because the plan pass then re-derived
 * everything cold from an instruction string. An architect that had just
 * computed five timestamps would watch them be worked out again from scratch.
 */
export const DIRECTIVE_LINE = /^\s*(READ|PLAN):/i;

/** The instruction the architect wants planned, or undefined. */
export function parsePlan(reply: string): string | undefined {
	const start = PLAN_START.exec(reply);
	if (!start) {
		return undefined;
	}

	const instruction = reply.slice(start.index + start[0].length).trim();
	return instruction === '' ? undefined : instruction;
}
