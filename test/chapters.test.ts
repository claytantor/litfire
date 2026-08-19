import {describe, expect, it} from 'vitest';
import {
	arcSchema,
	chapterSchema,
	situationSchema,
	momentSchema,
} from '../source/domain/schema.js';
import {findSeams, partitionChapters} from '../source/chapters/index.js';
import {buildSequence} from '../source/ledger/replay.js';

describe('partitionChapters', () => {
	it('claims every situation exactly once across two chapters', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'sit-002', arc: 'arc-01', order: 20}),
			situationSchema.parse({id: 'sit-003', arc: 'arc-01', order: 30}),
			situationSchema.parse({id: 'sit-004', arc: 'arc-01', order: 40}),
		];
		const chapters = [
			chapterSchema.parse({id: 'ch-01', order: 1, starts_at: 'sit-001'}),
			chapterSchema.parse({id: 'ch-02', order: 2, starts_at: 'sit-003'}),
		];

		const partition = partitionChapters(chapters, buildSequence([], arcs, situations));

		expect(partition.issues).toHaveLength(0);
		expect(partition.spans.map(span => span.situations)).toEqual([
			['sit-001', 'sit-002'],
			['sit-003', 'sit-004'],
		]);

		const claimed = partition.spans.flatMap(span => span.situations);
		expect(claimed).toEqual(situations.map(s => s.id));
		expect(new Set(claimed).size).toBe(claimed.length);
	});

	// The whole reason for the cut-point design: a chapter names a situation
	// id, not a list, so inserting a scene mid-arc never touches a chapter file.
	it('moves a situation inserted mid-arc into the right chapter without any chapter file changing', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const chapters = [
			chapterSchema.parse({id: 'ch-01', order: 1, starts_at: 'sit-001'}),
			chapterSchema.parse({id: 'ch-02', order: 2, starts_at: 'sit-003'}),
		];

		const before = [
			situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'sit-002', arc: 'arc-01', order: 20}),
			situationSchema.parse({id: 'sit-003', arc: 'arc-01', order: 30}),
		];
		const beforePartition = partitionChapters(chapters, buildSequence([], arcs, before));

		// Same two chapter files, unchanged — only a new situation appears.
		const after = [
			situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'sit-001b', arc: 'arc-01', order: 15}),
			situationSchema.parse({id: 'sit-002', arc: 'arc-01', order: 20}),
			situationSchema.parse({id: 'sit-003', arc: 'arc-01', order: 30}),
		];
		const afterPartition = partitionChapters(chapters, buildSequence([], arcs, after));

		expect(beforePartition.spans[0]?.situations).toEqual(['sit-001', 'sit-002']);
		expect(afterPartition.spans[0]?.situations).toEqual([
			'sit-001',
			'sit-001b',
			'sit-002',
		]);
		expect(afterPartition.spans[1]?.situations).toEqual(['sit-003']);
		expect(afterPartition.issues).toHaveLength(0);
	});

	it('puts steps before the first chapter opens into unclaimed', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({id: 'sit-000', arc: 'arc-01', order: 5}),
			situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10}),
		];
		const chapters = [chapterSchema.parse({id: 'ch-01', order: 1, starts_at: 'sit-001'})];

		const partition = partitionChapters(chapters, buildSequence([], arcs, situations));

		expect(partition.unclaimed.map(step => step.id)).toEqual(['sit-000']);
		expect(partition.spans[0]?.situations).toEqual(['sit-001']);
	});

	it('flags a starts_at absent from the sequence and contributes no span, without throwing', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10})];
		const chapters = [chapterSchema.parse({id: 'ch-01', order: 1, starts_at: 'sit-999'})];
		const sequence = buildSequence([], arcs, situations);

		expect(() => partitionChapters(chapters, sequence)).not.toThrow();
		const partition = partitionChapters(chapters, sequence);

		expect(partition.issues).toEqual([
			{
				kind: 'unknown-start',
				chapter: 'ch-01',
				detail: expect.stringContaining('sit-999'),
			},
		]);
		expect(partition.spans).toHaveLength(0);
		expect(partition.unclaimed).toEqual(sequence);
	});

	it('flags two chapters that share a starts_at, without throwing', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'sit-002', arc: 'arc-01', order: 20}),
		];
		const chapters = [
			chapterSchema.parse({id: 'ch-01', order: 1, starts_at: 'sit-001'}),
			chapterSchema.parse({id: 'ch-02', order: 2, starts_at: 'sit-001'}),
		];
		const sequence = buildSequence([], arcs, situations);

		expect(() => partitionChapters(chapters, sequence)).not.toThrow();
		const partition = partitionChapters(chapters, sequence);

		const duplicate = partition.issues.find(issue => issue.kind === 'duplicate-start');
		expect(duplicate?.chapter).toBe('ch-02');
		expect(duplicate?.detail).toContain('ch-01');
	});

	it('flags a chapter whose declared order disagrees with the sequence, and the resulting empty span, without throwing', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'sit-002', arc: 'arc-01', order: 20}),
		];
		// ch-01 is declared first but opens on the situation that comes later —
		// ch-02 (declared second) opens earlier in the sequence.
		const chapters = [
			chapterSchema.parse({id: 'ch-01', order: 1, starts_at: 'sit-002'}),
			chapterSchema.parse({id: 'ch-02', order: 2, starts_at: 'sit-001'}),
		];
		const sequence = buildSequence([], arcs, situations);

		expect(() => partitionChapters(chapters, sequence)).not.toThrow();
		const partition = partitionChapters(chapters, sequence);

		const outOfOrder = partition.issues.find(issue => issue.kind === 'out-of-order');
		expect(outOfOrder?.chapter).toBe('ch-01');

		// ch-01's boundary never runs backward past ch-02's start, so it collapses.
		const empty = partition.issues.find(issue => issue.kind === 'empty');
		expect(empty?.chapter).toBe('ch-01');
		expect(partition.spans.find(span => span.chapter.id === 'ch-01')?.situations).toEqual(
			[],
		);
	});

	it('claims everything as unclaimed and raises no issues with no chapters at all', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10})];
		const sequence = buildSequence([], arcs, situations);

		expect(() => partitionChapters([], sequence)).not.toThrow();
		const partition = partitionChapters([], sequence);

		expect(partition.spans).toHaveLength(0);
		expect(partition.issues).toHaveLength(0);
		expect(partition.unclaimed).toEqual(sequence);
	});
});

