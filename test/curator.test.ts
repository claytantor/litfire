import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	CURATOR_PERSONA,
	CuratorSession,
	buildPlanMessages,
	buildRawContext,
	renderRawContext,
	runPlan,
} from '../source/curator/index.js';
import {computeProject} from '../source/core/project.js';
import type {ChatMessage, Provider} from '../source/llm/index.js';
import {saveTranscript} from '../source/interview/index.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-arch-'));
	await scaffoldVault(root);
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

/** Replies from a script, and records what it was asked. */
function scripted(replies: string[]): Provider & {seen: ChatMessage[][]} {
	const seen: ChatMessage[][] = [];
	let turn = 0;
	return {
		id: 'openai',
		model: 'test',
		seen,
		async listModels() {
			return [];
		},
		async *chat(messages) {
			seen.push([...messages]);
			yield replies[turn++] ?? '';
		},
	};
}

async function transcript(id: string, kind: 'system' | 'moment', answer: string) {
	await saveTranscript(root, {
		id,
		kind,
		startedAt: `2026-08-1${id.length % 9}T00:00:00.000Z`,
		status: 'complete',
		exchanges: [{question: 'What is it?', answer}],
	});
}

describe('what the curator can see of raw/', () => {
	it('always inventories every transcript', async () => {
		await transcript('system-a', 'system', 'The Seed and the Custodian.');
		await transcript('moment-b', 'moment', 'It starts with the patch.');

		const rendered = renderRawContext(await buildRawContext(root, 'anything'));
		expect(rendered).toContain('`system-a`');
		expect(rendered).toContain('`moment-b`');
	});

	it('ships the full text of a transcript the question names', async () => {
		await transcript('system-a', 'system', 'The Seed and the Custodian.');
		await transcript('moment-b', 'moment', 'It starts with the patch.');

		const rendered = renderRawContext(
			await buildRawContext(root, 'what did system-a establish?'),
		);
		expect(rendered).toContain('The Seed and the Custodian.');
		// The other one is inventoried but not shipped — a vault of 45KB interviews
		// would otherwise spend its whole context on material nobody asked about.
		expect(rendered).not.toContain('It starts with the patch.');
	});

	it('falls back to the most recent when nothing is named', async () => {
		await transcript('system-a', 'system', 'The Seed and the Custodian.');
		const rendered = renderRawContext(await buildRawContext(root, 'hello'));
		expect(rendered).toContain('The Seed and the Custodian.');
	});

	it('says so plainly when there are no interviews', async () => {
		expect(renderRawContext(await buildRawContext(root, 'x'))).toContain(
			'No interviews recorded yet',
		);
	});
});

describe('the conversation', () => {
	it('grounds on the corpus and the raw material at once', async () => {
		await transcript('system-a', 'system', 'The Seed and the Custodian.');
		const provider = scripted(['Two systems, by the sound of it.']);
		const session = new CuratorSession({
			root,
			project: await computeProject(root),
			provider,
			register: '',
		});

		let reply = '';
		for await (const delta of session.ask(
			'did system-a establish two systems?',
			new AbortController().signal,
		)) {
			reply += delta;
		}

		expect(reply).toBe('Two systems, by the sound of it.');
		const system = provider.seen[0]?.[0]?.content ?? '';
		// Both halves: /reviewer sees only the corpus, extraction sees only the
		// transcript, and the questions worth asking here need both.
		expect(system).toContain('# The corpus');
		expect(system).toContain('# The raw material');
		expect(system).toContain('The Seed and the Custodian.');
		expect(session.turns).toHaveLength(2);
	});

	it('keeps the question when a reply never arrives', async () => {
		const session = new CuratorSession({
			root,
			project: await computeProject(root),
			provider: scripted([]),
			register: '',
		});
		session.recordFailure('what happened?', 'stream died');

		expect(session.turns.map(t => t.text)).toEqual(['what happened?', 'stream died']);
	});
});

