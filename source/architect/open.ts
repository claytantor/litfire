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

/** The line the architect emits to ask for files it has not been given. */
const REQUEST = /^\s*READ:\s*(.+)$/im;

/**
 * The first characters of a reply that is a read request rather than an answer.
 *
 * Streaming has to decide early whether to show a reply or intercept it, and
 * this is the shortest prefix that settles it. Kept next to `REQUEST` because
 * the two must agree.
 */
export const REQUEST_PREFIX = 'READ:';

/** Paths the architect asked for, or undefined when this is an ordinary reply. */
export function parseRequest(reply: string): string[] | undefined {
	const match = REQUEST.exec(reply);
	if (!match) {
		return undefined;
	}

	return [
		...new Set(
			(match[1] ?? '')
				.split(/[,\s]+/)
				.map(entry => entry.trim().replace(/^[`'"]|[`'"]$/g, ''))
				.filter(entry => entry !== ''),
		),
	].slice(0, MAX_FILES);
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
