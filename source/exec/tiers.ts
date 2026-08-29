/**
 * Which commands the headless surface will run, and under what promise.
 *
 * The whole design is that **the gate stays shut**. An exec mode that could
 * accept a proposal would destroy the one property that makes this tool
 * trustworthy — nothing is written because it seemed right — so the tiers are
 * cut by what a command is allowed to do to the vault, not by convenience.
 *
 * Tiering by command *name* is not enough, and that is the subtle part. The
 * same command is a different tier at different arguments: `/questions` is a
 * report and `/questions character` opens an interview; `/time` is a view and
 * `/time gregorian …` rebinds the clock. So this list bounds what may run at
 * all, and `runner.ts` inspects the returned `CommandResult` afterwards for any
 * branch that would have handed control back to `App`. Two gates, and the
 * second is the one that survives a twelfth branch being added in a year.
 */

/**
 * Commands that compute and return, touching nothing.
 *
 * Verified by running each against a copy of a real vault and hashing every
 * file before and after — not by reading them and concluding they looked pure.
 * This is also, per the design note in a vault's own README, where nearly all
 * of an agent's value is: the useful thing an agent does here is notice.
 */
export const TIER_1 = [
	'questions',
	'lint',
	'status',
	'sheet',
	'timeline',
	'primitives',
	'themes',
	'pacing',
	'project',
	'time',
	'help',
] as const;

/**
 * Commands that run a model pass and open the gate.
 *
 * In exec these propose and stop: the batch is serialised and nothing is
 * applied. Applying is `litfire review apply`, a separate invocation with an
 * explicit list — deliberately not reachable from here by any flag.
 */
export const TIER_2 = ['ingest'] as const;

/**
 * Commands that write only derived state.
 *
 * `/wiki build` regenerates `wiki/` and `ledger/`, which are pure functions of
 * the corpus and regenerable by definition — the review gate does not govern
 * them, and in fact forbids proposals there for the same reason. So it is safe
 * headlessly, and an agent reading the wiki needs it fresh.
 *
 * It is its own tier rather than part of tier 1 because tier 1's guarantee is
 * one sentence — *it writes nothing* — and a guarantee that needs a footnote is
 * worth less than the command it would admit. Behind `--allow-derived-write`,
 * so the write is always something the caller asked for by name.
 */
export const TIER_DERIVED = ['wiki'] as const;

export type Tier = 1 | 2 | 'derived';

export function tierOf(command: string): Tier | undefined {
	if ((TIER_1 as readonly string[]).includes(command)) {
		return 1;
	}
	if ((TIER_2 as readonly string[]).includes(command)) {
		return 2;
	}
	if ((TIER_DERIVED as readonly string[]).includes(command)) {
		return 'derived';
	}
	return undefined;
}

/**
 * The branches a `CommandResult` can carry that hand control back to `App`.
 *
 * Every one of these means "a human is about to be asked something", and each
 * has a deliberate answer in exec rather than a shared apology. Listed as data
 * so the refusal reasons below cannot drift from the set being checked.
 */
export const INTERACTIVE_BRANCHES = [
	'confirm',
	'ingest',
	'generateStats',
	'adopt',
	'curator',
	'reviewer',
	'interview',
	'wizard',
	'openEditor',
	'switchProject',
	'exit',
] as const;

export type InteractiveBranch = (typeof INTERACTIVE_BRANCHES)[number];

/** Why each branch cannot run headlessly, in the terms the caller needs. */
export const REFUSAL: Readonly<Record<InteractiveBranch, string>> = {
	confirm:
		'this command asks the author a yes/no question first; pass --yes to answer it, and note that what is behind it is checked again',
	ingest: 'ingest is tier 2 — run it with --propose --out <file>, then review apply',
	generateStats:
		'generating a stats model opens the review gate; there is no headless form of it',
	adopt: '/ingest adopt proposes into raw/, which exec may never do — interactive only',
	curator:
		'the curator may propose into raw/, which exec may never do — interactive only',
	reviewer: 'the reviewer is an author-driven session by definition',
	interview: 'an interview is a dialogue and has no headless form',
	wizard: 'exec never prompts for or accepts a provider credential',
	openEditor: 'exec has no buffer to open',
	switchProject:
		'exec takes its vault as an argument, so switching projects would do nothing',
	exit: 'nothing to exit',
};
