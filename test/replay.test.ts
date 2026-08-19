import {afterEach, describe, expect, it} from 'vitest';
import {
	arcSchema,
	characterSchema,
	situationSchema,
	systemSchema,
	momentSchema,
} from '../source/domain/schema.js';
import {runChecks} from '../source/ledger/checks.js';
import {buildSequence, replay} from '../source/ledger/replay.js';
import {FormulaRunner} from '../source/system/sandbox.js';

let runner: FormulaRunner | undefined;
afterEach(() => {
	runner?.dispose();
	runner = undefined;
});

const system = systemSchema.parse({
	stats: [
		{id: 'charisma', default: 10, min: 0, max: 30},
		{id: 'constitution', default: 10},
	],
	skills: [
		{id: 'clanging-vengeance'},
		{id: 'advanced-clanging', requires_skills: ['clanging-vengeance']},
	],
	curves: {xp_for_level: 'xp-for-level', max_level: 50},
});

const XP_CURVE = [
	{
		id: 'xp-for-level',
		source: '(level) => level <= 10 ? 100 * level ** 2 : 150 * level ** 2;',
	},
];

const carl = characterSchema.parse({id: 'carl', level: 1, xp: 0});
const donut = characterSchema.parse({id: 'donut', level: 1, xp: 0});

describe('buildSequence', () => {
	it('orders arcs, then situations within an arc, interleaving world events', () => {
		const moments = [
			momentSchema.parse({id: 'we-001', at: 0}),
			momentSchema.parse({id: 'we-002', at: 100}),
		];
		const arcs = [
			arcSchema.parse({id: 'arc-02', order: 2, starts_after: 'we-002'}),
			arcSchema.parse({id: 'arc-01', order: 1, starts_after: 'we-001'}),
		];
		const situations = [
			situationSchema.parse({id: 'sit-b', arc: 'arc-01', order: 20}),
			situationSchema.parse({id: 'sit-a', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'sit-c', arc: 'arc-02', order: 10}),
		];

		expect(buildSequence(moments, arcs, situations).map(s => s.id)).toEqual([
			'we-001',
			'sit-a',
			'sit-b',
			'we-002',
			'sit-c',
		]);
	});

	it('excludes unplaced situations', () => {
		const situations = [
			situationSchema.parse({id: 'placed', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'inbox-one'}),
		];
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];

		expect(buildSequence([], arcs, situations).map(s => s.id)).toEqual(['placed']);
	});

	it('is deterministic when two situations share an order', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({id: 'zeta', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'alpha', arc: 'arc-01', order: 10}),
		];

		expect(buildSequence([], arcs, situations).map(s => s.id)).toEqual(['alpha', 'zeta']);
	});
});

describe('replay', () => {
	it('applies xp and derives level from the curve', async () => {
		runner = await FormulaRunner.create(XP_CURVE);
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({
				id: 'sit-001',
				arc: 'arc-01',
				order: 10,
				events: [{actor: 'carl', type: 'xp', value: 450}],
			}),
		];

		const result = await replay({
			systems: [system],
			moments: [],
			arcs,
			situations,
			characters: [carl],
			formulas: runner,
		});

		// xp_for_level(2) = 400, (3) = 900 → level 2 at 450 xp.
		expect(result.state.characters['carl']?.xp).toBe(450);
		expect(result.state.characters['carl']?.level).toBe(2);
	});

	it('applies the full event vocabulary from the spec example', async () => {
		runner = await FormulaRunner.create(XP_CURVE);
		const arcs = [arcSchema.parse({id: 'arc-02', order: 2})];
		const situations = [
			situationSchema.parse({
				id: 'sit-042',
				title: 'The Elevator',
				arc: 'arc-02',
				order: 7,
				characters: ['carl', 'donut'],
				events: [
					{actor: 'carl', type: 'xp', value: 450, note: 'killed the tile-scraper'},
					{actor: 'carl', type: 'acquire_skill', skill: 'clanging-vengeance'},
					{actor: 'donut', type: 'stat', stat: 'charisma', delta: 1},
				],
			}),
		];

		const result = await replay({
			systems: [system],
			moments: [],
			arcs,
			situations,
			characters: [carl, donut],
			formulas: runner,
		});

		expect(result.state.characters['carl']?.skills).toEqual(['clanging-vengeance']);
		expect(result.state.characters['donut']?.stats['charisma']).toBe(11);
	});

	it('snapshots state at every step so /sheet can query a point', async () => {
		runner = await FormulaRunner.create(XP_CURVE);
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({
				id: 'sit-001',
				arc: 'arc-01',
				order: 10,
				events: [{actor: 'carl', type: 'xp', value: 400}],
			}),
			situationSchema.parse({
				id: 'sit-002',
				arc: 'arc-01',
				order: 20,
				events: [{actor: 'carl', type: 'xp', value: 500}],
			}),
		];

		const result = await replay({
			systems: [system],
			moments: [],
			arcs,
			situations,
			characters: [carl],
			formulas: runner,
		});

		expect(result.snapshots.get('sit-001')?.characters['carl']?.xp).toBe(400);
		expect(result.snapshots.get('sit-002')?.characters['carl']?.xp).toBe(900);
		// The earlier snapshot must not alias the mutable working state.
		expect(result.snapshots.get('sit-001')?.characters['carl']?.level).toBe(2);
	});

	it('handles item loss the character never held', async () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({
				id: 'sit-001',
				arc: 'arc-01',
				order: 10,
				events: [{actor: 'carl', type: 'item_lose', item: 'sword', qty: 1}],
			}),
		];

		const result = await replay({
			systems: [system],
			moments: [],
			arcs,
			situations,
			characters: [carl],
			formulas: undefined,
		});

		expect(result.findings.map(f => f.kind)).toContain('item_lost_not_held');
	});
});

