import {runChecks, type OpenQuestion} from '../ledger/checks.js';
import {replay, type ReplayResult} from '../ledger/replay.js';
import {FormulaRunner, hashFormulas} from '../system/sandbox.js';
import {computeCoverage, type Coverage} from '../themes/coverage.js';
import {readConfig} from '../vault/config.js';
import {loadVault, type Vault} from '../vault/load.js';
import {formatAll, type FormattedInstants} from '../time/custom.js';
import type {Instant} from '../time/instant.js';

export type Project = {
	readonly vault: Vault;
	readonly replay: ReplayResult;
	readonly questions: readonly OpenQuestion[];
	readonly coverage: Coverage;
	readonly formulaHash: string;
	/** True when formulas were present but consent withheld (§6.4). */
	readonly formulasSkipped: boolean;
	/**
	 * Every dated instant, already rendered by the vault's custom calendar.
	 *
	 * Formatting a custom calendar means running author code in the isolate,
	 * which is async and cannot outlive `computeProject` — the runner is disposed
	 * before this returns. So the work happens here, once, while it is alive, and
	 * the synchronous views and wiki read the answers out of this map.
	 */
	readonly calendarText: FormattedInstants | undefined;
};

export type ComputeOptions = {
	/**
	 * Formulas are executable code. A vault the author did not create must not
	 * evaluate them until explicitly confirmed, so the caller passes the hash it
	 * has consent for; anything else runs with formulas disabled.
	 */
	readonly consentedFormulaHash?: string | undefined;
};

/**
 * Full recompute: load → replay → check → coverage.
 *
 * §6.3 makes this deliberately non-incremental — at novel scale the whole thing
 * is milliseconds, and a pure function is far easier to trust than a cache.
 */
/** Every instant a page might need to show, deduplicated by `formatAll`. */
function momentInstants(vault: Vault): Instant[] {
	return vault.moments
		.map(moment => moment.at)
		.filter((at): at is Instant => at !== undefined);
}

export async function computeProject(
	root: string,
	options: ComputeOptions = {},
): Promise<Project> {
	const vault = await loadVault(root);
	const formulaHash = hashFormulas(vault.formulas);

	// An explicit hash (this session's /consent) wins; otherwise fall back to the
	// hash recorded in config, so consent survives a restart.
	const stored = (await readConfig(root)).consentedFormulaHash ?? undefined;
	const approved = options.consentedFormulaHash ?? stored;
	const consented = vault.formulas.length === 0 || approved === formulaHash;

	let runner: FormulaRunner | undefined;
	try {
		if (consented && vault.formulas.length > 0) {
			runner = await FormulaRunner.create(vault.formulas);
		}

		const replayResult = await replay({
			systems: vault.systems,
			moments: vault.moments,
			arcs: vault.arcs,
			situations: vault.situations,
			characters: vault.characters,
			formulas: runner,
		});

		const questions = runChecks({
			systems: vault.systems,
			arcs: vault.arcs,
			moments: vault.moments,
			situations: vault.situations,
			characters: vault.characters,
			factions: vault.factions,
			places: vault.places,
			sources: vault.sources,
			interfaces: vault.interfaces,
			legacy: vault.legacy,
			issues: vault.issues,
			artifacts: vault.artifacts,
			skills: vault.skills,
			themes: vault.themes,
			replay: replayResult,
			formulas: runner,
		});

		const coverage = computeCoverage(
			vault.themes,
			vault.situations,
			replayResult.sequence,
		);

		const calendarText =
			vault.time?.calendar === 'custom' && runner !== undefined
				? (await formatAll(runner, momentInstants(vault))).formatted
				: undefined;

		return {
			vault,
			replay: replayResult,
			questions,
			coverage,
			formulaHash,
			formulasSkipped: vault.formulas.length > 0 && !consented,
			calendarText,
		};
	} finally {
		runner?.dispose();
	}
}

export function unplacedSituations(project: Project): readonly string[] {
	return project.vault.situations
		.filter(situation => situation.arc === undefined)
		.map(situation => situation.id);
}
