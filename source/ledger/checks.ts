import type {
	Arc,
	Artifact,
	Character,
	Faction,
	Situation,
	SystemDef,
	Theme,
	Moment,
} from '../domain/schema.js';
import type {FormulaRunner} from '../system/sandbox.js';
import {VAULT} from '../vault/paths.js';
import {systemFor, type Finding, type LedgerState, type ReplayResult} from './replay.js';

export type OpenQuestion = {
	readonly id: string;
	readonly kind: string;
	readonly detail: string;
	readonly where: string;
	readonly actor?: string;
	readonly source: 'deterministic' | 'llm';
	readonly status: 'open' | 'resolved' | 'accepted';
};

export type CheckInput = {
	readonly systems: readonly SystemDef[];
	readonly arcs: readonly Arc[];
	readonly moments: readonly Moment[];
	readonly situations: readonly Situation[];
	readonly characters: readonly Character[];
	readonly factions: readonly Faction[];
	readonly artifacts: readonly Artifact[];
	readonly themes: readonly Theme[];
	readonly replay: ReplayResult;
	readonly formulas: FormulaRunner | undefined;
};

/**
 * State at the end of an arc — the checkpoint milestone drift compares against.
 */
function stateAtArcEnd(
	arcId: string,
	replayResult: ReplayResult,
): LedgerState | undefined {
	const last = replayResult.sequence
		.toReversed()
		.find(step => step.kind === 'situation' && step.arc === arcId);
	return last ? replayResult.snapshots.get(last.id) : undefined;
}

function milestoneDrift(input: CheckInput): Finding[] {
	const findings: Finding[] = [];

	for (const arc of input.arcs) {
		const state = stateAtArcEnd(arc.id, input.replay);
		if (!state) {
			continue;
		}

		for (const [characterId, milestone] of Object.entries(arc.milestone)) {
			const actual = state.characters[characterId];
			if (!actual) {
				continue;
			}

			if (milestone.level !== undefined && actual.level !== milestone.level) {
				findings.push({
					kind: 'milestone_drift',
					detail: `milestone expects ${characterId} at L${milestone.level}; replay gives L${actual.level}`,
					where: arc.id,
					actor: characterId,
				});
			}

			for (const skill of milestone.has_skills) {
				if (!actual.skills.includes(skill)) {
					findings.push({
						kind: 'milestone_drift',
						detail: `milestone expects ${characterId} to hold '${skill}' by end of ${arc.id}`,
						where: arc.id,
						actor: characterId,
					});
				}
			}

			for (const [stat, expected] of Object.entries(milestone.stats)) {
				if ((actual.stats[stat] ?? 0) !== expected) {
					findings.push({
						kind: 'milestone_drift',
						detail: `milestone expects ${characterId} ${stat}=${expected}; replay gives ${actual.stats[stat] ?? 0}`,
						where: arc.id,
						actor: characterId,
					});
				}
			}
		}
	}

	return findings;
}

/**
 * A skill is "used" when prose or events reference it before the acquiring
 * event. Prerequisites declared in the system are checked the same way.
 */
function skillPrerequisites(input: CheckInput): Finding[] {
	const findings: Finding[] = [];
	// Skills are resolved through the acquiring character's own system, so a
	// skill the Seed grants is not "undefined" merely because the Custodian has
	// never heard of it.
	const defsFor = (actor: string) => {
		const system = systemFor(input.replay.state.characters[actor]?.system, input.systems);
		return new Map((system?.skills ?? []).map(skill => [skill.id, skill]));
	};
	const held = new Map<string, Set<string>>();

	const heldBy = (actor: string) => {
		let set = held.get(actor);
		if (!set) {
			set = new Set();
			held.set(actor, set);
		}
		return set;
	};

	const byId = new Map(input.situations.map(situation => [situation.id, situation]));

	for (const step of input.replay.sequence) {
		const situation = byId.get(step.id);
		if (!situation) {
			continue;
		}

		for (const event of situation.events) {
			if (event.type !== 'acquire_skill') {
				continue;
			}

			const actorSystem = input.replay.state.characters[event.actor]?.system;
			const definition = defsFor(event.actor).get(event.skill);
			if (!definition) {
				findings.push({
					kind: 'unknown_skill',
					detail: `'${event.skill}' is not defined by ${actorSystem === undefined ? "the actor's system" : `system '${actorSystem}'`}`,
					where: situation.id,
					actor: event.actor,
				});
				continue;
			}

			for (const prerequisite of definition.requires_skills) {
				if (!heldBy(event.actor).has(prerequisite)) {
					findings.push({
						kind: 'skill_before_prerequisite',
						detail: `${event.actor} acquires '${event.skill}' without prerequisite '${prerequisite}'`,
						where: situation.id,
						actor: event.actor,
					});
				}
			}

			heldBy(event.actor).add(event.skill);
		}
	}

	return findings;
}