describe('deterministic checks', () => {
	const buildAndCheck = async (
		arcs: ReturnType<typeof arcSchema.parse>[],
		situations: ReturnType<typeof situationSchema.parse>[],
	) => {
		runner = await FormulaRunner.create(XP_CURVE);
		const replayResult = await replay({
			systems: [system],
			moments: [],
			arcs,
			situations,
			characters: [carl],
			formulas: runner,
		});
		return runChecks({
			systems: [system],
			arcs,
			moments: [],
			situations,
			characters: [carl],
			factions: [],
			places: [],
			artifacts: [],
			themes: [],
			replay: replayResult,
			formulas: runner,
		});
	};

	// DoD 6
	it('a skill used before acquisition produces an open question and blocks nothing', async () => {
		const questions = await buildAndCheck(
			[arcSchema.parse({id: 'arc-01', order: 1})],
			[
				situationSchema.parse({
					id: 'sit-001',
					arc: 'arc-01',
					order: 10,
					// advanced-clanging requires clanging-vengeance, never acquired.
					events: [{actor: 'carl', type: 'acquire_skill', skill: 'advanced-clanging'}],
				}),
			],
		);

		const drift = questions.filter(q => q.kind === 'skill_before_prerequisite');
		expect(drift).toHaveLength(1);
		expect(drift[0]?.status).toBe('open');
		expect(drift[0]?.detail).toContain('clanging-vengeance');
	});

	// DoD 7
	it('milestone drift on an arc produces an open question', async () => {
		const questions = await buildAndCheck(
			[
				arcSchema.parse({
					id: 'arc-02',
					order: 2,
					milestone: {carl: {level: 12, has_skills: ['clanging-vengeance']}},
				}),
			],
			[
				situationSchema.parse({
					id: 'sit-042',
					arc: 'arc-02',
					order: 10,
					events: [{actor: 'carl', type: 'xp', value: 450}],
				}),
			],
		);

		const drift = questions.filter(q => q.kind === 'milestone_drift');
		expect(drift.length).toBeGreaterThanOrEqual(1);
		expect(drift.some(q => /L12/.test(q.detail) && /L2/.test(q.detail))).toBe(true);
		expect(drift.some(q => /clanging-vengeance/.test(q.detail))).toBe(true);
	});

	it('level_set always flags', async () => {
		const questions = await buildAndCheck(
			[arcSchema.parse({id: 'arc-01', order: 1})],
			[
				situationSchema.parse({
					id: 'sit-001',
					arc: 'arc-01',
					order: 10,
					events: [{actor: 'carl', type: 'level_set', value: 9}],
				}),
			],
		);

		expect(questions.map(q => q.kind)).toContain('level_set_used');
	});

	it('flags a stat pushed out of its declared range', async () => {
		const questions = await buildAndCheck(
			[arcSchema.parse({id: 'arc-01', order: 1})],
			[
				situationSchema.parse({
					id: 'sit-001',
					arc: 'arc-01',
					order: 10,
					events: [{actor: 'carl', type: 'stat', stat: 'charisma', value: 99}],
				}),
			],
		);

		expect(questions.map(q => q.kind)).toContain('stat_out_of_range');
	});

	it('flags a situation pointing at a nonexistent arc', async () => {
		const questions = await buildAndCheck(
			[arcSchema.parse({id: 'arc-01', order: 1})],
			[situationSchema.parse({id: 'sit-001', arc: 'arc-99', order: 10})],
		);

		expect(questions.map(q => q.kind)).toContain('broken_reference');
	});

	it('produces stable ids across identical runs', async () => {
		const make = async () =>
			buildAndCheck(
				[arcSchema.parse({id: 'arc-01', order: 1})],
				[
					situationSchema.parse({
						id: 'sit-001',
						arc: 'arc-01',
						order: 10,
						events: [{actor: 'carl', type: 'level_set', value: 9}],
					}),
				],
			);

		const first = await make();
		runner?.dispose();
		const second = await make();

		expect(first.map(q => `${q.id}:${q.kind}`)).toEqual(
			second.map(q => `${q.id}:${q.kind}`),
		);
	});
});
