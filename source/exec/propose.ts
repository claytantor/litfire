import {writeFile} from 'node:fs/promises';
import {computeProject} from '../core/project.js';
import {isIngestKind, type SourceKind} from '../ingest/index.js';
import {runIngestPass} from '../ingest/run.js';
import {loadProvider} from '../llm/index.js';
import {ReviewBatch} from '../review/index.js';
import {appendLog} from '../vault/log.js';
import {readConfig} from '../vault/config.js';
import {envelope, EXIT, type ExitCode} from './envelope.js';
import {serialiseBatch} from './serialise.js';
import type {ExecResult} from './runner.js';

/**
 * Tier 2 — propose, and stop.
 *
 * Runs the model pass and builds the same `ReviewBatch` the gate would, then
 * writes it to a file and exits. Nothing here can apply anything, and there is
 * deliberately no flag that would let it: `review apply` is a separate
 * invocation taking an explicit list, because a `--propose --apply` pair on one
 * command line is not a decision somebody made, it is one keystroke away from
 * being one.
 *
 * The agent's job ends at this file. It reports what litfire proposes and what
 * each item needs decided; it does not land them.
 */
export async function runPropose(options: {
	readonly root: string;
	readonly kind: string;
	readonly out: string;
	readonly version: string;
	readonly focus?: string | undefined;
	readonly again?: boolean;
	readonly now: string;
}): Promise<ExecResult> {
	const {root, kind, out, version} = options;

	const fail = (code: ExitCode, reason: string, remedy?: string): ExecResult => ({
		code,
		envelope: envelope({
			command: 'ingest',
			vault: root,
			litfireVersion: version,
			data: null,
			lines: [],
			dirty: false,
			error: {code, reason, ...(remedy === undefined ? {} : {remedy})},
		}),
	});

	if (!isIngestKind(kind)) {
		return fail(EXIT.usageError, `no ingest kind '${kind}'`);
	}

	const config = await readConfig(root);
	const loaded = await loadProvider(
		config.provider.id,
		config.provider.model,
		config.provider.baseUrl,
	);
	if ('error' in loaded) {
		// Never a prompt. Exec reads the credential store or says it cannot.
		return fail(EXIT.noProvider, loaded.error, `run litfire ${root} and use /provider`);
	}

	const project = await computeProject(root);
	if (project.formulasSkipped) {
		return fail(
			EXIT.consentRequired,
			'this vault has formulas the author has not consented to',
			`run litfire ${root} and use /consent`,
		);
	}

	const problems: string[] = [];
	const pass = await runIngestPass(
		root,
		project,
		loaded.provider,
		kind as SourceKind,
		{focus: options.focus, again: options.again},
		{
			onProblem: message => {
				problems.push(message);
			},
		},
	);

	// The same construction the gate uses, with the same path rules. `allowRaw`
	// is not passed and cannot be: a proposal naming `raw/` fails here exactly as
	// it would in the TUI, and that is the point of building the real batch
	// rather than serialising the raw proposals.
	const batch = await ReviewBatch.create(root, pass.proposals);
	const serialised = await serialiseBatch(
		root,
		`ingest ${kind}`,
		batch.items,
		options.now,
	);

	try {
		await writeFile(out, `${JSON.stringify(serialised, null, 2)}\n`, 'utf8');
	} catch (caught) {
		// The pass has already been paid for by the time this fails, so say where
		// the work went rather than letting an ENOENT out raw. Nothing was written
		// to the vault either way.
		return fail(
			EXIT.usageError,
			`cannot write batch to '${out}': ${caught instanceof Error ? caught.message : String(caught)}`,
			`${String(serialised.items.length)} proposal(s) were built and are now lost — pick a writable --out and run it again`,
		);
	}
	await appendLog(
		root,
		`exec /ingest ${kind} --propose: read ${String(pass.read)} note(s), proposed ${String(serialised.items.length)} page(s) to ${out}`,
	);

	return {
		code: EXIT.ok,
		envelope: envelope({
			command: 'ingest',
			vault: root,
			litfireVersion: version,
			data: {
				batchFile: out,
				proposed: serialised.items.length,
				read: pass.read,
				unchanged: pass.unchanged,
				notes: pass.notes,
				problems,
				items: serialised.items.map(item => ({
					index: item.index,
					path: item.proposal.path,
					remove: item.proposal.remove === true,
					confidence: item.proposal.confidence ?? null,
					rationale: item.proposal.rationale ?? null,
					stat: item.stat,
				})),
			},
			lines: [
				{text: `proposed ${String(serialised.items.length)} page(s) — nothing written`},
				{text: `batch: ${out}`, dim: true},
				{text: `apply with: litfire review apply ${out} --accept <n,n>`, dim: true},
			],
			dirty: false,
		}),
	};
}