function statRanges(input: CheckInput): Finding[] {
	const findings: Finding[] = [];
	const defsById = new Map(
		input.systems.map(
			system => [system.id, new Map(system.stats.map(stat => [stat.id, stat]))] as const,
		),
	);

	for (const character of Object.values(input.replay.state.characters)) {
		// A range is a rule of one system. Judging the Custodian's numbers by the
		// Seed's bounds would invent violations that exist in neither.
		const defs = defsById.get(character.system ?? '') ?? new Map();
		for (const [statId, value] of Object.entries(character.stats)) {
			const definition = defs.get(statId);
			if (!definition) {
				continue;
			}

			if (value < 0 && !definition.allow_negative) {
				findings.push({
					kind: 'stat_negative',
					detail: `${character.id} ${statId} is ${value}; negatives disallowed`,
					where: 'ledger',
					actor: character.id,
				});
			}
			if (definition.min !== undefined && value < definition.min) {
				findings.push({
					kind: 'stat_out_of_range',
					detail: `${character.id} ${statId}=${value} below min ${definition.min}`,
					where: 'ledger',
					actor: character.id,
				});
			}
			if (definition.max !== undefined && value > definition.max) {
				findings.push({
					kind: 'stat_out_of_range',
					detail: `${character.id} ${statId}=${value} above max ${definition.max}`,
					where: 'ledger',
					actor: character.id,
				});
			}
		}
	}

	return findings;
}

function brokenReferences(input: CheckInput): Finding[] {
	const findings: Finding[] = [];
	const arcIds = new Set(input.arcs.map(arc => arc.id));
	const characterIds = new Set(input.characters.map(character => character.id));
	const subthemeIds = new Set(
		input.themes.flatMap(theme => theme.subthemes.map(sub => sub.id)),
	);

	for (const situation of input.situations) {
		if (situation.arc !== undefined && !arcIds.has(situation.arc)) {
			findings.push({
				kind: 'broken_reference',
				detail: `situation '${situation.id}' names arc '${situation.arc}', which does not exist`,
				where: situation.id,
			});
		}

		for (const theme of situation.themes) {
			if (!subthemeIds.has(theme)) {
				findings.push({
					kind: 'broken_reference',
					detail: `situation '${situation.id}' tags unknown sub-theme '${theme}'`,
					where: situation.id,
				});
			}
		}
	}

	// Membership is the reason factions are typed rather than prose: a name that
	// only ever appears inside one paragraph cannot be checked, back-linked, or
	// noticed when it turns out nobody ever wrote that person down.
	for (const faction of input.factions) {
		for (const member of faction.members) {
			if (!characterIds.has(member)) {
				findings.push({
					kind: 'broken_reference',
					detail: `faction '${faction.id}' lists member '${member}', which has no character page`,
					where: faction.id,
					actor: member,
				});
			}
		}
	}

	return findings;
}

/**
 * Artifacts referenced by the ledger, checked against their pages.
 *
 * Prerequisites are resolved at the moment of *use* rather than acquisition: a
 * character can be handed a rifle before they can shoot it, and the story where
 * they carry something they cannot yet work is a better story than one the tool
 * refuses. What is worth saying is that they used it anyway.
 */
