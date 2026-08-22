import type {
	Arc,
	Character,
	LedgerEvent,
	Situation,
	SystemDef,
	Moment,
} from '../domain/schema.js';
import type {FormulaRunner} from '../system/sandbox.js';
import {applyDerived, evaluationOrder} from './derived.js';
import {compareInstants, MAX_INSTANT, type Instant} from '../time/instant.js';

export type CharacterState = {
	id: string;
	/** The system tracking them; undefined when it could not be resolved. */
	system: string | undefined;
	level: number;
	xp: number;
	stats: Record<string, number>;
	skills: string[];
	items: Record<string, number>;
	/** Artifacts currently in hand, in acquisition order. */
	artifacts: string[];
};

export type LedgerState = {
	characters: Record<string, CharacterState>;
	flags: Record<string, string | number | boolean>;
};

export type Step =
	| {readonly kind: 'moment'; readonly id: string}
	| {readonly kind: 'situation'; readonly id: string; readonly arc: string};

/** A deterministic check failure. Never blocking (P4). */
export type Finding = {
	readonly kind: string;
	readonly detail: string;
	readonly where: string;
	readonly actor?: string;
};

export type ReplayInput = {
	readonly systems: readonly SystemDef[];
	readonly moments: readonly Moment[];
	readonly arcs: readonly Arc[];
	readonly situations: readonly Situation[];
	readonly characters: readonly Character[];
	readonly formulas: FormulaRunner | undefined;
};

export type ReplayResult = {
	readonly state: LedgerState;
	readonly findings: readonly Finding[];
	readonly sequence: readonly Step[];
	/** State after each step, so `/sheet <char> [at]` is a lookup (§6.3). */
	readonly snapshots: ReadonlyMap<string, LedgerState>;
};

/**
 * Builds the replay order described in §5: arcs by order, situations by
 * intra-arc order, moments interleaved at their anchor positions.
 *
 * Unplaced situations are skipped — a valid permanent state that contributes
 * nothing to ledger state until placed. Undated moments and unordered arcs
 * are the same case one level up: spillover can raise a turning point before the
 * author has decided where on the clock it sits, and a replay that invented a
 * position for it would be worse than one that leaves it out and says so.
 */
