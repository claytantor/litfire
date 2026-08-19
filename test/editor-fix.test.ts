import {describe, expect, it} from 'vitest';
import {runCorrectionPass, type Target} from '../source/editor/index.js';
import type {ChatMessage, Provider} from '../source/llm/index.js';

/**
 * The correction pass is where the guard is actually load-bearing: it is the
 * only thing between a model that decided to improve the prose and a review
 * queue the author is being asked to trust.
 */

function scriptedProvider(reply: string): Provider & {seen: ChatMessage[][]} {
	const seen: ChatMessage[][] = [];
	return {
		id: 'openai',
		model: 'test',
		seen,
		async listModels() {
			return [];
		},
		async *chat(messages) {
			seen.push([...messages]);
			yield reply;
		},
	};
}

const FRONT = '---\nid: sit-901\narc: arc-90\n---\n\n';
const original = `${FRONT}The sword lay were he left it. He owed 40 gold to [[donut]].\n`;

const targets: Target[] = [{path: 'situations/sit-901.md', contents: original}];

const respond = (writes: unknown[], notes: string[] = []) =>
	JSON.stringify({writes, notes});

const run = async (reply: string) =>
	runCorrectionPass(scriptedProvider(reply), targets, '', new AbortController().signal);

describe('the correction pass', () => {
	it('passes a real correction through to review', async () => {
		const corrected = original.replace('were he', 'where he');
		const outcome = await run(
			respond([{path: 'situations/sit-901.md', contents: corrected}]),
		);

		expect(outcome.proposals).toHaveLength(1);
		expect(outcome.refusals).toHaveLength(0);
		expect(outcome.proposals[0]?.contents).toContain('where he left it');
	});

	it('refuses a proposal that rewrites the prose', async () => {
		const rewritten = original.replace(
			'The sword lay were he left it.',
			'The blade rested precisely where he had abandoned it.',
		);
		const outcome = await run(
			respond([{path: 'situations/sit-901.md', contents: rewritten}]),
		);

		expect(outcome.proposals).toHaveLength(0);
		expect(outcome.refusals).toHaveLength(1);
		expect(outcome.refusals[0]?.path).toBe('situations/sit-901.md');
	});

	it('refuses a proposal that changes a number', async () => {
		const outcome = await run(
			respond([
				{path: 'situations/sit-901.md', contents: original.replace('40 gold', '50 gold')},
			]),
		);

		expect(outcome.proposals).toHaveLength(0);
		expect(outcome.refusals[0]?.reason).toContain('a number changed');
	});

	it('refuses a proposal that touches frontmatter', async () => {
		const outcome = await run(
			respond([
				{
					path: 'situations/sit-901.md',
					contents: original.replace('arc: arc-90', 'arc: arc-91'),
				},
			]),
		);

		expect(outcome.proposals).toHaveLength(0);
		expect(outcome.refusals[0]?.reason).toContain('frontmatter changed');
	});

	/** A file nobody offered it is not a correction of anything. */
	it('refuses a path outside the set it was given', async () => {
		const outcome = await run(
			respond([{path: 'system/stats.md', contents: 'anything at all'}]),
		);

		expect(outcome.proposals).toHaveLength(0);
		expect(outcome.refusals[0]?.reason).toContain('not one of the files offered');
	});

	it('keeps the good proposal when only one of two oversteps', async () => {
		const outcome = await run(
			respond([
				{
					path: 'situations/sit-901.md',
					contents: original.replace('were he', 'where he'),
				},
				{path: 'system/stats.md', contents: 'sneaky'},
			]),
		);

		expect(outcome.proposals).toHaveLength(1);
		expect(outcome.refusals).toHaveLength(1);
	});

	it('carries the model’s notes through untouched', async () => {
		const outcome = await run(
			respond([], ['"gonna" in dialogue looks deliberate — left it alone']),
		);

		expect(outcome.notes).toEqual([
			'"gonna" in dialogue looks deliberate — left it alone',
		]);
	});

	it('reports a malformed reply instead of throwing', async () => {
		const outcome = await run('I am thinking about it, but here is no JSON.');

		expect(outcome.error).toBeDefined();
		expect(outcome.proposals).toHaveLength(0);
	});

	it('tells the model what it may not do', async () => {
		const provider = scriptedProvider(respond([]));
		await runCorrectionPass(provider, targets, '', new AbortController().signal);

		const system = provider.seen[0]?.[0]?.content ?? '';
		expect(system).toContain('may not');
		expect(system).toContain('change any number');
	});
});
