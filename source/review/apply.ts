import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {VAULT} from '../vault/paths.js';
import type {ApplyOutcome, ReviewItem} from './types.js';

/**
 * Paths a proposal may never target, regardless of what the model asked for.
 *
 * `.litrpg/` is cache the tool owns. `ledger/` is derived — replay regenerates
 * it, so a write there would be silently overwritten and is a sign the model
 * misunderstood the schema. `raw/` is the author's own record, and only the
 * curator may propose changes there, on the author's explicit instruction —
 * see `allowRaw`. `manuscript.md` is assembled by `/export` from `chapters/` and
 * `situations/`, so a proposal there would edit the output instead of the
 * source and vanish on the next export. `wiki/` is derived the same way, from
 * the corpus and the ledger.
 */
const FORBIDDEN_PREFIXES = [
	VAULT.meta,
	VAULT.ledger,
	VAULT.raw,
	VAULT.manuscript,
	VAULT.wiki,
];

export class UnsafePathError extends Error {
	constructor(candidate: string, reason: string) {
		super(`refusing to write ${candidate}: ${reason}`);
		this.name = 'UnsafePathError';
	}
}

/**
 * Resolves a model-supplied path against the vault root, or throws.
 *
 * Proposal paths are model output. Without this, a proposal for
 * `../../.ssh/authorized_keys` would be written wherever it pointed — the same
 * class of bug the formula sandbox exists to prevent, and the reason the check
 * is a canonical-path comparison rather than a string test for `..`.
 */
export type PathOptions = {
	/**
	 * Permit proposals under `raw/`.
	 *
	 * Off everywhere by default, and deliberately a parameter rather than a
	 * relaxed constant: extraction and the reviewer must never touch a
	 * transcript, because the whole reason `raw/` is trustworthy is that only
	 * the author writes it. `/curator` may, because reconciling a corpus
	 * sometimes means correcting the material it was drawn from, and the author
	 * asked for that. It still lands as a diff they accept (D15).
	 */
	readonly allowRaw?: boolean;
};

export function resolveInsideVault(
	root: string,
	candidate: string,
	options: PathOptions = {},
): string {
	if (candidate.trim() === '') {
		throw new UnsafePathError(candidate, 'empty path');
	}
	if (path.isAbsolute(candidate)) {
		throw new UnsafePathError(candidate, 'absolute paths are not allowed');
	}
	if (candidate.includes('\0')) {
		throw new UnsafePathError(candidate, 'null byte in path');
	}

	const vaultRoot = path.resolve(root);
	const target = path.resolve(vaultRoot, candidate);

	// Compare canonical paths, so `a/../../b` and symlink-ish tricks are caught
	// by where the path actually lands rather than how it is spelled.
	const relative = path.relative(vaultRoot, target);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new UnsafePathError(candidate, 'path escapes the vault');
	}

	const normalized = relative.split(path.sep).join('/');
	for (const prefix of FORBIDDEN_PREFIXES) {
		if (prefix === VAULT.raw && options.allowRaw === true) {
			continue;
		}
		if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
			throw new UnsafePathError(candidate, `${prefix}/ is not author-writable`);
		}
	}

	if (!normalized.endsWith('.md')) {
		throw new UnsafePathError(candidate, 'only markdown files may be proposed');
	}

	return target;
}

/** Reads current contents so the gate can show a real diff, not just the new file. */
export async function readExisting(
	root: string,
	candidate: string,
): Promise<string | undefined> {
	try {
		return await readFile(resolveInsideVault(root, candidate), 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * Writes every accepted item. Rejected and still-pending items are skipped —
 * P3 means nothing lands without an explicit decision.
 */
export async function applyAccepted(
	root: string,
	items: readonly ReviewItem[],
	options: PathOptions = {},
): Promise<ApplyOutcome> {
	const written: string[] = [];
	const removed: string[] = [];
	const skipped: string[] = [];
	const failed: {path: string; reason: string}[] = [];

	for (const item of items) {
		if (item.decision !== 'accepted') {
			skipped.push(item.proposal.path);
			continue;
		}

		try {
			// The same path check either way: a removal is as capable of naming
			// `raw/` or somewhere outside the vault as a write is, and rather more
			// costly if it succeeds.
			const target = resolveInsideVault(root, item.proposal.path, options);

			if (item.proposal.remove === true) {
				// `force: false` on purpose. A removal that finds nothing there has
				// not done what it said, and reporting that beats reporting success
				// for a file some other pass already dealt with.
				await rm(target);
				removed.push(item.proposal.path);
				continue;
			}

			await mkdir(path.dirname(target), {recursive: true});
			await writeFile(target, item.contents, 'utf8');
			written.push(item.proposal.path);
		} catch (caught) {
			failed.push({
				path: item.proposal.path,
				reason: caught instanceof Error ? caught.message : String(caught),
			});
		}
	}

	return {written, removed, skipped, failed};
}
