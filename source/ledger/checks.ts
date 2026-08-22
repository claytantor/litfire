import type {
	Arc,
	Artifact,
	Character,
	Faction,
	Place,
	Situation,
	SystemDef,
	Theme,
	Moment,
} from '../domain/schema.js';
import type {FormulaRunner} from '../system/sandbox.js';
import {LEGACY_DIRECTORIES, LEGACY_FILES, VAULT} from '../vault/paths.js';
import type {Source} from '../vault/load.js';
import {BUILT_IN_FIELDS, fieldsOf} from '../system/interface.js';
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
	/** The status screen each system draws, by id. */
	readonly interfaces: Readonly<Record<string, string>>;
	readonly arcs: readonly Arc[];
	readonly moments: readonly Moment[];
	readonly situations: readonly Situation[];
	readonly characters: readonly Character[];
	readonly factions: readonly Faction[];
	readonly places: readonly Place[];
	/** Where each page was read from, so a finding can name a file. */
	readonly sources: readonly Source[];
	/** Superseded files the loader still read, vault-relative. */
	readonly legacy: readonly string[];
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
	const momentIds = new Set(input.moments.map(moment => moment.id));
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

		// Only an explicit anchor is checkable. A situation with no moment has
		// inherited one from the sequence, which cannot dangle by construction.
		if (situation.moment !== undefined && !momentIds.has(situation.moment)) {
			findings.push({
				kind: 'broken_reference',
				detail: `situation '${situation.id}' anchors to moment '${situation.moment}', which does not exist`,
				where: situation.id,
			});
		}

		// A cast member with no page: the scene names them, the wiki links them,
		// and nothing anywhere says who they are. Reported rather than refused,
		// because naming someone before writing them up is a normal order to
		// work in — but silence here is how a typo in a cast list survives.
		for (const member of situation.characters) {
			if (!characterIds.has(member)) {
				findings.push({
					kind: 'broken_reference',
					detail: `situation '${situation.id}' casts '${member}', which has no character page`,
					where: situation.id,
					actor: member,
				});
			}
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
 * A system whose stats do nothing.
 *
 * Declaring a stat is half of having one. The other half is something that
 * changes it — a ledger event in a scene, or a formula that derives it from
 * the rest of the state. With neither, every sheet under that system shows the
 * declared defaults, in every scene, forever: the numbers are decoration, and
 * nothing an author writes moves them.
 *
 * That is invisible from inside. A system page with eleven stats on it looks
 * finished, `/sheet` renders happily, and the vault reports no error, because
 * nothing is wrong — there is simply nothing there. One real vault had fifteen
 * stats across two systems and not one event touching any of them.
 *
 * Reported per system, not per stat. Fifteen findings saying the same thing
 * would bury it, and the decision is one decision: this system needs a stats
 * model.
 */
function inertStats(input: CheckInput): Finding[] {
	const changed = new Set<string>();
	for (const situation of input.situations) {
		for (const event of situation.events ?? []) {
			if (event.type === 'stat') {
				changed.add(event.stat);
			}
		}
	}

	return input.systems.flatMap(system => {
		if (system.stub) {
			return [];
		}

		if (system.stats.length === 0) {
			return [
				{
					kind: 'system_stats_unset',
					detail: `system '${system.id}' declares no stats — nothing a character does under it can be tracked`,
					where: system.id,
				},
			];
		}

		// Derived or driven: either counts as alive. A stat with a formula moves
		// when the state it reads moves, without any event naming it.
		const live = system.stats.filter(
			stat => changed.has(stat.id) || stat.formula !== undefined,
		);
		if (live.length > 0) {
			return [];
		}

		return [
			{
				kind: 'system_stats_inert',
				detail: `system '${system.id}' declares ${String(system.stats.length)} stat(s) that nothing changes and none derives — every sheet under it shows defaults`,
				where: system.id,
			},
		];
	});
}

/**
 * A status screen asking for something the system does not have.
 *
 * This is what makes the interface a specification rather than decoration. An
 * author draws `{coherence}` on the screen their world shows, and that is a
 * statement that coherence exists — so a placeholder with nothing behind it is
 * the gap between the world they have described and the world the tool knows
 * about, which is precisely the kind of thing this queue is for.
 *
 * Rendering leaves the placeholder standing rather than blanking it, so the two
 * halves agree: the screen shows `{coherence}` and the queue says why.
 */
function interfaceFields(input: CheckInput): Finding[] {
	const findings: Finding[] = [];

	for (const system of input.systems) {
		const template = input.interfaces[system.id];
		if (template === undefined) {
			continue;
		}

		const declared = new Set(system.stats.map(stat => stat.id));
		for (const field of fieldsOf(template)) {
			if (declared.has(field) || (BUILT_IN_FIELDS as readonly string[]).includes(field)) {
				continue;
			}
			findings.push({
				kind: 'interface_field_unknown',
				detail: `'${system.id}' draws {${field}} on its status screen, and declares no such stat`,
				where: system.id,
			});
		}
	}

	return findings;
}

/**
 * An event that moves a stat the system computes.
 *
 * Applying it would work and then be undone: derived stats are recomputed after
 * every step, so the event's value survives exactly until the formula runs.
 * Reported rather than refused, because which of the two the author meant is
 * theirs to decide — drop the event, or drop the formula and let the scene
 * drive the number.
 */
function derivedStatsDriven(input: CheckInput): Finding[] {
	const derived = new Map<string, string>();
	for (const system of input.systems) {
		for (const stat of system.stats) {
			if (stat.formula !== undefined) {
				derived.set(stat.id, system.id);
			}
		}
	}

	const findings: Finding[] = [];
	for (const situation of input.situations) {
		for (const event of situation.events ?? []) {
			if (event.type !== 'stat') {
				continue;
			}
			const system = derived.get(event.stat);
			if (system !== undefined) {
				findings.push({
					kind: 'derived_stat_driven',
					detail: `${situation.id} changes '${event.stat}', which '${system}' computes — the formula overwrites it at the end of the step`,
					where: situation.id,
					actor: event.actor,
				});
			}
		}
	}

	return findings;
}

/**
 * A file whose name is not its id.
 *
 * The id is the filename stem by convention, and the convention was only that:
 * `loadOne` falls back to the stem when frontmatter omits an id, but a file
 * saying one thing while being named another loaded happily. That is how one
 * situation came to exist as both `situations/sit-001.md` and
 * `situations/inbox/sit-001-inanna-hears-her-parents-argue.md` — nothing could
 * see that the second was the same page, because nothing was looking at names.
 *
 * Reported rather than refused (P4). Renaming a file is the author's to do, and
 * a vault that will not load because a slug drifted would be worse than one
 * that says so.
 */
function misnamedFiles(input: CheckInput): Finding[] {
	const findings: Finding[] = input.sources
		.filter(source => source.stem !== source.id)
		.map(source => ({
			kind: 'file_name_not_id',
			detail: `${source.path} declares id '${source.id}' — rename it to ${source.id}.md so one id means one file`,
			where: source.id,
		}));

	/**
	 * `situations/inbox/` is still read so existing vaults keep working, and
	 * nothing writes there any more. It meant "no arc", which the frontmatter
	 * already says — and having a second legal home for one id is how a scene
	 * came to exist in both at once.
	 */
	for (const source of input.sources) {
		if (source.path.startsWith(`${VAULT.inbox}/`)) {
			findings.push({
				kind: 'legacy_location',
				detail: `${source.path} is in the old inbox — move it to ${VAULT.situations}/${source.id}.md; a scene with no arc is already unplaced`,
				where: source.id,
			});
		}
	}

	/**
	 * The same finding for the files that predate a primitive being a page. The
	 * loader reports which ones it actually read, so an absent file is silent and
	 * a present one is named alongside what now replaces it.
	 *
	 * Worth saying because these are not merely old: a vault holding both
	 * `system/stats.md` and `systems/<id>.md` has two systems where the author
	 * means one, and every stat on a sheet resolves against whichever the loader
	 * picked.
	 */
	for (const where of input.legacy) {
		const now = LEGACY_FILES[where] ?? LEGACY_DIRECTORIES[where];
		findings.push({
			kind: 'legacy_location',
			detail:
				now === undefined
					? `${where} is a superseded layout`
					: `${where} is a superseded layout — its content now belongs in ${now}${LEGACY_DIRECTORIES[where] === undefined ? '' : '/'}`,
			where,
		});
	}

	return findings;
}

/**
 * Two pages claiming to be the same thing.
 *
 * Ids are the vault's primary key: they are the filename stem, the wikilink
 * target, and what every cross-reference in frontmatter resolves against. Two
 * pages declaring the same one is not a style problem — replay, the wiki and
 * every lookup silently pick whichever loaded first, and the other page becomes
 * invisible while still sitting on disk.
 *
 * Names are checked too, and separately, because that is the failure that
 * actually happens. Extraction runs twice over the same interview, slugs the
 * same event two different ways, and produces `inannas-first-memory` and
 * `the-first-memory` — distinct ids, identical `name`, one moment. No id check
 * would ever catch it, and the author sees their timeline quietly double.
 *
 * Both are reported, never resolved: which page is the real one, and what to do
 * with the other, is the author's call every time (P4).
 */
function duplicates(input: CheckInput): Finding[] {
	const findings: Finding[] = [];

	const kinds = [
		{kind: 'moment', pages: input.moments},
		{kind: 'arc', pages: input.arcs},
		{kind: 'situation', pages: input.situations},
		{kind: 'character', pages: input.characters},
		{kind: 'faction', pages: input.factions},
		{kind: 'place', pages: input.places},
		{kind: 'artifact', pages: input.artifacts},
		{kind: 'theme', pages: input.themes},
	] as const;

	for (const {kind, pages} of kinds) {
		const byId = new Map<string, number>();
		for (const page of pages) {
			byId.set(page.id, (byId.get(page.id) ?? 0) + 1);
		}
		for (const [id, count] of byId) {
			if (count > 1) {
				// Named, not counted. "There are two of these somewhere" is a fact
				// the author then has to go hunting for; the paths are the fix.
				const where = input.sources
					.filter(source => source.kind === kind && source.id === id)
					.map(source => source.path);
				findings.push({
					kind: 'duplicate_id',
					detail:
						where.length > 0
							? `${where.join(' and ')} both declare id '${id}'; only one is ever resolved`
							: `${String(count)} ${kind} pages declare id '${id}'; everything that resolves it sees only one of them`,
					where: id,
				});
			}
		}

		// Grouped case-insensitively and on trimmed text: two extraction passes
		// rarely disagree about a name in a way a reader would notice.
		const byName = new Map<string, string[]>();
		for (const page of pages) {
			const name = 'name' in page ? page.name : 'title' in page ? page.title : undefined;
			if (typeof name !== 'string' || name.trim() === '') {
				continue;
			}
			const key = name.trim().toLowerCase();
			byName.set(key, [...(byName.get(key) ?? []), page.id]);
		}
		for (const [, ids] of byName) {
			const distinct = [...new Set(ids)].toSorted();
			// Two pages under one id are already `duplicate_id`, and reporting them
			// again here produced "situations sit-001, sit-001 share one name",
			// which reads as a bug in the tool rather than a fact about the vault.
			if (ids.length > 1 && distinct.length > 1) {
				findings.push({
					kind: 'duplicate_name',
					detail: `${kind}s ${distinct.join(', ')} share one name — likely the same thing written twice`,
					where: distinct[0] ?? kind,
				});
			}
		}
	}

	return findings;
}

/**
 * Two moments the author placed at the same instant.
 *
 * This used to also warn that positions past `Number.MAX_SAFE_INTEGER` could
 * not be told apart: `at` was a double, exact only to about ±285 million years
 * in seconds, and a story opening in deep time crossed that easily. The clock
 * is a bigint now and exact across its whole ±1 trillion year range, so that
 * finding cannot occur and is gone. What remains is the real case — two
 * turning points genuinely written at the same second.
 *
 * Ties are broken by id, which is deterministic but arbitrary. When the author
 * meant an order, saying so beats picking one alphabetically and moving on.
 */
function clockCollisions(input: CheckInput): Finding[] {
	const findings: Finding[] = [];
	const byPosition = new Map<string, string[]>();

	for (const event of input.moments) {
		if (event.at === undefined) {
			continue;
		}
		// Keyed by the decimal string: a Map keys bigints by identity well enough,
		// but the string is what the message needs anyway.
		const key = event.at.toString();
		byPosition.set(key, [...(byPosition.get(key) ?? []), event.id]);
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

	/**
	 * A scene with no arc is unplaced, which is a valid permanent state — and
	 * also means it is absent from every replay, so nothing in it reaches the
	 * ledger and nobody in it has a state at it. Both halves are true and only
	 * the first was ever said out loud.
	 *
	 * Once, with a count, rather than once per scene. An author may have fifty
	 * scenes waiting to be placed and that is not fifty problems; it is one
	 * fact about the vault, and fifty findings would bury it.
	 */
	const loose = input.situations.filter(situation => situation.arc === undefined);
	if (loose.length > 0) {
		const named = loose
			.slice(0, 3)
			.map(situation => situation.id)
			.join(', ');
		findings.push({
			kind: 'situation_unplaced',
			detail: `${String(loose.length)} scene(s) are on no arc — ${named}${loose.length > 3 ? `, and ${String(loose.length - 3)} more` : ''} — so they are in no replay and contribute nothing to the ledger`,
			where: loose[0]?.id ?? 'situations',
		});
	}

	return findings;
}

function formulaErrors(input: CheckInput): Finding[] {
	return (input.formulas?.errors ?? []).map(error => ({
		kind: 'formula_error',
		detail: `formula '${error.id}' failed to compile: ${error.message}`,
		where: VAULT.formulas,
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
		...clockCollisions(input),
		...duplicates(input),
		...misnamedFiles(input),
		...systemNames(input),
		...factionGoals(input),
		...inertStats(input),
		...derivedStatsDriven(input),
		...interfaceFields(input),
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