export function buildSequence(
	moments: readonly Moment[],
	arcs: readonly Arc[],
	situations: readonly Situation[],
): Step[] {
	const dated = moments.filter(
		(event): event is Moment & {at: Instant} => event.at !== undefined,
	);
	const byClock = dated.toSorted(
		(a, b) => compareInstants(a.at, b.at) || a.id.localeCompare(b.id),
	);
	const anchorAt = new Map(byClock.map(event => [event.id, event.at]));
	const emitted = new Set<string>();
	const sequence: Step[] = [];

	const emitMomentsUpTo = (limit: Instant) => {
		for (const event of byClock) {
			if (!emitted.has(event.id) && event.at <= limit) {
				emitted.add(event.id);
				sequence.push({kind: 'moment', id: event.id});
			}
		}
	};

	// D3 again: an arc with no order sorts last rather than being dropped, so a
	// stub arc's situations still replay in a defined place.
	for (const arc of arcs.toSorted(
		(a, b) =>
			(a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
			a.id.localeCompare(b.id),
	)) {
		// D3: sparse integers, ties broken by id so replay is deterministic even
		const inArc = situations
			.filter(situation => situation.arc === arc.id)
			.toSorted(
				(a, b) =>
					(a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
					a.id.localeCompare(b.id),
			);

		/**
		 * Where the clock has to have reached before this arc's scenes play.
		 *
		 * `starts_after` when the author named one. Otherwise the earliest moment
		 * the arc's own scenes claim — because an arc without an anchor used to
		 * mean "the beginning of time", which put a prologue's scenes *before the
		 * moment they say they happen at*. A scene anchored aeons back replayed
		 * ahead of the aeons, so any events that moment carried had not applied
		 * yet and the scene saw a world that had not changed.
		 *
		 * A first arc is the case that needs this. Every other arc follows one, so
		 * its author has a moment to name; the opening has nothing before it, and
		 * naming a moment its own first scene already names would be saying the
		 * same thing twice.
		 */
		const claimed = inArc
			.map(situation =>
				situation.moment === undefined ? undefined : anchorAt.get(situation.moment),
			)
			.filter((at): at is Instant => at !== undefined);

		const anchor = arc.starts_after
			? anchorAt.get(arc.starts_after)
			: claimed.length === 0
				? undefined
				: claimed.reduce((earliest, at) => (at < earliest ? at : earliest));

		if (anchor !== undefined) {
			emitMomentsUpTo(anchor);
		}

		for (const situation of inArc) {
			sequence.push({kind: 'situation', id: situation.id, arc: arc.id});
		}
	}

	// Everything not already emitted, however deep in time it sits.
	emitMomentsUpTo(MAX_INSTANT);
	return sequence;
}

/**
 * The system a character is under.
 *
 * Naming one is optional because a vault with a single system has only one
 * possible answer. With several it becomes required — and an unanswered choice
 * is reported, never guessed, because choosing a system for someone silently
 * decides what every number on their sheet means.
 */
export function systemFor(
	named: string | undefined,
	systems: readonly SystemDef[],
): SystemDef | undefined {
	if (named !== undefined) {
		return systems.find(system => system.id === named);
	}
	return systems.length === 1 ? systems[0] : undefined;
}

function seedCharacters(
	systems: readonly SystemDef[],
	characters: readonly Character[],
	findings: Finding[],
): Record<string, CharacterState> {
	const seeded: Record<string, CharacterState> = {};

	for (const character of characters) {
		const system = systemFor(character.system, systems);
		if (system === undefined) {
			findings.push(
				character.system === undefined
					? {
							kind: 'character_system_unset',
							detail: `${character.id} names no system and this vault has ${String(systems.length)} — set \`system:\` on their page`,
							where: character.id,
							actor: character.id,
						}
					: {
							kind: 'broken_reference',
							detail: `${character.id} names system '${character.system}', which does not exist`,
							where: character.id,
							actor: character.id,
						},
			);
		}

		const stats: Record<string, number> = {};
		for (const stat of system?.stats ?? []) {
			stats[stat.id] = character.stats[stat.id] ?? stat.default;
		}
		// Stats the author set but never declared still round-trip.
		for (const [key, value] of Object.entries(character.stats)) {
			stats[key] ??= value;
		}

		seeded[character.id] = {
			id: character.id,
			system: system?.id,
			level: character.level,
			xp: character.xp,
			stats,
			skills: [...character.skills],
			items: {...character.items},
			artifacts: [...character.artifacts],
		};
	}

	return seeded;
}

function cloneState(state: LedgerState): LedgerState {
	const characters: Record<string, CharacterState> = {};
	for (const [id, character] of Object.entries(state.characters)) {
		characters[id] = {
			...character,
			stats: {...character.stats},
			skills: [...character.skills],
			items: {...character.items},
			artifacts: [...character.artifacts],
		};
	}
	return {characters, flags: {...state.flags}};
}

/**
 * Level implied by total XP under the curve.
 *
 * `xp_for_level(L)` is read as the cumulative XP required to *be* level L, so
 * the level is the highest L satisfying `xp >= xp_for_level(L)`, floored at 1.
 */
async function levelForXp(
	xp: number,
	system: SystemDef | undefined,
	formulas: FormulaRunner | undefined,
	curve: Map<string, number>,
): Promise<number | undefined> {
	// Resolved once, against this system: two systems both defaulting their curve
	// id to `xp-for-level` is the ordinary case here, not an edge one.
	const key =
		system === undefined
			? undefined
			: formulas?.resolve(system.curves.xp_for_level, system.id);
	if (system === undefined || formulas === undefined || key === undefined) {
		return undefined;
	}

	let level = 1;
	for (let candidate = 1; candidate <= system.curves.max_level; candidate++) {
		// The curve is pure by construction — §6.4 strips the nondeterministic
		// intrinsics from the isolate — so each level's requirement is asked for
		// once per replay rather than once per xp event. Without this the isolate
		// round-trips are O(events × max_level), which is what turns a generous
		// curve into a replay that never finishes.
		const cacheKey = `${key}\0${String(candidate)}`;
		let required = curve.get(cacheKey);
		if (required === undefined) {
			required = await formulas.call(key, candidate);
			curve.set(cacheKey, required);
		}
		if (xp >= required) {
			level = candidate;
		} else {
			break;
		}
	}
	return level;
}

export async function replay(input: ReplayInput): Promise<ReplayResult> {
	const {systems, moments, arcs, situations, characters, formulas} = input;

	const findings: Finding[] = [];
	const state: LedgerState = {
		characters: seedCharacters(systems, characters, findings),
		flags: {},
	};
	const snapshots = new Map<string, LedgerState>();
	const sequence = buildSequence(moments, arcs, situations);
	/**
	 * Memoised `xp_for_level(candidate)`, keyed by the resolved formula rather
	 * than the level alone — several systems share the curve id `xp-for-level`
	 * and caching on the number would serve one system's answer to another.
	 */
	const curve = new Map<string, number>();

	const eventsById = new Map<string, readonly LedgerEvent[]>([
		...moments.map(e => [e.id, e.events] as const),
		...situations.map(s => [s.id, s.events] as const),
	]);

	// A character named only by an event still gets a state row, so the ledger
	// never silently drops facts the author wrote down.
	const ensure = (id: string, where: string): CharacterState => {
		const existing = state.characters[id];
		if (existing) {
			return existing;
		}
		findings.push({
			kind: 'unknown_character',
			detail: `no character page for '${id}'`,
			where,
			actor: id,
		});
		// No page means no declared system either, so they get one only when the
		// vault leaves no choice.
		const implied = systems.length === 1 ? systems[0] : undefined;
		const created: CharacterState = {
			id,
			system: implied?.id,
			level: 1,
			xp: 0,
			stats: Object.fromEntries((implied?.stats ?? []).map(s => [s.id, s.default])),
			skills: [],
			items: {},
			artifacts: [],
		};
		state.characters[id] = created;
		return created;
	};

	// Computed once per system, not once per character per step: the order is a
	// property of how the author wrote their formulas and does not change as the
	// story runs. A cycle is reported once, here, and its stats are skipped —
	// there is no answer to compute and guessing a starting point would produce
	// a number that looks like one.
	const orders = new Map<string, readonly string[]>();
	const orderFor = (system: SystemDef): readonly string[] => orders.get(system.id) ?? [];
	for (const system of systems) {
		const {order, cycle} = evaluationOrder(system, id =>
			formulas?.sourceOf(id, system.id),
		);
		orders.set(system.id, order);
		if (cycle.length > 0) {
			findings.push({
				kind: 'stat_formula_cycle',
				detail: `stats ${cycle.join(', ')} in '${system.id}' derive from each other in a loop — none of them can be computed`,
				where: system.id,
			});
		}
	}

	for (const step of sequence) {
		const where = step.id;
		for (const event of eventsById.get(step.id) ?? []) {
			const actor = ensure(event.actor, where);

			switch (event.type) {
				case 'xp': {
					actor.xp += event.value;
					const derived = await levelForXp(
						actor.xp,
						systems.find(candidate => candidate.id === actor.system),
						formulas,
						curve,
					);
					if (derived !== undefined) {
						actor.level = derived;
					}
					break;
				}
				case 'port': {
					const target = systems.find(candidate => candidate.id === event.system);
					if (target === undefined) {
						findings.push({
							kind: 'broken_reference',
							detail: `port names system '${event.system}', which does not exist`,
							where,
							actor: actor.id,
						});
						break;
					}

					const from = actor.system;
					actor.system = target.id;

					// Stats the new system declares and they lack start at its default;
					// ones it does not declare are kept rather than deleted, because a
					// number the author wrote is not ours to throw away (P6). The count
					// is reported so the carry-over is visible rather than assumed.
					const declared = new Set(target.stats.map(stat => stat.id));
					for (const stat of target.stats) {
						actor.stats[stat.id] ??= stat.default;
					}
					const carried = Object.keys(actor.stats).filter(id => !declared.has(id));

					// XP is a number; the curve is what turns it into a level. Re-deriving
					// is what makes a port meaningful — the same experience is worth a
					// different standing under different rules.
					const derived = await levelForXp(actor.xp, target, formulas, curve);
					if (derived !== undefined) {
						actor.level = derived;
					}

					findings.push({
						kind: 'system_port',
						detail: `${actor.id} ported from ${from === undefined ? 'no system' : `'${from}'`} to '${target.id}', now L${String(actor.level)} on ${String(actor.xp)} xp${carried.length === 0 ? '' : `, carrying ${String(carried.length)} stat(s) '${target.id}' does not declare`}`,
						where,
						actor: actor.id,
					});
					break;
				}
				case 'acquire_artifact': {
					if (actor.artifacts.includes(event.artifact)) {
						findings.push({
							kind: 'artifact_acquired_twice',
							detail: `${actor.id} already carries '${event.artifact}'`,
							where,
							actor: actor.id,
						});
					} else {
						actor.artifacts.push(event.artifact);
					}
					break;
				}
				case 'lose_artifact': {
					const index = actor.artifacts.indexOf(event.artifact);
					if (index === -1) {
						findings.push({
							kind: 'artifact_lost_unheld',
							detail: `${actor.id} never carried '${event.artifact}'`,
							where,
							actor: actor.id,
						});
					} else {
						actor.artifacts.splice(index, 1);
					}
					break;
				}
				case 'use_artifact': {
					// Using something you are not carrying is the ordering mistake this
					// event exists to catch — the reader who builds a wiki will notice,
					// so the tool should notice first. State is untouched: a use is a
					// fact about a scene, not a change of possession.
					if (!actor.artifacts.includes(event.artifact)) {
						findings.push({
							kind: 'artifact_used_unheld',
							detail: `${actor.id} uses '${event.artifact}' without carrying it`,
							where,
							actor: actor.id,
						});
					}
					break;
				}
				case 'acquire_skill': {
					if (actor.skills.includes(event.skill)) {
						findings.push({
							kind: 'skill_acquired_twice',
							detail: `${actor.id} already holds '${event.skill}'`,
							where,
							actor: actor.id,
						});
					} else {
						actor.skills.push(event.skill);
					}
					break;
				}
				case 'lose_skill': {
					const index = actor.skills.indexOf(event.skill);
					if (index === -1) {
						findings.push({
							kind: 'skill_lost_before_acquired',
							detail: `${actor.id} never held '${event.skill}'`,
							where,
							actor: actor.id,
						});
					} else {
						actor.skills.splice(index, 1);
					}
					break;
				}
				case 'stat': {
					const current = actor.stats[event.stat] ?? 0;
					actor.stats[event.stat] =
						event.value === undefined ? current + (event.delta ?? 0) : event.value;
					break;
				}
				case 'item_gain': {
					actor.items[event.item] = (actor.items[event.item] ?? 0) + event.qty;
					break;
				}
				case 'item_lose': {
					const held = actor.items[event.item] ?? 0;
					if (held < event.qty) {
						findings.push({
							kind: 'item_lost_not_held',
							detail: `${actor.id} has ${held}× '${event.item}', loses ${event.qty}`,
							where,
							actor: actor.id,
						});
					}
					actor.items[event.item] = Math.max(0, held - event.qty);
					break;
				}
				case 'level_set': {
					actor.level = event.value;
					findings.push({
						kind: 'level_set_used',
						detail: `${actor.id} level forced to ${event.value}, bypassing the curve`,
						where,
						actor: actor.id,
					});
					break;
				}
				case 'flag': {
					state.flags[event.key] = event.value;
					break;
				}
			}
		}

		// After the events, because a derived stat is a consequence of them: it
		// reads the state as it stands at this point in the story, which is what
		// makes it a fact about a scene rather than about a character sheet.
		for (const character of Object.values(state.characters)) {
			const system = systems.find(candidate => candidate.id === character.system);
			if (system === undefined) {
				continue;
			}
			await applyDerived(
				character,
				system,
				orderFor(system),
				formulas,
				step.id,
				findings,
			);
		}

		snapshots.set(step.id, cloneState(state));
	}

	return {state, findings, sequence, snapshots};
}