describe('the structural pass', () => {
	const plan = async (reply: string) =>
		runPlan(
			scripted([reply]),
			root,
			'split the lathe in two',
			'# The corpus\n\n(map)',
			'',
			new AbortController().signal,
		);

	it('turns writes into proposals for the review gate', async () => {
		const outcome = await plan(
			JSON.stringify({
				writes: [
					{
						path: 'systems/the-seed.md',
						contents: '---\nid: the-seed\nname: The Seed\n---\n\n# The Seed\n',
						rationale: 'the interview established two apparatuses',
					},
				],
				notes: [],
			}),
		);

		expect(outcome.error).toBeUndefined();
		expect(outcome.proposals).toHaveLength(1);
		expect(outcome.proposals[0]?.path).toBe('systems/the-seed.md');
		expect(outcome.proposals[0]?.rationale).toContain('two apparatuses');
	});

	/**
	 * The curator is the one agent that may propose changes to `raw/`, on the
	 * author's instruction and still only as a diff they accept (D15).
	 * Reconciling a corpus sometimes means correcting the material it was drawn
	 * from, and it had no way to say so.
	 */
	it('may propose a change to raw/, since the author pointed it there', async () => {
		const outcome = await plan(
			JSON.stringify({
				writes: [
					{path: 'raw/interviews/system-a.md', contents: 'corrected transcript'},
					{path: 'systems/the-seed.md', contents: '---\nid: the-seed\n---\n\n# x\n'},
				],
			}),
		);

		expect(outcome.proposals.map(p => p.path)).toEqual([
			'raw/interviews/system-a.md',
			'systems/the-seed.md',
		]);
		expect(outcome.refusals).toHaveLength(0);
	});

	it('refuses the other derived directories too', async () => {
		for (const bad of ['wiki/index.md', 'ledger/state.md', '.litrpg/config.json']) {
			const outcome = await plan(JSON.stringify({writes: [{path: bad, contents: 'x'}]}));
			expect(outcome.proposals, bad).toHaveLength(0);
			expect(outcome.refusals, bad).toHaveLength(1);
		}
	});

	it('carries notes through, including what it could not do', async () => {
		const outcome = await plan(
			JSON.stringify({
				writes: [],
				notes: ['systems/the-lathe.md should be deleted; I cannot delete files.'],
			}),
		);
		expect(outcome.notes[0]).toContain('cannot delete');
		expect(outcome.proposals).toHaveLength(0);
	});

	it('reports a reply that is not usable JSON instead of throwing', async () => {
		const outcome = await plan('I would rather explain it in prose.');
		expect(outcome.error).toBeDefined();
		expect(outcome.proposals).toHaveLength(0);
	});
});

describe('the brief', () => {
	it('names every primitive the tool actually has', () => {
		for (const primitive of [
			'systems/<id>.md',
			'characters/<id>.md',
			'timeline/moments/<id>.md',
			'timeline/arcs/<id>.md',
			'situations/<id>.md',
			'factions/<id>.md',
			'artifacts/<id>.md',
			'themes/<id>.md',
		]) {
			expect(CURATOR_PERSONA).toContain(primitive);
		}
	});

	it('forbids the derived directories in the brief, not just in code', () => {
		// Belt and braces: the path check is what enforces it, but a model told
		// the rule proposes fewer writes that have to be thrown away.
		expect(CURATOR_PERSONA).toContain('derived and regenerated');
		expect(CURATOR_PERSONA).toContain('Never resolve a contradiction');
	});

	it('states the higher bar for raw, rather than forbidding it outright', () => {
		expect(CURATOR_PERSONA).toContain("author's own record");
		expect(CURATOR_PERSONA).toContain('never rewrite what the author said');
	});

	/**
	 * A reply reaches no disk, and an curator that pastes a finished page into
	 * one leaves the author believing a change landed when it did not. It has to
	 * know how a proposal is actually made.
	 */
	it('knows a reply writes nothing, and how to propose instead', () => {
		expect(CURATOR_PERSONA).toContain('Nothing you write in a reply reaches disk');
		expect(CURATOR_PERSONA).toContain('PLAN:');
	});

	/**
	 * The author had been asked to retype the curator's own conclusion — five
	 * timestamps it had just computed — as a command. That is where a digit gets
	 * dropped, and the gate is what makes a change safe regardless.
	 */
	it('is told not to make the author type the plan', () => {
		expect(CURATOR_PERSONA).toContain('Do not ask the author to type the plan');
	});

	it('asks the plan for whole files, since a write replaces what is there', () => {
		const messages = buildPlanMessages('split it', '# The corpus', '');
		expect(messages[0]?.content).toContain('complete file contents');
		expect(messages[1]?.content).toContain('"writes"');
		expect(messages[1]?.content).toContain('split it');
	});
});

/**
 * A screen that cannot resolve produces a weak stats model, and the author
 * usually cannot see why — the placeholders look fine, they just render as
 * themselves. The curator is the one pass that reads raw and corpus together,
 * so it is where that feedback belongs.
 */
describe('the curator on status screens', () => {
	const prompt = CURATOR_PERSONA;

	it('knows a system can carry one', () => {
		expect(prompt).toContain('interface');
	});

	it('names the three failures that actually happen', () => {
		expect(prompt).toContain('A placeholder for text rather than a number');
		expect(prompt).toContain('A placeholder for a bound');
		expect(prompt).toContain('really a derived stat');
	});

	it('says to tell the author rather than rewrite the drawing', () => {
		// The author lined it up by hand and what it should say is theirs.
		expect(prompt).toContain('Do not silently rewrite a screen');
	});

	it('says what a good screen looks like, not only what is wrong', () => {
		expect(prompt).toContain('The good outcome');
		expect(prompt).toContain('{skills}');
	});
});