function artifactUse(input: CheckInput): Finding[] {
	const findings: Finding[] = [];
	const defs = new Map(input.artifacts.map(artifact => [artifact.id, artifact]));
	const byId = new Map(input.situations.map(situation => [situation.id, situation]));
	const held = new Map<string, Set<string>>();

	for (const step of input.replay.sequence) {
		const situation = byId.get(step.id);
		if (!situation) {
			continue;
		}

		for (const event of situation.events) {
			if (
				event.type !== 'acquire_artifact' &&
				event.type !== 'lose_artifact' &&
				event.type !== 'use_artifact'
			) {
				continue;
			}

			const definition = defs.get(event.artifact);
			if (!definition) {
				findings.push({
					kind: 'unknown_artifact',
					detail: `'${event.artifact}' has no page in ${VAULT.artifacts}/`,
					where: situation.id,
					actor: event.actor,
				});
				continue;
			}

			let carried = held.get(event.actor);
			if (!carried) {
				carried = new Set(
					input.characters.find(c => c.id === event.actor)?.artifacts ?? [],
				);
				held.set(event.actor, carried);
			}

			if (event.type === 'acquire_artifact') {
				carried.add(event.artifact);
				continue;
			}
			if (event.type === 'lose_artifact') {
				carried.delete(event.artifact);
				continue;
			}

			const state = input.replay.snapshots.get(situation.id)?.characters[event.actor];
			for (const prerequisite of definition.requires_skills) {
				if (!state?.skills.includes(prerequisite)) {
					findings.push({
						kind: 'artifact_without_skill',
						detail: `${event.actor} uses '${event.artifact}' without '${prerequisite}'`,
						where: situation.id,
						actor: event.actor,
					});
				}
			}
			if (
				definition.requires_level !== undefined &&
				state !== undefined &&
				state.level < definition.requires_level
			) {
				findings.push({
					kind: 'artifact_below_level',
					detail: `${event.actor} uses '${event.artifact}' at L${state.level}; it needs L${definition.requires_level}`,
					where: situation.id,
					actor: event.actor,
				});
			}
		}
	}

	return findings;
}

/**
 * An artifact nobody has said the purpose of.
 *
 * Same standard as a faction's goal: what it achieves is what makes it an
 * artifact rather than set dressing, and it is the field an interview reaches
 * last. Asked for, never required — a page that fails to parse takes the thing
 * out of the ledger entirely.
 */
function artifactOutcomes(input: CheckInput): Finding[] {
	return input.artifacts
		.filter(artifact => artifact.outcome === undefined || artifact.outcome.trim() === '')
		.map(artifact => ({
			kind: 'artifact_outcome_unknown',
			detail: `artifact '${artifact.id}' has no outcome — what does a character achieve by using it?`,
			where: artifact.id,
		}));
}

/**
 * A system with no name.
 *
 * A name is required in the sense that matters — the tool asks for it, the
 * interview namespace is built from it, and every view says so — but not in the
 * sense that rejects the page. A system whose file fails to parse takes every
 * stat of every character under it out of the ledger, and losing a whole cast's
 * numbers over a missing title is a worse outcome than an open question.
 */
function systemNames(input: CheckInput): Finding[] {
	return input.systems
		.filter(system => system.name === undefined || system.name.trim() === '')
		.map(system => ({
			kind: 'system_unnamed',
			detail: `system '${system.id}' has no name — add \`name:\` to its page so interviews and views can call it something`,
			where: system.id,
		}));
}

/**
 * A faction nobody has said the purpose of.
 *
 * The goal is what separates a faction from a crowd, so a page without one is
 * not finished — but it is also the field an interview reaches last, and a
 * schema that refused the page would lose the fact that the group exists at all.
 * Asking is the whole compromise.
 */
function factionGoals(input: CheckInput): Finding[] {
	return input.factions
		.filter(faction => faction.goal === undefined || faction.goal.trim() === '')
		.map(faction => ({
			kind: 'faction_goal_unknown',
			detail: `faction '${faction.id}' has no goal — what are they working toward?`,
			where: faction.id,
		}));
}

/**
 * Positions the in-world clock cannot actually tell apart.
 *
 * `at` is a JavaScript number, so it is exact only while |at| stays inside
 * `Number.MAX_SAFE_INTEGER`. A clock counting seconds reaches that in about 285
 * million years — well within reach of a story that opens in deep time, where
 * 800 million years ago is roughly 2.5e16 seconds and the spacing between
 * representable values is four seconds.
 *
 * Nothing here is wrong yet: sorting still works, the value survives YAML and
 * JSON intact, and turning points that reshape a world are not four seconds
 * apart. What must not happen is the *silent* version — two events written a
 * second apart, landing on the same instant, ordered by id, with nothing said.
 * So the granularity is stated, and a genuine collision is reported.
 */
