import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	MAX_STUBS,
	buildExtractionMessages,
	buildGrounding,
	extractionSchema,
	planSpillover,
	renderStub,
	stubPath,
	type ProposedStub,
	type SourcedStub,
	type SpilloverContext,
} from '../source/interview/index.js';
import {
	arcSchema,
	characterSchema,
	factionSchema,
	situationSchema,
	themeSchema,
	momentSchema,
} from '../source/domain/schema.js';
import {buildWiki} from '../source/wiki/build.js';
import {computeProject} from '../source/core/project.js';
import {runChecks} from '../source/ledger/checks.js';
import {buildSequence, replay} from '../source/ledger/replay.js';
import {parseDocument} from '../source/vault/frontmatter.js';
import {scaffoldVault} from '../source/vault/scaffold.js';
import {loadVault} from '../source/vault/load.js';
import {VAULT} from '../source/vault/paths.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-spill-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

const TRANSCRIPT = 'system-2026-01-01T00-00-00';

function context(overrides: Partial<SpilloverContext> = {}): SpilloverContext {
	return {root, kind: 'system', ...overrides};
}

/** A stub with its provenance, which is the shape everything downstream takes. */
function stub(
	overrides: Partial<ProposedStub> = {},
	transcriptId = TRANSCRIPT,
): SourcedStub {
	return {
		stub: {
			kind: 'faction',
			id: 'the-assessors',
			name: 'The Assessors',
			note: 'Issue licences to grade. Stopped issuing them after the Quiet Year.',
			members: [],
			...overrides,
		},
		transcriptId,
	};
}

describe('stub routing', () => {
	it('sends each kind to its own domain', () => {
		expect(stubPath('character', 'donut')).toBe('characters/donut.md');
		expect(stubPath('place', 'rust-quarter')).toBe('places/rust-quarter.md');
		expect(stubPath('faction', 'assessors')).toBe('factions/assessors.md');
		expect(stubPath('theme', 'debt')).toBe('themes/debt.md');
		expect(stubPath('arc', 'arc-quiet-year')).toBe('timeline/arcs/arc-quiet-year.md');
		expect(stubPath('moment', 'quiet-year')).toBe('timeline/moments/quiet-year.md');
	});

	it('files a situation stub unplaced, in the inbox', () => {
		expect(stubPath('situation', 'the-audit')).toBe('situations/inbox/the-audit.md');
	});
});

describe('rendered stubs', () => {
	it('marks the page a stub and says where it came from', () => {
		const {data, body} = parseDocument(renderStub(stub(), context()));
		expect(data).toMatchObject({id: 'the-assessors', name: 'The Assessors', stub: true});
		expect(body).toContain('# The Assessors');
		expect(body).toContain('Raised in [[system-2026-01-01T00-00-00]]');
		expect(body).toContain('the system interview');
	});

	it("carries the author's words verbatim when given", () => {
		const rendered = renderStub(stub({quote: 'Nobody grades the graders.'}), context());
		expect(rendered).toContain('> Nobody grades the graders.');
	});

	it('titles a situation rather than naming it', () => {
		const {data} = parseDocument(
			renderStub(
				stub({kind: 'situation', id: 'the-audit', name: 'The Audit'}),
				context(),
			),
		);
		expect(data).toMatchObject({id: 'the-audit', title: 'The Audit', stub: true});
		expect(data['name']).toBeUndefined();
	});

	it('never invents a position', () => {
		const arc = parseDocument(
			renderStub(
				stub({kind: 'arc', id: 'arc-quiet-year', name: 'The Quiet Year'}),
				context(),
			),
		);
		expect(arc.data['order']).toBeUndefined();
		expect(arcSchema.parse(arc.data).order).toBeUndefined();
	});

	it('produces frontmatter every domain schema accepts', () => {
		const parse = (kind: ProposedStub['kind']) =>
			parseDocument(renderStub(stub({kind, id: 'x-one', name: 'X One'}), context())).data;

		expect(() => characterSchema.parse(parse('character'))).not.toThrow();
		expect(() => themeSchema.parse(parse('theme'))).not.toThrow();
		expect(() => situationSchema.parse(parse('situation'))).not.toThrow();
		expect(() => arcSchema.parse(parse('arc'))).not.toThrow();
	});
});

