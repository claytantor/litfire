import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {CuratorSession} from '../source/curator/session.js';
import {
	MAX_BYTES,
	openFiles,
	parsePlan,
	parseRequest,
	renderOpened,
	resolveReadable,
} from '../source/curator/open.js';
import {computeProject} from '../source/core/project.js';
import type {ChatMessage, Provider} from '../source/llm/index.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-open-'));
	await scaffoldVault(root, 'arcane');
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function write(relative: string, contents: string) {
	const file = path.join(root, relative);
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, contents, 'utf8');
}

describe('asking for a file', () => {
	it('reads a READ line, however it is punctuated', () => {
		expect(parseRequest('READ: a.md, b.md')).toEqual(['a.md', 'b.md']);
		expect(parseRequest('read: `a.md`')).toEqual(['a.md']);
		expect(parseRequest('READ: a.md, a.md')).toEqual(['a.md']);
	});

	/**
	 * The reported failure, verbatim in shape: the model explains itself first
	 * and the request is nowhere near the start of the reply. A prefix test
	 * missed it entirely, so the line reached the screen and nothing opened.
	 */
	it('finds a request that follows a paragraph of reasoning', () => {
		const reply = [
			'Before I propose the merge, I want to pin provenance — the surviving',
			'page should carry a "Raised in" link to the interview that produced it.',
			'',
			'READ: raw/interviews/timeline-2026-08-19T08-51-59.md',
		].join('\n');

		expect(parseRequest(reply)).toEqual([
			'raw/interviews/timeline-2026-08-19T08-51-59.md',
		]);
	});

	it('collects a request that wraps onto the next line', () => {
		const reply = [
			'Not yet — I still have not read either moment file.',
			'',
			'READ: timeline/moments/inannas-first-memory.md, timeline/moments/the-first-memory.md,',
			' raw/interviews/timeline-2026-08-19T08-51-59.md, raw/interviews/timeline-2026-08-19T09-19-46.md',
		].join('\n');

		expect(parseRequest(reply)).toEqual([
			'timeline/moments/inannas-first-memory.md',
			'timeline/moments/the-first-memory.md',
			'raw/interviews/timeline-2026-08-19T08-51-59.md',
			'raw/interviews/timeline-2026-08-19T09-19-46.md',
		]);
	});

	it('caps how many one request may open', () => {
		const many = Array.from({length: 20}, (_unused, i) => `p${String(i)}.md`).join(', ');
		expect(parseRequest(`READ: ${many}`)).toHaveLength(6);
	});

	it('is not confused by an ordinary answer', () => {
		expect(parseRequest('I would read characters/inanna.md first.')).toBeUndefined();
		expect(parseRequest('')).toBeUndefined();
		// A READ with no path is not a request it can act on.
		expect(parseRequest('READ: nothing in particular')).toBeUndefined();
	});
});

describe('what may be opened', () => {
	/**
	 * Deliberately unlike `resolveInsideVault`, which forbids `raw/` because the
	 * tool never *writes* there. Reading it is the whole point of `/curator`.
	 */
	it('allows the author’s raw material', () => {
		expect(() => resolveReadable(root, 'raw/interview-001.md')).not.toThrow();
	});

	it('refuses anything outside the vault, or not markdown', () => {
		for (const bad of [
			'../escape.md',
			'/etc/passwd',
			'.litrpg/state.md',
			'notes.txt',
			'',
		]) {
			expect(() => resolveReadable(root, bad)).toThrow();
		}
	});

	it('opens what exists and says why it did not open the rest', async () => {
		await write('characters/inanna.md', '---\nid: inanna\n---\n\nShe lied.\n');

		const opened = await openFiles(root, ['characters/inanna.md', 'characters/ghost.md']);

		expect(opened.paths).toEqual(['characters/inanna.md']);
		expect(opened.blocks[0]).toContain('She lied.');
		expect(opened.refusals[0]).toContain('ghost.md');
		expect(opened.refusals[0]).toContain('does not exist');
	});

	it('marks a file it had to truncate, so it is never rewritten from a clipped copy', async () => {
		await write('characters/long.md', 'x'.repeat(MAX_BYTES + 5_000));

		const opened = await openFiles(root, ['characters/long.md']);

		expect(opened.blocks[0]).toContain('truncated');
		expect(opened.blocks[0]).toContain('do not rewrite');
	});

	it('hands refusals back to the curator rather than dropping them', () => {
		const rendered = renderOpened({
			blocks: [],
			paths: [],
			refusals: ["'x.md' does not exist"],
		});
		expect(rendered).toContain('Not opened');
		expect(rendered).toContain('does not exist');
	});
});