function clockPrecision(input: CheckInput): Finding[] {
	const findings: Finding[] = [];
	const dated = input.moments.filter(event => event.at !== undefined);

	for (const event of dated) {
		const at = event.at ?? 0;
		if (Number.isSafeInteger(at)) {
			continue;
		}

		// Measured rather than assumed: the gap doubles with the exponent, so the
		// number the author needs is the one for *their* magnitude.
		let granularity = 1;
		while (at - granularity === at) {
			granularity *= 2;
		}

		findings.push({
			kind: 'clock_beyond_exact_range',
			detail: `moment '${event.id}' sits at ${at}, past the exact-integer range — positions within ${String(granularity)} of it cannot be told apart`,
			where: event.id,
		});
	}

	// Ties are broken by id, which is deterministic but arbitrary. When the author
	// meant an order, saying so beats picking one alphabetically and moving on.
	const byPosition = new Map<number, string[]>();
	for (const event of dated) {
		const at = event.at ?? 0;
		byPosition.set(at, [...(byPosition.get(at) ?? []), event.id]);
	}
	for (const [at, ids] of byPosition) {
		if (ids.length > 1) {
			findings.push({
				kind: 'clock_collision',
				detail: `${ids.toSorted().join(', ')} all sit at ${at}; replay orders them by id`,
				where: ids.toSorted()[0] ?? 'timeline',
			});
		}
	}

	return findings;
}

/**
 * Corpus that exists but cannot be sequenced.
 *
 * Spillover writes a page the moment an interview establishes something, which
 * is the point — the fact survives the interview that produced it. What it
 * cannot do is decide where on the clock the author wants it, so the position
 * is left absent and reported here. Without this the page is silently inert:
 * present in the vault, absent from every replay, and nothing says why.
 */
function unplaced(input: CheckInput): Finding[] {
	const findings: Finding[] = [];

	for (const event of input.moments) {
		if (event.at === undefined) {
			findings.push({
				kind: 'moment_undated',
				detail: `moment '${event.id}' has no position on the clock, so nothing it carries reaches the ledger`,
				where: event.id,
			});
		}
	}

	for (const arc of input.arcs) {
		if (arc.order === undefined) {
			findings.push({
				kind: 'arc_unordered',
				detail: `arc '${arc.id}' has no order, so it replays after every placed arc`,
				where: arc.id,
			});
		}
	}

	return findings;
}

function formulaErrors(input: CheckInput): Finding[] {
	return (input.formulas?.errors ?? []).map(error => ({
		kind: 'formula_error',
		detail: `formula '${error.id}' failed to compile: ${error.message}`,
		where: 'system/formulas.md',
	}));
}

/** Deterministic ids so the queue is stable across recomputes. */
function toOpenQuestions(findings: readonly Finding[]): OpenQuestion[] {
	return findings.map((finding, index) => ({
		id: `oq-${String(index + 1).padStart(3, '0')}`,
		kind: finding.kind,
		detail: finding.detail,
		where: finding.where,
		...(finding.actor === undefined ? {} : {actor: finding.actor}),
		source: 'deterministic' as const,
		status: 'open' as const,
	}));
}

/**
 * Every deterministic check from §7.1. Ordering is stable so ids do not churn
 * between runs when nothing changed.
 */
export function runChecks(input: CheckInput): OpenQuestion[] {
	const findings = [
		// Sequence-order violations observed during replay itself.
		...input.replay.findings,
		...skillPrerequisites(input),
		...milestoneDrift(input),
		...statRanges(input),
		...brokenReferences(input),
		...unplaced(input),
		...clockPrecision(input),
		...systemNames(input),
		...factionGoals(input),
		...artifactUse(input),
		...artifactOutcomes(input),
		...formulaErrors(input),
	];

	const sorted = findings.toSorted(
		(a, b) =>
			a.where.localeCompare(b.where) ||
			a.kind.localeCompare(b.kind) ||
			a.detail.localeCompare(b.detail),
	);

	return toOpenQuestions(sorted);
}
