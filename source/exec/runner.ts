import {findCommand} from '../commands/registry.js';
import type {CommandContext, CommandResult} from '../commands/types.js';
import {computeProject, type Project} from '../core/project.js';
import {findOrphanedInterviews} from '../interview/orphans.js';
import {appendLog} from '../vault/log.js';
import {envelope, EXIT, type Envelope, type ExitCode} from './envelope.js';
import {INTERACTIVE_BRANCHES, REFUSAL, tierOf, type InteractiveBranch} from './tiers.js';

/**
 * The headless surface.
 *
 * `Command.run(args, context) → Promise<CommandResult>` was already pure data
 * in, pure data out — `commands/types.ts` says so, and says why: *"No
 * callbacks: a handler still returns plain data, which is the property that
 * lets the whole registry be tested without a renderer."* This module is the
 * second consumer that property was always going to have.
 *
 * So nothing here reimplements a command. It resolves one, runs it, and then
 * decides what to do about a result that expected a human to be looking at it.
 */

export type ExecOptions = {
	readonly root: string;
	readonly argv: readonly string[];
	readonly version: string;
	/** Answer a `confirm` with yes. Does not unlock a refused branch. */
	readonly yes?: boolean;
	/** Required before a command that regenerates `wiki/` and `ledger/`. */
	readonly allowDerivedWrite?: boolean;
};

export type ExecResult = {
	readonly envelope: Envelope;
	readonly code: ExitCode;
};

/** The branches a result carries, including any hiding behind a confirm. */
export function branchesOf(result: CommandResult): InteractiveBranch[] {
	const found = INTERACTIVE_BRANCHES.filter(
		branch => (result as Record<string, unknown>)[branch] !== undefined,
	);

	// Recursing into `proceed` is the point. `/questions character` returns a
	// confirm whose proceed is an interview, so a caller passing `--yes` would
	// otherwise satisfy the question and walk straight into a dialogue with
	// nobody to have it. Answering a confirm is not permission for what is
	// behind it.
	return result.confirm === undefined
		? found
		: [...new Set([...found, ...branchesOf(result.confirm.proceed)])];
}

function refuse(
	command: string,
	root: string,
	version: string,
	branches: readonly InteractiveBranch[],
): ExecResult {
	// The first is the one to explain. A confirm wrapping an interview is
	// refused *because* of the interview, and saying so beats reporting the
	// wrapper the caller cannot see.
	const blocking = branches.find(branch => branch !== 'confirm') ?? branches[0]!;
	return {
		code: EXIT.refused,
		envelope: envelope({
			command,
			vault: root,
			litfireVersion: version,
			data: {refused: blocking, branches},
			lines: [],
			dirty: false,
			error: {
				code: EXIT.refused,
				reason: `refused in exec mode: ${REFUSAL[blocking]}`,
				remedy: `run litfire ${root} and use /${command} there`,
			},
		}),
	};
}

/**
 * The typed payload for the commands an agent will actually parse.
 *
 * Deliberately narrow. A payload invented for every command would be a second
 * rendering to keep in step with the first, and `lines` already carries what
 * the TUI would have shown. These two are different: they are the reason an
 * agent is pointed at this vault at all, and scraping them out of text would
 * make every wording change a breaking one.
 */
async function payloadFor(
	command: string,
	args: readonly string[],
	project: Project,
	root: string,
): Promise<unknown> {
	switch (command) {
		case 'questions': {
			// Only bare `/questions`. With a kind it is an interview, and the run
			// below refuses it before this is ever reached.
			return args.length === 0 ? {questions: project.questions} : null;
		}

		case 'lint': {
			const orphans = await findOrphanedInterviews(root);
			const byKind: Record<string, number> = {};
			for (const question of project.questions) {
				byKind[question.kind] = (byKind[question.kind] ?? 0) + 1;
			}
			return {
				findings: project.questions.filter(one => one.source === 'deterministic'),
				byKind,
				parseFailures: project.vault.issues,
				orphanedInterviews: orphans,
				legacyLocations: project.vault.legacy,
			};
		}

		default: {
			return null;
		}
	}
}

export async function runExec(options: ExecOptions): Promise<ExecResult> {
	const {root, version} = options;
	const [head, ...args] = options.argv;
	const name = (head ?? '').replace(/^\//, '');

	const fail = (code: ExitCode, reason: string, remedy?: string): ExecResult => ({
		code,
		envelope: envelope({
			command: name,
			vault: root,
			litfireVersion: version,
			data: null,
			lines: [],
			dirty: false,
			error: {code, reason, ...(remedy === undefined ? {} : {remedy})},
		}),
	});

	if (name === '') {
		return fail(EXIT.usageError, 'no command given', 'litfire exec <vault> /questions');
	}

	const command = findCommand(name);
	if (command === undefined) {
		return fail(EXIT.usageError, `no command '${name}'`);
	}

	const tier = tierOf(name);
	if (tier === undefined) {
		return fail(
			EXIT.refused,
			`'/${name}' is not available in exec mode`,
			`run litfire ${root} and use /${name} there`,
		);
	}

	if (tier === 'derived' && options.allowDerivedWrite !== true) {
		return fail(
			EXIT.refused,
			`'/${name}' regenerates wiki/ and ledger/`,
			'pass --allow-derived-write to say so explicitly',
		);
	}

	const project = await computeProject(root);

	// Formulas are executable code, gated on a hash of the source the author
	// read. Running without that consent does not fail loudly — it quietly
	// leaves every derived stat at its default, so Ω reads 0 instead of 1.4444
	// and a ceiling reads 0 instead of 20. The findings even keep their count.
	// An agent cannot tell, so this has to.
	if (project.formulasSkipped) {
		return fail(
			EXIT.consentRequired,
			'this vault has formulas the author has not consented to, so derived stats would read as zero',
			`run litfire ${root} and use /consent`,
		);
	}

	const context: CommandContext = {
		root,
		project,
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		// Never from exec. Consent is the author confirming they read the code
		// that is about to run in a sandbox; a headless caller granting it on
		// their behalf is the gate answering its own question.
		consentFormulas: () => {},
	};

	let result: CommandResult;
	try {
		result = await command.run(args, context);
	} catch (caught) {
		return fail(
			EXIT.commandError,
			caught instanceof Error ? caught.message : String(caught),
		);
	}

	const branches = branchesOf(result);
	// `--yes` answers the question and nothing more: what it uncovers is checked
	// again, by the same rule, before anything runs.
	if (options.yes === true && result.confirm !== undefined && branches.length === 1) {
		result = result.confirm.proceed;
	}

	const remaining = branchesOf(result);
	if (remaining.length > 0) {
		return refuse(name, root, version, remaining);
	}

	// A tier-1 command reporting that it changed the vault is a bug in the tier
	// table, not a thing to pass along as success.
	if (tier === 1 && result.dirty === true) {
		return fail(
			EXIT.commandError,
			`'/${name}' is listed as read-only but reported changing the vault`,
		);
	}

	await appendLog(root, `exec /${[name, ...args].join(' ')}`);

	return {
		code: EXIT.ok,
		envelope: envelope({
			command: name,
			vault: root,
			litfireVersion: version,
			data: await payloadFor(name, args, project, root),
			lines: result.lines,
			dirty: result.dirty === true,
		}),
	};
}
