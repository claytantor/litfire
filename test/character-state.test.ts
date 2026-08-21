import {describe, expect, it} from 'vitest';
import {
	arcSchema,
	characterSchema,
	momentSchema,
	situationSchema,
	systemSchema,
} from '../source/domain/schema.js';
import {runChecks} from '../source/ledger/checks.js';
import {replay} from '../source/ledger/replay.js';
import {
	allStates,
	castOf,
	momentByStep,
	stateId,
	statesAt,
} from '../source/ledger/state.js';

const system = systemSchema.parse({
	id: 'the-lathe',
	stats: [
		{id: 'insight', default: 10},
		{id: 'resolve', default: 10},
	],
	skills: [{id: 'reading-the-seam'}],
});

const moments = [
	momentSchema.parse({id: 'substrate-patch', at: 0}),
	momentSchema.parse({id: 'ascension-threshold', at: 1000}),
];

// `starts_after` is how an arc names its clock position — moments only flush
// into the sequence ahead of an arc that anchors itself to one.
const arcs = [arcSchema.parse({id: 'arc-01', order: 1, starts_after: 'substrate-patch'})];

const characters = [
	characterSchema.parse({id: 'inanna', system: 'the-lathe'}),
	characterSchema.parse({id: 'the-custodian', system: 'the-lathe'}),
];

/** Two characters, one scene, deliberately divergent stats and artifacts. */
const situations = [
	situationSchema.parse({
		id: 'sit-001',
		arc: 'arc-01',
		order: 1,
		characters: ['inanna', 'the-custodian'],
		events: [
			{type: 'stat', actor: 'inanna', stat: 'insight', delta: 5},
			{type: 'acquire_artifact', actor: 'inanna', artifact: 'the-keypair'},
			{type: 'stat', actor: 'the-custodian', stat: 'resolve', delta: 3},
		],
	}),
];

async function project() {
	return replay({
		systems: [system],
		moments,
		arcs,
		situations,
		characters,
		formulas: undefined,
	});
}

describe('the clock', () => {
	it('gives a moment its own position and lets a situation inherit the last one', async () => {
		const result = await project();
		const clock = momentByStep(result.sequence, situations);

		expect(clock.get('substrate-patch')).toBe('substrate-patch');
		// sit-001 sits after the first moment and before the second.
		expect(clock.get('sit-001')).toBe('substrate-patch');
	});

	it('honours an explicit anchor over the inherited one', async () => {
		const anchored = [
			situationSchema.parse({
				...situations[0],
				moment: 'ascension-threshold',
			}),
		];
		const result = await replay({
			systems: [system],
			moments,
			arcs,
			situations: anchored,
			characters,
			formulas: undefined,
		});

		expect(momentByStep(result.sequence, anchored).get('sit-001')).toBe(
			'ascension-threshold',
		);
	});

	it('leaves a scene before anything on the clock unplaced rather than guessing forward', async () => {
		// An arc with no `starts_after` puts every moment after its situations, so
		// nothing on the clock precedes this scene. Unplaced is the honest answer;
		// reaching forward to the next moment would date it before events it
		// follows.
		const loose = [arcSchema.parse({id: 'arc-01', order: 1})];
		const result = await replay({
			systems: [system],
			moments,
			arcs: loose,
			situations,
			characters,
			formulas: undefined,
		});
		const clock = momentByStep(result.sequence, situations);

		expect(clock.get('sit-001')).toBeUndefined();
		expect(stateId('inanna', clock.get('sit-001'))).toBe('inanna@unplaced');
	});

	/**
	 * The reported failure. `/situation <id> moment <m>` wrote the anchor and the
	 * tool went on saying "No moment on the clock, so every character state here
	 * is unplaced" — telling the author to set the field they had just set.
	 *
	 * A scene with no arc is not a replay step, and the clock was built by
	 * walking the sequence, so its explicit anchor was never read at all.
	 */
	it('honours an anchor on a scene that is not in the sequence at all', async () => {
		const inbox = [
			situationSchema.parse({
				id: 'sit-900',
				characters: ['inanna'],
				moment: 'substrate-patch',
				// No arc: it never replays.
			}),
		];
		const result = await replay({
			systems: [system],
			moments,
			arcs,
			situations: inbox,
			characters,
			formulas: undefined,
		});

		expect(result.sequence.some(step => step.id === 'sit-900')).toBe(false);
		expect(momentByStep(result.sequence, inbox).get('sit-900')).toBe('substrate-patch');
	});

	it('reads the cast of an unplaced scene at the moment it names', async () => {
		const inbox = [
			situationSchema.parse({
				id: 'sit-900',
				characters: ['inanna'],
				moment: 'substrate-patch',
			}),
		];
		const result = await replay({
			systems: [system],
			moments,
			arcs,
			situations: inbox,
			characters,
			formulas: undefined,
		});
		const cast = castOf(result, momentByStep(result.sequence, inbox), inbox[0]!);

		expect(cast.moment).toBe('substrate-patch');
		expect(cast.anchored).toBe(true);
		// A scene outside the sequence contributes no events, so the state at it
		// is exactly the state at its moment — not an approximation.
		expect(cast.states.map(state => state.id)).toEqual(['inanna@substrate-patch']);
		expect(cast.missing).toEqual([]);
	});

	it('leaves an unplaced scene with no anchor unplaced', async () => {
		const inbox = [situationSchema.parse({id: 'sit-901', characters: ['inanna']})];
		const result = await replay({
			systems: [system],
			moments,
			arcs,
			situations: inbox,
			characters,
			formulas: undefined,
		});

		// Nothing before it to inherit from, which is a real answer.
		expect(momentByStep(result.sequence, inbox).get('sit-901')).toBeUndefined();
	});

	it('still places a scene an unanchored arc holds, when the page says so', async () => {
		const loose = [arcSchema.parse({id: 'arc-01', order: 1})];
		const anchored = [
			situationSchema.parse({...situations[0], moment: 'substrate-patch'}),
		];
		const result = await replay({
			systems: [system],
			moments,
			arcs: loose,
			situations: anchored,
			characters,
			formulas: undefined,
		});

		expect(momentByStep(result.sequence, anchored).get('sit-001')).toBe(
			'substrate-patch',
		);
	});
});

