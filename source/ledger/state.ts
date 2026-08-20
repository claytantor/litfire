import type {Situation} from '../domain/schema.js';
import type {CharacterState, ReplayResult, Step} from './replay.js';

/**
 * A character state: one character, at one moment, with the stats, skills,
 * items and artifacts they hold there — and the system doing the tracking.
 *
 * This is a *derived* primitive and there is no file for it anywhere. It is the
 * intersection of two things the author did write: a character page, and a
 * point on the clock. Replay already computes a snapshot after every step
 * (§6.3); this gives the row inside that snapshot a name, an id, and a clock
 * position, which is what makes it something a situation can be built out of.
 *
 * The id is `character@moment` because that pair is the whole identity. Two
 * character states in the same scene share the moment half and agree on nothing
 * else: different stats, different artifacts, possibly different systems. That
 * is the point of the concept — a situation is several of these standing in the
 * same place at the same time.
 */
export type CharacterStateView = {
	/** `character@moment`, or `character@unplaced` off the clock. */
	readonly id: string;
	readonly character: string;
	/** Undefined when nothing on the clock precedes this state (§5). */
	readonly moment: string | undefined;
	/** The replay step the snapshot was taken after — a moment or a situation. */
	readonly at: string;
	/** The system tracking them here; undefined when it could not be resolved. */
	readonly system: string | undefined;
	readonly level: number;
	readonly xp: number;
	readonly stats: Readonly<Record<string, number>>;
	readonly skills: readonly string[];
	readonly items: Readonly<Record<string, number>>;
	readonly artifacts: readonly string[];
};

/** Every character state a situation puts on stage together. */
export type SituationCast = {
	readonly situation: string;
	/** The moment they all share. Undefined when the scene is off the clock. */
	readonly moment: string | undefined;
	/** Whether `moment` was written on the page or inherited from the sequence. */
	readonly anchored: boolean;
	readonly states: readonly CharacterStateView[];
	/** Cast members with no state at this point — reported, never invented (P4). */
	readonly missing: readonly string[];
};

/** Step id → the moment it sits at. Built once, read many times. */
export type Clock = ReadonlyMap<string, string | undefined>;

/** Stands in for the moment half of the id when there is no clock position. */
export const UNPLACED = 'unplaced';

export function stateId(character: string, moment: string | undefined): string {
	return `${character}@${moment ?? UNPLACED}`;
}

/**
 * Resolves every step in the replay sequence to the moment it happens at.
 *
 * A moment is its own clock position. A situation takes the moment written on
 * its page, and otherwise inherits the last moment before it in the sequence —
 * which is almost always right, because ordering arcs is how an author says
 * when things happen, and making them restate it per scene would be asking for
 * the same fact twice.
 *
 * Leading situations resolve to `undefined` rather than to the first moment
 * that follows them: a scene before anything on the clock is genuinely unplaced,
 * and guessing forward would put it after events it precedes.
 */
export function momentByStep(
	sequence: readonly Step[],
	situations: readonly Situation[],
): Clock {
	const anchored = new Map(
		situations
			.filter(situation => situation.moment !== undefined)
			.map(situation => [situation.id, situation.moment] as const),
	);
	const clock = new Map<string, string | undefined>();
	let current: string | undefined;

	for (const step of sequence) {
		if (step.kind === 'moment') {
			current = step.id;
			clock.set(step.id, step.id);
			continue;
		}
		clock.set(step.id, anchored.get(step.id) ?? current);
	}

	/**
	 * An unplaced situation is not a step, so the loop above never reaches it —
	 * and a scene whose author has written `moment:` on it has a clock position
	 * whether or not it sits on an arc. Reading the anchor only for situations
	 * that replay meant the tool ignored the very field it had just written, and
	 * went on telling the author to set the thing they had set.
	 *
	 * Inheritance still requires the sequence: a scene with no anchor and no arc
	 * has nothing before it to inherit from, which is a real answer.
	 */
	for (const [id, moment] of anchored) {
		if (!clock.has(id)) {
			clock.set(id, moment);
		}
	}

	return clock;
}

function viewOf(
	state: CharacterState,
	moment: string | undefined,
	at: string,
): CharacterStateView {
	return {
		id: stateId(state.id, moment),
		character: state.id,
		moment,
		at,
		system: state.system,
		level: state.level,
		xp: state.xp,
		stats: state.stats,
		skills: state.skills,
		items: state.items,
		artifacts: state.artifacts,
	};
}

/**
 * Every character state at one step, id-sorted.
 *
 * `only` narrows to a named cast; without it every character the ledger knows
 * about at that point is returned, which is what a moment-level view wants.
 */
export function statesAt(
	replay: ReplayResult,
	clock: Clock,
	stepId: string,
	only?: readonly string[],
): CharacterStateView[] {
	const snapshot = replay.snapshots.get(stepId);
	if (snapshot === undefined) {
		return [];
	}

	const moment = clock.get(stepId);
	const wanted = only ?? Object.keys(snapshot.characters).toSorted();

	return wanted
		.map(id => snapshot.characters[id])
		.filter((state): state is CharacterState => state !== undefined)
		.map(state => viewOf(state, moment, stepId));
}

/**
 * The cast of a situation: the states of everyone in it, sharing its moment.
 *
 * State is read at the situation's own step, so it is the state *after* the
 * scene's events have applied — the same point `/status write` renders a status
 * block from. A scene is written from what it leaves behind as much as from
 * what it starts with, and having the two commands disagree about which end of
 * the scene they mean would be worse than either choice.
 */
export function castOf(
	replay: ReplayResult,
	clock: Clock,
	situation: Situation,
): SituationCast {
	const moment = clock.get(situation.id);

	/**
	 * A placed scene has a snapshot of its own, taken after its events. An
	 * unplaced one has none — it never replays — so the states are read at the
	 * moment it says it happens at instead. That is the best available truth and
	 * it is exact: a scene outside the sequence contributes no events, so the
	 * state at it *is* the state at its moment.
	 */
	const at = replay.snapshots.has(situation.id) ? situation.id : (moment ?? situation.id);
	const states = statesAt(replay, clock, at, situation.characters).map(state => ({
		...state,
		// Addressed by the scene's moment however the snapshot was found, so two
		// scenes at one moment agree about where they are.
		id: stateId(state.character, moment),
		moment,
	}));
	const present = new Set(states.map(state => state.character));

	return {
		situation: situation.id,
		moment,
		anchored: situation.moment !== undefined,
		states,
		missing: situation.characters.filter(id => !present.has(id)),
	};
}

/**
 * Every character state in the vault, in clock order — the addressable set.
 *
 * Taken at moments only, not at every step. A situation's states are the same
 * characters at the same moment, so including both would list each state twice
 * under two different ids and make the grid look bigger than the world is.
 */
export function allStates(
	replay: ReplayResult,
	situations: readonly Situation[],
): CharacterStateView[] {
	const clock = momentByStep(replay.sequence, situations);

	return replay.sequence
		.filter(step => step.kind === 'moment')
		.flatMap(step => statesAt(replay, clock, step.id));
}
