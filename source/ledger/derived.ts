import type {SystemDef} from '../domain/schema.js';
import type {FormulaRunner} from '../system/sandbox.js';
import type {CharacterState, Finding} from './replay.js';

/**
 * Stats that are computed rather than accumulated.
 *
 * A stat moved by ledger events records what happened to a character. A derived
 * stat records what follows from it: max HP from constitution and level, a tier
 * from the stats beneath it, a carrying capacity from strength. The author
 * states the rule once as a formula, and every character under the system gets
 * it — which is the point, and the reason it belongs to the system rather than
 * to a page.
 *
 * The machinery for this was already here and had exactly one caller. Formulas
 * are extracted from the vault, run in an isolated VM under a CPU and memory
 * cap, and gated on the author consenting to a hash of the source they read;
 * only `xp_for_level` ever used it, while `/init` shipped a `max-hp` example
 * that nothing on earth would call. This is the missing consumer.
 */

/**
 * The order derived stats must be evaluated in, and any cycle found.
 *
 * A derived stat may read another, so evaluating them in declaration order is
 * wrong as soon as an author puts `tier` above the stats it counts. Kahn's
 * algorithm gives a working order and, more usefully, tells us when there is
 * not one: `tier` reading `rank` while `rank` reads `tier` has no answer, and
 * the honest response is to say so rather than pick an arbitrary starting
 * point and produce a number.
 *
 * Dependencies are read out of the formula's source text rather than declared.
 * Asking an author to list them beside a formula that already names them is
 * bookkeeping they would get wrong, and the source is right there.
 */
export function evaluationOrder(
	system: SystemDef,
	sourceOf: (formulaId: string) => string | undefined,
): {order: readonly string[]; cycle: readonly string[]} {
	const derived = system.stats.filter(stat => stat.formula !== undefined);
	const ids = new Set(derived.map(stat => stat.id));

	const dependsOn = new Map<string, Set<string>>();
	for (const stat of derived) {
		const source = sourceOf(stat.formula!) ?? '';
		const found = new Set<string>();
		for (const other of ids) {
			// Word-boundary, so `tier` does not match `tier_cap`. A false positive
			// only ever adds an edge, which at worst reports a cycle that is not
			// one — but a false negative evaluates in the wrong order and silently
			// computes from a stale value.
			if (other !== stat.id && new RegExp(`\\b${other}\\b`).test(source)) {
				found.add(other);
			}
		}
		dependsOn.set(stat.id, found);
	}

	const order: string[] = [];
	const remaining = new Map(dependsOn);
	while (remaining.size > 0) {
		const ready = [...remaining]
			.filter(([, needs]) => [...needs].every(need => !remaining.has(need)))
			.map(([id]) => id)
			.toSorted();

		if (ready.length === 0) {
			// Everything left is in a cycle or depends on one.
			return {order, cycle: [...remaining.keys()].toSorted()};
		}

		for (const id of ready) {
			order.push(id);
			remaining.delete(id);
		}
	}

	return {order, cycle: []};
}

/**
 * Recomputes a character's derived stats in place.
 *
 * Called after each step's events have been applied, so a formula reads the
 * state as it stands at that moment in the story — which is what makes a
 * derived stat a fact about a scene rather than about a character sheet.
 *
 * A formula that throws leaves its stat exactly as it was and reports. The
 * alternative is a hole in the sheet at one step and a number at the next,
 * which reads as a bug in the story rather than in the formula (P4).
 */
export async function applyDerived(
	character: CharacterState,
	system: SystemDef,
	order: readonly string[],
	formulas: FormulaRunner | undefined,
	where: string,
	findings: Finding[],
): Promise<void> {
	if (formulas === undefined || order.length === 0) {
		return;
	}

	for (const id of order) {
		const stat = system.stats.find(candidate => candidate.id === id);
		if (stat?.formula === undefined) {
			continue;
		}

		try {
			// The whole state, not a hand-picked subset: a formula destructures
			// what it needs, and deciding here what it is allowed to read would be
			// a second place to keep in step with the author's own arithmetic.
			const value = await formulas.call(stat.formula, {
				...character.stats,
				level: character.level,
				xp: character.xp,
			});

			if (Number.isFinite(value)) {
				character.stats[id] = value;
			} else {
				findings.push({
					kind: 'formula_error',
					detail: `stat '${id}' computed ${String(value)} from formula '${stat.formula}'`,
					where,
					actor: character.id,
				});
			}
		} catch (caught) {
			findings.push({
				kind: 'formula_error',
				detail: `stat '${id}' could not be computed: ${caught instanceof Error ? caught.message : String(caught)}`,
				where,
				actor: character.id,
			});
		}
	}
}