describe('findSeams', () => {
	it('reports an elapsed seam when a world event falls between two situations', () => {
		// arc-02 anchors on we-001, which is what makes buildSequence interleave
		// it between the two situations instead of appending it at the end.
		const arcs = [
			arcSchema.parse({id: 'arc-01', order: 1}),
			arcSchema.parse({id: 'arc-02', order: 2, starts_after: 'we-001'}),
		];
		const moments = [momentSchema.parse({id: 'we-001', at: 15})];
		const situations = [
			situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'sit-002', arc: 'arc-02', order: 10}),
		];
		const sequence = buildSequence(moments, arcs, situations);

		const seams = findSeams(sequence, situations, []);

		const elapsed = seams.filter(seam => seam.kind === 'elapsed');
		expect(elapsed).toHaveLength(1);
		expect(elapsed[0]?.from).toBe('sit-001');
		expect(elapsed[0]?.to).toBe('sit-002');
		expect(elapsed[0]?.detail).toContain('we-001');
	});

	it('reports a place seam and a cast seam, letting one pair produce both at once', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({
				id: 'sit-001',
				arc: 'arc-01',
				order: 10,
				place: 'docking-bay',
				characters: ['carl', 'donut'],
			}),
			situationSchema.parse({
				id: 'sit-002',
				arc: 'arc-01',
				order: 20,
				place: 'the-warrens',
				characters: ['carl', 'mongo'],
			}),
		];
		const sequence = buildSequence([], arcs, situations);

		const seams = findSeams(sequence, situations, []);

		expect(seams.map(seam => seam.kind).toSorted()).toEqual(['cast', 'place']);

		const place = seams.find(seam => seam.kind === 'place');
		expect(place?.detail).toContain('docking-bay');
		expect(place?.detail).toContain('the-warrens');

		const cast = seams.find(seam => seam.kind === 'cast');
		expect(cast?.detail).toContain('mongo');
		expect(cast?.detail).toContain('donut');
	});

	it('names who entered and who left in the cast seam detail', () => {
		const arcs = [arcSchema.parse({id: 'arc-01', order: 1})];
		const situations = [
			situationSchema.parse({
				id: 'sit-001',
				arc: 'arc-01',
				order: 10,
				characters: ['carl', 'donut'],
			}),
			situationSchema.parse({
				id: 'sit-002',
				arc: 'arc-01',
				order: 20,
				characters: ['carl', 'mongo'],
			}),
		];
		const sequence = buildSequence([], arcs, situations);

		const seams = findSeams(sequence, situations, []);
		const cast = seams.find(seam => seam.kind === 'cast');

		expect(cast?.detail).toContain('mongo enters');
		expect(cast?.detail).toContain('donut leaves');
	});

	it('reports a chapter seam and an arc seam for a pair that crosses both', () => {
		const arcs = [
			arcSchema.parse({id: 'arc-01', order: 1}),
			arcSchema.parse({id: 'arc-02', order: 2}),
		];
		const situations = [
			situationSchema.parse({id: 'sit-001', arc: 'arc-01', order: 10}),
			situationSchema.parse({id: 'sit-002', arc: 'arc-02', order: 10}),
		];
		const chapters = [chapterSchema.parse({id: 'ch-02', order: 2, starts_at: 'sit-002'})];
		const sequence = buildSequence([], arcs, situations);

		const seams = findSeams(sequence, situations, chapters);

		expect(seams.map(seam => seam.kind).toSorted()).toEqual(['arc', 'chapter']);
	});
});