/** A provider that replies with a scripted sequence, one per call. */
function scripted(replies: readonly string[]): {
	provider: Provider;
	seen: ChatMessage[][];
} {
	const seen: ChatMessage[][] = [];
	let call = 0;
	return {
		seen,
		provider: {
			id: 'scripted',
			model: 'scripted',
			async *chat(messages: readonly ChatMessage[]) {
				seen.push([...messages]);
				const reply = replies[call] ?? '(no more replies)';
				call++;
				// Delta by delta, so the lookahead is exercised the way a real
				// stream exercises it.
				for (const chunk of reply.match(/.{1,3}/gs) ?? []) {
					yield chunk;
				}
			},
		} as unknown as Provider,
	};
}

describe('deciding to propose', () => {
	it('reads a PLAN line and takes everything after it as the instruction', () => {
		const reply = [
			'The five undated moments all have dates in the ordered list.',
			'',
			'PLAN: set at on bicameral-era -9839232000000, bootstrapping -1009152000000',
		].join('\n');

		expect(parsePlan(reply)).toBe(
			'set at on bicameral-era -9839232000000, bootstrapping -1009152000000',
		);
	});

	it('takes an instruction that runs on past one line', () => {
		const reply = 'PLAN: do the first thing,\nand then the second thing';
		expect(parsePlan(reply)).toBe('do the first thing,\nand then the second thing');
	});

	it('is not a plan when there is no instruction after it', () => {
		expect(parsePlan('PLAN:')).toBeUndefined();
		expect(parsePlan('I could plan that for you.')).toBeUndefined();
		expect(parsePlan('')).toBeUndefined();
	});
});

describe('the curator deciding for itself', () => {
	async function planning(replies: readonly string[]) {
		const {provider, seen} = scripted(replies);
		return {
			seen,
			session: new CuratorSession({
				root,
				project: await computeProject(root),
				provider,
				register: '',
			}),
		};
	}

	const drain = async (generator: AsyncGenerator<string>) => {
		let out = '';
		for await (const delta of generator) {
			out += delta;
		}
		return out;
	};

	it('offers the instruction to the caller instead of the author', async () => {
		const {session: s} = await planning([
			['I will set the five dates.', '', 'PLAN: set at on the five undated moments'].join(
				'\n',
			),
		]);

		const shown = await drain(s.ask('align the dates', new AbortController().signal));

		// The reasoning shows; the directive does not.
		expect(shown).toContain('I will set the five dates.');
		expect(shown).not.toContain('PLAN:');
		expect(s.pendingPlan).toBe('set at on the five undated moments');
	});

	it('has no pending plan after a reply that did not ask for one', async () => {
		const {session: s} = await planning(['The farm appears in one situation.']);
		await drain(s.ask('where is the farm', new AbortController().signal));

		expect(s.pendingPlan).toBeUndefined();
	});

	it('clears a plan from the previous reply', async () => {
		const {session: s} = await planning(['PLAN: do the thing', 'Nothing further.']);

		await drain(s.ask('first', new AbortController().signal));
		expect(s.pendingPlan).toBe('do the thing');

		await drain(s.ask('second', new AbortController().signal));
		expect(s.pendingPlan).toBeUndefined();
	});

	/**
	 * Files are what a plan would be written from, so a reply asking for both
	 * reads first. The plan directive is re-read from the round that answers.
	 */
	it('reads before it plans when a reply asks for both', async () => {
		await write('characters/inanna.md', '---\nid: inanna\n---\n\nShe lied.\n');
		const {session: s} = await planning([
			'READ: characters/inanna.md\nPLAN: too early',
			'Now I know.\n\nPLAN: fix her page',
		]);

		await drain(s.ask('fix it', new AbortController().signal));

		expect(s.pendingPlan).toBe('fix her page');
	});
});

