import {readFile} from 'node:fs/promises';
import {applyAccepted} from '../review/apply.js';
import {appendLog} from '../vault/log.js';
import {envelope, EXIT, type ExitCode} from './envelope.js';
import {
	staleItems,
	toReviewItems,
	type SerialisedBatch,
	type SerialisedItem,
} from './serialise.js';
import type {ExecResult} from './runner.js';

/**
 * Tier 3 — applying, as a separate and explicit act.
 *
 * Reuses `applyAccepted` unchanged, so every path rule the gate enforces
 * applies identically: `raw/`, `ledger/`, `wiki/`, `manuscript.md` and
 * `.litrpg/` are refused, and `resolveInsideVault` still resolves canonically.
 * `PathOptions.allowRaw` is not a parameter here and is not reachable from the
 * command line — the curator and `/ingest adopt` are the only things that may
 * set it, and both stay interactive.
 */
export async function runApply(options: {
	readonly batchFile: string;
	readonly accept: readonly number[];
	/**
	 * How many items the caller believes are in this batch.
	 *
	 * `--accept-all` used to be a bare boolean, which made it the one flag an
	 * agent could be talked into passing without knowing what it covered. A
	 * count turns it from a shrug into an assertion: applying everything is
	 * fine, applying *however many things happen to be in this file* is not,
	 * and the two are indistinguishable until the file is not the one you
	 * thought. A regenerated batch, a stale path, the wrong file entirely —
	 * each shows up here as a number that does not match.
	 */
	readonly acceptAll?: number | undefined;
	readonly version: string;
}): Promise<ExecResult> {
	const {batchFile, version} = options;

	const fail = (
		code: ExitCode,
		reason: string,
		remedy?: string,
		vault = '',
		data: unknown = null,
	): ExecResult => ({
		code,
		envelope: envelope({
			command: 'review apply',
			vault,
			litfireVersion: version,
			data,
			lines: [],
			dirty: false,
			error: {code, reason, ...(remedy === undefined ? {} : {remedy})},
		}),
	});

	let batch: SerialisedBatch;
	try {
		batch = JSON.parse(await readFile(batchFile, 'utf8')) as SerialisedBatch;
	} catch (caught) {
		return fail(
			EXIT.usageError,
			`cannot read batch ${batchFile}: ${caught instanceof Error ? caught.message : String(caught)}`,
		);
	}

	if (!Array.isArray(batch.items) || typeof batch.vault !== 'string') {
		return fail(EXIT.usageError, `${batchFile} is not a litfire batch`);
	}

	const root = batch.vault;

	let chosen: SerialisedItem[];
	if (options.acceptAll !== undefined) {
		if (options.acceptAll !== batch.items.length) {
			return fail(
				EXIT.usageError,
				`--accept-all ${String(options.acceptAll)} does not match this batch, which has ${String(batch.items.length)} item(s)`,
				// Said plainly rather than withheld. The count is in the file the
				// caller already holds — `jq '.items | length'` — so hiding it would
				// be theatre, and the assertion has already done its work by
				// failing once against a batch that is not the expected one.
				`re-read the batch and pass --accept-all ${String(batch.items.length)} if that is really what you mean`,
				root,
			);
		}
		chosen = [...batch.items];
	} else {
		const known = new Set(batch.items.map(item => item.index));
		const unknown = options.accept.filter(index => !known.has(index));
		if (unknown.length > 0) {
			return fail(
				EXIT.usageError,
				`no item ${unknown.join(', ')} in this batch (1–${String(batch.items.length)})`,
				undefined,
				root,
			);
		}
		chosen = batch.items.filter(item => options.accept.includes(item.index));
	}

	if (chosen.length === 0) {
		return fail(
			EXIT.usageError,
			`nothing accepted — pass --accept <n,n> or --accept-all ${String(batch.items.length)}`,
			undefined,
			root,
		);
	}

	// Checked now, against the vault as it currently is, rather than trusted
	// from when the batch was made. Something may have happened in between — the
	// author editing a page, another run landing, a checkout — and a stale batch
	// applied blind is a change nobody reviewed.
	const stale = await staleItems(root, chosen);
	if (stale.length > 0) {
		return fail(
			EXIT.staleBatch,
			`${String(stale.length)} target(s) changed since this batch was proposed`,
			're-run the propose step; the vault has moved under it',
			root,
			{stale},
		);
	}

	const outcome = await applyAccepted(root, toReviewItems(chosen));

	await appendLog(
		root,
		`exec review apply ${batchFile}: wrote ${String(outcome.written.length)}, removed ${String(outcome.removed.length)}, failed ${String(outcome.failed.length)}`,
	);

	// A failure inside the batch is a command error, not a success with a note.
	// Half a batch landing is exactly the state a caller has to know about.
	const code = outcome.failed.length > 0 ? EXIT.commandError : EXIT.ok;

	return {
		code,
		envelope: envelope({
			ok: code === EXIT.ok,
			command: 'review apply',
			vault: root,
			litfireVersion: version,
			data: outcome,
			lines: [
				{text: `wrote ${String(outcome.written.length)} file(s)`},
				...outcome.written.map(path => ({text: `  ${path}`, dim: true})),
				...outcome.removed.map(path => ({text: `  removed ${path}`, dim: true})),
				...outcome.failed.map(one => ({text: `  ${one.path}: ${one.reason}`})),
			],
			dirty: outcome.written.length > 0 || outcome.removed.length > 0,
			...(code === EXIT.ok
				? {}
				: {
						error: {
							code,
							reason: `${String(outcome.failed.length)} item(s) could not be written`,
						},
					}),
		}),
	};
}