describe('planning', () => {
	it('turns a stub into a low-confidence proposal at the right path', async () => {
		const plan = await planSpillover([stub()], context());
		expect(plan.proposals).toHaveLength(1);
		expect(plan.proposals[0]?.path).toBe('factions/the-assessors.md');
		expect(plan.proposals[0]?.confidence).toBe('low');
		expect(plan.proposals[0]?.rationale).toContain('system interview');
	});

	it('never overwrites a page the author already has', async () => {
		await mkdir(path.join(root, VAULT.characters), {recursive: true});
		await writeFile(
			path.join(root, VAULT.characters, 'donut.md'),
			'---\nid: donut\n---\n\nEverything the author wrote.\n',
			'utf8',
		);

		const plan = await planSpillover(
			[stub({kind: 'character', id: 'donut', name: 'Donut'})],
			context(),
		);

		expect(plan.proposals).toHaveLength(0);
		expect(plan.dropped[0]?.reason).toBe('the page already exists');
	});

	it('stands down when the extraction already proposes that page', async () => {
		const plan = await planSpillover(
			[stub({kind: 'theme', id: 'debt', name: 'Debt'})],
			context({taken: ['themes/debt.md']}),
		);
		expect(plan.proposals).toHaveLength(0);
		expect(plan.dropped[0]?.reason).toContain('already proposes');
	});

	it('collapses a stub proposed twice', async () => {
		const plan = await planSpillover([stub(), stub()], context());
		expect(plan.proposals).toHaveLength(1);
		expect(plan.dropped[0]?.reason).toBe('already raised by an earlier transcript');
	});

	it('caps one interview and reports what it refused', async () => {
		const many = Array.from({length: MAX_STUBS + 3}, (_, index) =>
			stub({id: `faction-${String(index)}`, name: `Faction ${String(index)}`}),
		);
		const plan = await planSpillover(many, context());

		expect(plan.proposals).toHaveLength(MAX_STUBS);
		expect(plan.dropped).toHaveLength(3);
		expect(plan.dropped[0]?.reason).toContain('cap');
	});
});

const event = (id: string, name: string, transcriptId = TRANSCRIPT): SourcedStub =>
	stub({kind: 'moment', id, name}, transcriptId);

describe('moments', () => {
	it('proposes a page per moment, not rows in one file', async () => {
		const plan = await planSpillover(
			[event('quiet-year', 'The Quiet Year'), event('the-recall', 'The Recall')],
			context(),
		);

		expect(plan.proposals.map(p => p.path).toSorted()).toEqual([
			'timeline/moments/quiet-year.md',
			'timeline/moments/the-recall.md',
		]);
		const {data} = parseDocument(plan.proposals[0]?.contents ?? '');
		expect(data).toMatchObject({id: 'quiet-year', stub: true});
		// A stub never invents a position on the clock.
		expect(data['at']).toBeUndefined();
	});

	it('stands down when the moment already has a page', async () => {
		await mkdir(path.join(root, VAULT.moments), {recursive: true});
		await writeFile(
			path.join(root, VAULT.moments, 'quiet-year.md'),
			'---\nid: quiet-year\nat: 40\n---\n\nEverything the author wrote.\n',
			'utf8',
		);

		const plan = await planSpillover([event('quiet-year', 'The Quiet Year')], context());
		expect(plan.proposals).toHaveLength(0);
		expect(plan.dropped[0]?.reason).toBe('the page already exists');
	});
});

