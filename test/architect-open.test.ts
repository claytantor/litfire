import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ArchitectSession} from '../source/architect/session.js';
import {
	MAX_BYTES,
	openFiles,
	parseRequest,
	renderOpened,
	resolveReadable,
} from '../source/architect/open.js';
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
		expect(parseRequest('Some thinking.\nREAD: a.md b.md')).toEqual(['a.md', 'b.md']);
		expect(parseRequest('READ: a.md, a.md')).toEqual(['a.md']);
	});

	it('is not confused by an ordinary answer', () => {
		expect(parseRequest('I would read characters/inanna.md first.')).toBeUndefined();
		expect(parseRequest('')).toBeUndefined();
	});
});

describe('what may be opened', () => {
	/**
	 * Deliberately unlike `resolveInsideVault`, which forbids `raw/` because the
	 * tool never *writes* there. Reading it is the whole point of `/architect`.
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

	it('hands refusals back to the architect rather than dropping them', () => {
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

describe('the architect opening a file mid-answer', () => {
	async function session(replies: readonly string[]) {
		const {provider, seen} = scripted(replies);
		return {
			seen,
			session: new ArchitectSession({
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
		// An architect that only ever asks would otherwise loop forever.
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