describe('character states', () => {
	it('are addressed by character and moment', async () => {
		const result = await project();
		const clock = momentByStep(result.sequence, situations);
		const [state] = statesAt(result, clock, 'substrate-patch', ['inanna']);

		expect(state?.id).toBe('inanna@substrate-patch');
		expect(state?.character).toBe('inanna');
		expect(state?.moment).toBe('substrate-patch');
	});

	it('carry the system tracking the character', async () => {
		const result = await project();
		const clock = momentByStep(result.sequence, situations);

		for (const state of statesAt(result, clock, 'substrate-patch')) {
			expect(state.system).toBe('the-lathe');
		}
	});

	it('share a moment inside a situation and differ in stats and artifacts', async () => {
		const result = await project();
		const clock = momentByStep(result.sequence, situations);
		const cast = castOf(result, clock, situations[0]!);

		expect(cast.moment).toBe('substrate-patch');
		expect(cast.anchored).toBe(false);
		expect(cast.states.map(state => state.id)).toEqual([
			'inanna@substrate-patch',
			'the-custodian@substrate-patch',
		]);

		const [inanna, custodian] = cast.states;
		// Same moment, and nothing else in common.
		expect(inanna?.moment).toBe(custodian?.moment);
		expect(inanna?.stats['insight']).toBe(15);
		expect(custodian?.stats['insight']).toBe(10);
		expect(inanna?.artifacts).toEqual(['the-keypair']);
		expect(custodian?.artifacts).toEqual([]);
	});

	it('report a cast member the ledger never reached rather than inventing one', async () => {
		const withGhost = [
			situationSchema.parse({
				...situations[0],
				characters: ['inanna', 'nobody-wrote-them'],
			}),
		];
		const result = await replay({
			systems: [system],
			moments,
			arcs,
			situations: withGhost,
			characters,
			formulas: undefined,
		});
		const clock = momentByStep(result.sequence, withGhost);
		const cast = castOf(result, clock, withGhost[0]!);

		// `ensure` creates a row for a character named only by an event; this one
		// is named only by the cast list, so it has no state at all.
		expect(cast.missing).toEqual(['nobody-wrote-them']);
	});

	it('enumerate one state per character per moment', async () => {
		const result = await project();
		const ids = allStates(result, situations).map(state => state.id);

		expect(ids).toEqual([
			'inanna@substrate-patch',
			'the-custodian@substrate-patch',
			'inanna@ascension-threshold',
			'the-custodian@ascension-threshold',
		]);
	});
});

describe('the anchor', () => {
	it('is reported when it names a moment that does not exist', async () => {
		const dangling = [
			situationSchema.parse({...situations[0], moment: 'no-such-moment'}),
		];
		const result = await replay({
			systems: [system],
			moments,
			arcs,
			situations: dangling,
			characters,
			formulas: undefined,
		});
		const questions = runChecks({
			systems: [system],
			arcs,
			moments,
			situations: dangling,
			characters,
			factions: [],
			places: [],
			sources: [],
			legacy: [],
			artifacts: [],
			themes: [],
			replay: result,
			formulas: undefined,
		});

		expect(questions.some(question => question.detail.includes('no-such-moment'))).toBe(
			true,
		);
	});
});