describe('unplaced corpus reaches the ledger as a question, not a crash', () => {
	it('loads an undated event and an unordered arc without an issue', async () => {
		await scaffoldVault(root);
		await mkdir(path.join(root, VAULT.moments), {recursive: true});
		await writeFile(
			path.join(root, VAULT.moments, 'quiet-year.md'),
			'---\nid: quiet-year\nname: The Quiet Year\nstub: true\n---\n\n# The Quiet Year\n',
			'utf8',
		);
		await writeFile(
			path.join(root, VAULT.arcs, 'arc-quiet-year.md'),
			'---\nid: arc-quiet-year\nname: The Quiet Year\nstub: true\n---\n\n# The Quiet Year\n',
			'utf8',
		);

		const vault = await loadVault(root);
		expect(vault.issues).toEqual([]);
		expect(vault.moments.find(e => e.id === 'quiet-year')?.at).toBeUndefined();
		expect(vault.arcs.find(a => a.id === 'arc-quiet-year')?.order).toBeUndefined();
	});

	it('leaves an undated event out of the sequence rather than guessing', () => {
		const events = [
			momentSchema.parse({id: 'dated', name: 'Dated', at: 10}),
			momentSchema.parse({id: 'undated', name: 'Undated'}),
		];
		const sequence = buildSequence(events, [], []);
		expect(sequence.map(step => step.id)).toEqual(['dated']);
	});

	it('replays an unordered arc last', () => {
		const arcs = [
			arcSchema.parse({id: 'arc-late', name: 'Late'}),
			arcSchema.parse({id: 'arc-01', name: 'First', order: 1}),
		];
		const situations = [
			situationSchema.parse({id: 'sit-a', arc: 'arc-01', order: 1}),
			situationSchema.parse({id: 'sit-b', arc: 'arc-late', order: 1}),
		];
		expect(buildSequence([], arcs, situations).map(step => step.id)).toEqual([
			'sit-a',
			'sit-b',
		]);
	});

	it('asks the author to place what it could not sequence', async () => {
		const events = [momentSchema.parse({id: 'quiet-year', name: 'The Quiet Year'})];
		const arcs = [arcSchema.parse({id: 'arc-quiet-year', name: 'The Quiet Year'})];
		const replayResult = await replay({
			systems: [
				{
					id: 'system',
					stats: [],
					skills: [],
					curves: {xp_for_level: 'xp-for-level', max_level: 100},
					stub: false,
				},
			],
			moments: events,
			arcs,
			situations: [],
			characters: [],
			formulas: undefined,
		});

		const questions = runChecks({
			systems: [
				{
					id: 'system',
					stats: [],
					skills: [],
					curves: {xp_for_level: 'xp-for-level', max_level: 100},
					stub: false,
				},
			],
			arcs,
			moments: events,
			situations: [],
			characters: [],
			factions: [],
			artifacts: [],
			themes: [],
			replay: replayResult,
			formulas: undefined,
		});

		expect(questions.map(question => question.kind)).toEqual(
			expect.arrayContaining(['moment_undated', 'arc_unordered']),
		);
	});
});

describe('factions reach the corpus', () => {
	beforeEach(async () => {
		await scaffoldVault(root);
	});

	async function writeFaction(): Promise<void> {
		const plan = await planSpillover([stub()], context());
		await writeFile(
			path.join(root, plan.proposals[0]?.path ?? ''),
			plan.proposals[0]?.contents ?? '',
			'utf8',
		);
	}

	it('lands where the wiki builder already publishes from', async () => {
		await writeFaction();
		const page = await readFile(path.join(root, 'factions/the-assessors.md'), 'utf8');
		expect(page).toContain('The Assessors');
	});

	it('comes back to every interview, so the next one builds instead of re-asking', async () => {
		await writeFaction();

		for (const kind of ['system', 'timeline', 'character', 'themes'] as const) {
			const grounding = await buildGrounding(root, kind);
			expect(grounding, kind).toContain('factions/the-assessors.md');
			expect(grounding, kind).toContain('The Assessors');
		}
	});

	it('was invisible to grounding before it was asked for', async () => {
		// Guards the regression directly: a faction nobody reads back gets
		// re-raised, dropped as an existing page, and silently re-asked forever.
		const empty = await buildGrounding(root, 'system');
		expect(empty).not.toContain('factions/');
	});
});

describe('factions as a typed primitive', () => {
	it('carries goal and members into frontmatter, and nothing it was not given', () => {
		const withBoth = parseDocument(
			renderStub(
				stub({goal: 'Keep the licence monopoly', members: ['carl', 'donut']}),
				context(),
			),
		).data;
		expect(factionSchema.parse(withBoth)).toMatchObject({
			id: 'the-assessors',
			goal: 'Keep the licence monopoly',
			members: ['carl', 'donut'],
			stub: true,
		});

		// The normal stub case: the group exists, nobody has said what it wants.
		const bare = parseDocument(renderStub(stub(), context())).data;
		expect(bare['goal']).toBeUndefined();
		expect(bare['members']).toBeUndefined();
		expect(factionSchema.parse(bare).members).toEqual([]);
	});

	it('loads from the vault as a typed record', async () => {
		await scaffoldVault(root);
		await writeFile(
			path.join(root, VAULT.factions, 'the-assessors.md'),
			renderStub(stub({goal: 'Grade everyone', members: ['carl']}), context()),
			'utf8',
		);

		const vault = await loadVault(root);
		expect(vault.issues).toEqual([]);
		expect(vault.factions).toHaveLength(1);
		expect(vault.factions[0]).toMatchObject({
			id: 'the-assessors',
			goal: 'Grade everyone',
			members: ['carl'],
		});
	});

	it('asks what a faction wants, and reports a member nobody wrote down', async () => {
		await scaffoldVault(root);
		await writeFile(
			path.join(root, VAULT.factions, 'the-assessors.md'),
			renderStub(stub({members: ['nobody-wrote-this-one']}), context()),
			'utf8',
		);

		const project = await computeProject(root);
		const kinds = project.questions.map(question => question.kind);
		expect(kinds).toContain('faction_goal_unknown');

		const broken = project.questions.find(
			question => question.actor === 'nobody-wrote-this-one',
		);
		expect(broken?.kind).toBe('broken_reference');
		expect(broken?.detail).toContain('has no character page');
	});

	it('publishes a wiki page that links its members', async () => {
		await scaffoldVault(root);
		await writeFile(
			path.join(root, VAULT.factions, 'the-assessors.md'),
			renderStub(
				stub({goal: 'Grade everyone', members: ['protagonist', 'ghost']}),
				context(),
			),
			'utf8',
		);

		const wiki = buildWiki(await computeProject(root));
		const page = wiki.pages.find(candidate => candidate.id === 'the-assessors');

		expect(page?.path).toBe('wiki/factions/the-assessors.md');
		expect(page?.summary).toBe('Grade everyone');
		expect(page?.body).toContain('- [[protagonist]]');
		// A member with no page still renders, and says so rather than vanishing.
		expect(page?.body).toContain('- [[ghost]] _(no character page)_');
	});
});

