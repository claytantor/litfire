import {describe, expect, it} from 'vitest';
import {chapterSchema, situationSchema} from '../source/domain/schema.js';
import {renderManuscript, transitionsIn} from '../source/chapters/manuscript.js';
import type {Partition} from '../source/chapters/partition.js';

const chapter = (id: string, title: string, startsAt: string, order: number) =>
	chapterSchema.parse({id, title, order, starts_at: startsAt});

const situation = (id: string, title: string) =>
	situationSchema.parse({id, title, arc: 'arc-90', order: 10});

const ONE = chapter('ch-901', 'The Ledger Room', 'sit-901', 10);
const TWO = chapter('ch-902', 'Collection', 'sit-903', 20);

const partition: Partition = {
	spans: [
		{
			chapter: ONE,
			steps: [
				{kind: 'situation', id: 'sit-901', arc: 'arc-90'},
				{kind: 'situation', id: 'sit-902', arc: 'arc-90'},
			],
			situations: ['sit-901', 'sit-902'],
		},
		{
			chapter: TWO,
			steps: [{kind: 'situation', id: 'sit-903', arc: 'arc-90'}],
			situations: ['sit-903'],
		},
	],
	unclaimed: [],
	issues: [],
};

const situations = [
	situation('sit-901', 'The Door'),
	situation('sit-902', 'The Ledger'),
	situation('sit-903', 'Collection Day'),
];

const bodies = new Map([
	['sit-901', 'Carl opened the door.'],
	['sit-902', 'The ledger was open to a page he did not like.'],
	['sit-903', 'They came for the debt at dawn.'],
]);

const render = (
	chapterBodies: ReadonlyMap<string, string> = new Map(),
	over: Partial<Parameters<typeof renderManuscript>[0]> = {},
) =>
	renderManuscript({
		partition,
		situations,
		bodies,
		chapterBodies,
		title: 'Inanna',
		...over,
	});

describe('transitionsIn', () => {
	it('reads a transition and the situation it follows', () => {
		const found = transitionsIn(
			'<!-- litrpg:transition after=sit-901 -->\nThree days passed.\n<!-- /litrpg:transition -->',
		);

		expect(found.get('sit-901')).toBe('Three days passed.');
	});

	it('ignores other marker blocks and empty ones', () => {
		expect(
			transitionsIn('<!-- litrpg:status char=carl -->\nlevel 7\n<!-- /litrpg:status -->')
				.size,
		).toBe(0);
		expect(
			transitionsIn(
				'<!-- litrpg:transition after=sit-901 -->\n\n<!-- /litrpg:transition -->',
			).size,
		).toBe(0);
	});
});

describe('renderManuscript', () => {
	it('lays chapters out in order with their scenes inside', () => {
		const out = render();

		expect(out).toContain('# Inanna');
		expect(out).toContain('## 1. The Ledger Room');
		expect(out).toContain('## 2. Collection');
		expect(out.indexOf('Carl opened the door.')).toBeLessThan(
			out.indexOf('They came for the debt at dawn.'),
		);
	});

	/** P6 through assembly: scene prose is copied verbatim, never reworded. */
	it('copies scene prose byte for byte', () => {
		expect(render()).toContain('The ledger was open to a page he did not like.');
	});

	it('places a transition after the scene it names', () => {
		const out = render(
			new Map([
				[
					'ch-901',
					'<!-- litrpg:transition after=sit-901 -->\nThree days passed.\n<!-- /litrpg:transition -->',
				],
			]),
		);

		expect(out.indexOf('Carl opened the door.')).toBeLessThan(
			out.indexOf('Three days passed.'),
		);
		expect(out.indexOf('Three days passed.')).toBeLessThan(
			out.indexOf('The ledger was open'),
		);
	});

	it('marks a placed scene that has no prose yet', () => {
		const out = render(new Map(), {
			bodies: new Map([['sit-901', 'Carl opened the door.']]),
		});

		expect(out).toContain('_[The Ledger — not written yet]_');
	});

	/**
	 * The silent failure assembly exists to prevent: a scene that no chapter
	 * opened early enough to claim must still appear, flagged, not vanish.
	 */
	it('appends unclaimed scenes rather than dropping them', () => {
		const out = render(new Map(), {
			partition: {
				...partition,
				spans: [partition.spans[0]!],
				unclaimed: [{kind: 'situation', id: 'sit-903', arc: 'arc-90'}],
			},
		});

		expect(out).toContain('## Not yet in a chapter');
		expect(out).toContain('They came for the debt at dawn.');
	});

	it('says it is generated, so nobody edits it by hand', () => {
		expect(render()).toContain('Generated file');
	});

	it('titles a chapter by number alone when it has none', () => {
		const out = render(new Map(), {
			partition: {
				...partition,
				spans: [
					{
						...partition.spans[0]!,
						chapter: chapterSchema.parse({id: 'ch-901', order: 10, starts_at: 'sit-901'}),
					},
				],
			},
		});

		expect(out).toContain('## 1\n');
	});
});