describe('the curator opening a file mid-answer', () => {
	async function session(replies: readonly string[]) {
		const {provider, seen} = scripted(replies);
		return {
			seen,
			session: new CuratorSession({
				root,
				project: await computeProject(root),
				provider,
				register: '',
			}),
		};
	}

	const drain = async (generator: AsyncGenerator<string>) => {
		let out = '';
		for await (const delta of generator) {
			out += delta;
		}
		return out;
	};

	it('never shows the request to the author', async () => {
		await write('characters/inanna.md', '---\nid: inanna\n---\n\nShe lied.\n');
		const {session: s} = await session([
			'READ: characters/inanna.md',
			'Her page links the farm. Here is the fix.',
		]);

		const shown = await drain(s.ask('reconcile the farm', new AbortController().signal));

		expect(shown).toBe('Her page links the farm. Here is the fix.');
		expect(shown).not.toContain('READ:');
	});

	/**
	 * The reported failure end to end: reasoning, then a wrapped request. The
	 * reasoning is worth showing — it says why a file is wanted — and the
	 * request must be acted on rather than displayed.
	 */
	it('acts on a request that follows reasoning, and shows only the reasoning', async () => {
		await write(
			'timeline/moments/the-first-memory.md',
			'---\nid: the-first-memory\n---\n\nUndated.\n',
		);
		const {session: s, seen} = await session([
			[
				'Before I propose the merge, I want to pin provenance.',
				'',
				'READ: timeline/moments/the-first-memory.md,',
				' timeline/moments/inannas-first-memory.md',
			].join('\n'),
			'Merged. Keep the dated one.',
		]);

		const shown = await drain(
			s.ask('merge the duplicates', new AbortController().signal),
		);

		expect(shown).toContain('pin provenance');
		expect(shown).not.toContain('READ:');
		expect(shown).not.toContain('the-first-memory.md');
		expect(shown).toContain('Merged.');

		expect(seen).toHaveLength(2);
		expect(seen[1]!.map(m => m.content).join('\n')).toContain('Undated.');
	});

	it('puts the file in front of it on the second pass', async () => {
		await write('characters/inanna.md', '---\nid: inanna\n---\n\nShe lied.\n');
		const {session: s, seen} = await session(['READ: characters/inanna.md', 'Done.']);

		await drain(s.ask('reconcile the farm', new AbortController().signal));

		expect(seen).toHaveLength(2);
		const second = seen[1]!.map(m => m.content).join('\n');
		expect(second).toContain('She lied.');
		expect(second).toContain('Files you asked for');
	});

	it('records only the answer as the turn, not the request', async () => {
		await write('characters/inanna.md', '---\nid: inanna\n---\n\nShe lied.\n');
		const {session: s} = await session(['READ: characters/inanna.md', 'Done.']);

		await drain(s.ask('reconcile the farm', new AbortController().signal));

		expect(s.turns.map(t => t.text)).toEqual(['reconcile the farm', 'Done.']);
	});

	it('streams an ordinary answer without holding it back', async () => {
		const {session: s} = await session(['The farm appears in one situation.']);

		const shown = await drain(s.ask('where is the farm', new AbortController().signal));

		expect(shown).toBe('The farm appears in one situation.');
	});

	it('handles a reply shorter than the lookahead', async () => {
		const {session: s} = await session(['No.']);
		expect(await drain(s.ask('anything?', new AbortController().signal))).toBe('No.');
	});

	it('stops asking after its rounds are spent', async () => {
		await write('characters/inanna.md', '---\nid: inanna\n---\n\nShe lied.\n');
		// An curator that only ever asks would otherwise loop forever.
		const {session: s, seen} = await session([
			'READ: characters/inanna.md',
			'READ: characters/inanna.md',
			'READ: characters/inanna.md',
			'READ: characters/inanna.md',
		]);

		await drain(s.ask('loop forever', new AbortController().signal));

		expect(seen.length).toBeLessThanOrEqual(3);
	});
});