describe('sweeping several transcripts', () => {
	it('credits the transcript that actually raised each stub', async () => {
		const plan = await planSpillover(
			[
				stub({kind: 'faction', id: 'the-assessors'}, 'system-2026-01-01T00-00-00'),
				stub(
					{kind: 'place', id: 'rust-quarter', name: 'Rust Quarter'},
					'system-2026-06-01T00-00-00',
				),
			],
			context(),
		);

		const byPath = new Map(plan.proposals.map(p => [p.path, p.contents]));
		expect(byPath.get('factions/the-assessors.md')).toContain(
			'[[system-2026-01-01T00-00-00]]',
		);
		expect(byPath.get('places/rust-quarter.md')).toContain(
			'[[system-2026-06-01T00-00-00]]',
		);
	});

	it('gives a repeated mention to the transcript that introduced it', async () => {
		const plan = await planSpillover(
			[stub({}, 'system-2026-01-01T00-00-00'), stub({}, 'system-2026-06-01T00-00-00')],
			context(),
		);

		expect(plan.proposals).toHaveLength(1);
		expect(plan.proposals[0]?.contents).toContain('[[system-2026-01-01T00-00-00]]');
		expect(plan.dropped[0]?.transcriptId).toBe('system-2026-06-01T00-00-00');
		expect(plan.dropped[0]?.reason).toBe('already raised by an earlier transcript');
	});

	it('credits each moment to the transcript that raised it', async () => {
		const plan = await planSpillover(
			[
				event('quiet-year', 'The Quiet Year', 'system-2026-01-01T00-00-00'),
				event('the-recall', 'The Recall', 'system-2026-06-01T00-00-00'),
			],
			context(),
		);

		const byPath = new Map(plan.proposals.map(p => [p.path, p.contents]));
		expect(byPath.get('timeline/moments/quiet-year.md')).toContain(
			'[[system-2026-01-01T00-00-00]]',
		);
		expect(byPath.get('timeline/moments/the-recall.md')).toContain(
			'[[system-2026-06-01T00-00-00]]',
		);
	});
});

describe('the extraction contract', () => {
	it('briefs the model on spillover and its kinds', () => {
		const messages = buildExtractionMessages(
			{
				id: 't-1',
				kind: 'system',
				startedAt: '2026-01-01T00:00:00.000Z',
				status: 'complete',
				exchanges: [{question: 'Who grades?', answer: 'The Assessors.'}],
			},
			'',
		);

		const persona = messages[0]?.content ?? '';
		expect(persona).toContain('## Spillover');
		expect(persona).toContain('Never invent a position');
		// The author's own definition: a faction is what it is working toward.
		expect(persona).toContain('people who act together toward a goal or an ideology');
		expect(persona).toContain('Omit it rather than paraphrase an implication');
		expect(messages[1]?.content).toContain('"stubs"');
	});

	it('parses stubs, and tolerates a model that emits none', () => {
		const withStubs = extractionSchema.parse({
			writes: [],
			stubs: [
				{
					kind: 'faction',
					id: 'the-assessors',
					name: 'The Assessors',
					note: 'They grade.',
				},
			],
		});
		expect(withStubs.stubs[0]?.kind).toBe('faction');
		expect(extractionSchema.parse({writes: []}).stubs).toEqual([]);
	});
});
