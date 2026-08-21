import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	BASE_PERSONA,
	BRIEFS,
	buildExtractionMessages,
	buildGrounding,
	EXTRACTION_PERSONA,
	findForResume,
	findResumable,
	composeSystemPrompt,
	extractJsonObject,
	InterviewSession,
	listTranscripts,
	parseTranscript,
	renderTranscript,
	runExtraction,
	saveTranscript,
	type InterviewKind,
} from '../source/interview/index.js';
import {BUILT_IN_PROFILES, overlayFor, resolveProfile} from '../source/genre/index.js';
import type {ChatMessage, Provider} from '../source/llm/index.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-int-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

/** Records what it was asked and replies from a script. */
function scriptedProvider(replies: string[]): Provider & {seen: ChatMessage[][]} {
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
			const reply = replies[Math.min(turn, replies.length - 1)] ?? '';
			turn += 1;
			// Chunked, so streaming assembly is exercised rather than assumed.
			for (const word of reply.split(' ')) {
				yield `${word} `;
			}
		},
	};
}

const KINDS: InterviewKind[] = ['system', 'timeline', 'character', 'themes'];

async function drain(iterable: AsyncIterable<string>): Promise<string> {
	let out = '';
	for await (const delta of iterable) {
		out += delta;
	}
	return out;
}

describe('prompt composition', () => {
	it('layers persona, brief, and grounding in that order', () => {
		const prompt = composeSystemPrompt('system', '## index.md\n\nCarl exists.');

		expect(prompt.indexOf(BASE_PERSONA)).toBe(0);
		expect(prompt.indexOf(BRIEFS.system)).toBeGreaterThan(0);
		// The persona ends by referring forward to "the corpus below", so
		// grounding must come last.
		expect(prompt.indexOf('Carl exists.')).toBeGreaterThan(prompt.indexOf(BRIEFS.system));
	});

	it('has a distinct brief for every interview', () => {
		const briefs = KINDS.map(kind => BRIEFS[kind]);
		expect(new Set(briefs).size).toBe(4);
	});

	it('tells the interviewer the vault is empty rather than injecting nothing', () => {
		expect(composeSystemPrompt('themes', '   ')).toContain('This vault is empty');
	});

	it('never invites schema questions — that is the extractor’s job', () => {
		expect(BASE_PERSONA).toContain(
			'Never ask about mechanics, numbers, formulas, or schema',
		);
	});
});

describe('the base prompts carry no setting idiom', () => {
	/**
	 * Idiom belongs to the genre system and nowhere else. A fantasy word in the
	 * base brief is not a wording preference — it primes every SF vault's
	 * interviewer toward a setting its author did not choose, and no profile can
	 * take it back out, because a profile only ever appends.
	 */
	const IDIOM_WORDS = [
		// arcane
		'magic',
		'mana',
		'spell',
		'wizard',
		'sword',
		'dragon',
		'dungeon',
		'enchant',
		'rune',
		'guild',
		// technological
		'cyber',
		'android',
		'starship',
		'nanite',
		'implant',
		'server',
		'firmware',
		'protocol',
		'augment',
		// Form, not idiom, but the same failure: §4 lists five and the base brief
		// must not presume one. "floor" is a tower climb; "logged in" is a VRMMO.
		'floor',
		'tower',
		'respawn',
		'logged in',
		'isekai',
	];

	const surfaces: readonly (readonly [string, string])[] = [
		['persona', BASE_PERSONA],
		...KINDS.map(kind => [`${kind} brief`, BRIEFS[kind]] as const),
	];

	for (const [label, prompt] of surfaces) {
		it(`${label} names no setting`, () => {
			const found = IDIOM_WORDS.filter(word =>
				new RegExp(`\\b${word}`, 'i').test(prompt),
			);
			expect(found).toEqual([]);
		});
	}

	it('the profiles do supply idiom, so it is not merely absent everywhere', () => {
		// Guards the test above from passing because the whole mechanism is dead.
		const arcane = overlayFor(
			'system',
			resolveProfile('arcane', BUILT_IN_PROFILES),
			{idiom: 'arcane'},
			'',
		);
		expect(arcane.toLowerCase()).toContain('folk version');

		const tech = overlayFor(
			'system',
			resolveProfile('technological', BUILT_IN_PROFILES),
			{idiom: 'technological'},
			'',
		);
		expect(tech.toLowerCase()).toContain('technolog');
	});

	it('assumes no form: arrival, entry, and always-was are all left open', () => {
		// §4 lists five forms. A brief that says "when the System arrived" has
		// already ruled out the VRMMO, the isekai, and the world that always had
		// one — for every vault, whatever profile it picked.
		expect(BRIEFS.system).toContain('has it always been the case here');
		expect(BRIEFS.character).not.toMatch(/\bold world\b/i);
	});
});

describe('grounding', () => {
	it('leads with index.md and includes kind-relevant pages', async () => {
		await scaffoldVault(root);
		// An index the author actually owns — no `example: true`.
		await writeFile(
			path.join(root, 'index.md'),
			'---\ntitle: Index\n---\n\n# Index\n\n- [[nyx]]\n',
			'utf8',
		);

		const grounding = await buildGrounding(root, 'system');

		// index.md is the cheapest map of what exists, so it leads.
		expect(grounding.startsWith('## index.md')).toBe(true);
		expect(grounding).toContain('setting/idiom.md');
		expect(grounding).toContain('setting/formulas.md');
	});

	/**
	 * The bug this guards: `/init` seeds narrative placeholders so the vault opens
	 * as a connected Obsidian graph. Feeding them to the interviewer makes it
	 * interview the author about a character they never invented.
	 */
	it('never presents scaffold placeholders as the author’s world', async () => {
		await scaffoldVault(root);

		const grounding = await buildGrounding(root, 'system');

		expect(grounding).not.toContain('protagonist.md');
		expect(grounding).not.toContain('The Arrival');
		expect(grounding).not.toContain('sit-001');
		// It says so plainly rather than going silent, and the system schema
		// files are still legitimately present.
		expect(grounding).toContain('Not established');
		expect(grounding).toContain('your protagonist');
		expect(grounding).toContain('setting/formulas.md');
	});

	it('excludes placeholders from every interview kind', async () => {
		await scaffoldVault(root);

		for (const kind of KINDS) {
			const grounding = await buildGrounding(root, kind);
			expect(grounding).not.toContain('Commodification');
			expect(grounding).not.toContain('Ground Floor');
		}
	});

	it('includes a page as soon as the author drops the example flag', async () => {
		await scaffoldVault(root);
		await writeFile(
			path.join(root, 'corpus', 'characters', 'nyx.md'),
			'---\nid: nyx\nname: Nyx\n---\n\n# Nyx\n\nA real character.\n',
			'utf8',
		);

		const grounding = await buildGrounding(root, 'character');

		expect(grounding).toContain('Nyx');
		expect(grounding).not.toContain('unnamed protagonist');
	});

	it('selects different pages per interview kind', async () => {
		await scaffoldVault(root);
		// Author-written pages, so they are not filtered as placeholders.
		await writeFile(
			path.join(root, 'corpus', 'themes', 'debt.md'),
			'---\nid: debt\n---\n\n# Debt\n',
			'utf8',
		);
		await writeFile(
			path.join(root, 'corpus', 'moments', 'real-event.md'),
			'---\nid: real-event\nname: Real Event\n---\n\n# Real events\n',
			'utf8',
		);

		const themes = await buildGrounding(root, 'themes');
		const timeline = await buildGrounding(root, 'timeline');

		expect(themes).toContain('corpus/themes/debt.md');
		expect(timeline).toContain('corpus/moments/real-event.md');
		expect(timeline).not.toContain('corpus/themes/debt.md');
	});

	it('narrows character grounding to the focused character', async () => {
		await scaffoldVault(root);

		const focused = await buildGrounding(root, 'character', {focus: 'nobody'});

		expect(focused).not.toContain('characters/protagonist.md');
	});

	it('respects the character budget', async () => {
		await scaffoldVault(root);
		await writeFile(
			path.join(root, 'setting', 'lore.md'),
			`---\ntitle: Lore\n---\n\n${'x'.repeat(5000)}\n`,
			'utf8',
		);

		const full = await buildGrounding(root, 'system');
		const bounded = await buildGrounding(root, 'system', {budget: 1500});

		expect(bounded.length).toBeLessThanOrEqual(1500);
		expect(bounded.length).toBeLessThan(full.length);
		// The caution is reserved for, so truncation never drops it.
		expect(bounded).toContain('Not established');
	});

	it('returns empty for a vault that does not exist', async () => {
		expect(await buildGrounding(root, 'system')).toBe('');
	});
});

describe('InterviewSession', () => {
	const make = (replies: string[], kind: InterviewKind = 'system') => {
		const provider = scriptedProvider(replies);
		const session = new InterviewSession({
			root,
			kind,
			provider,
			grounding: '## index.md\n\nNothing yet.',
			now: new Date('2026-08-15T10:00:00Z'),
		});
		return {provider, session};
	};

	it('streams the first question and records it as pending', async () => {
		const {session} = make(['What was the last ordinary day?']);

		const streamed = await drain(session.ask(new AbortController().signal));

		expect(streamed.trim()).toBe('What was the last ordinary day?');
		expect(session.pendingQuestion).toBe('What was the last ordinary day?');
		expect(session.exchanges).toHaveLength(0);
	});

	it('sends system prompt plus a kickoff, then alternates roles', async () => {
		const {provider, session} = make(['Q1', 'Q2']);

		await drain(session.ask(new AbortController().signal));
		await session.recordAnswer('A1');
		await drain(session.ask(new AbortController().signal));

		const second = provider.seen[1]!;
		expect(second.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
		expect(second[2]?.content).toBe('Q1');
		expect(second[3]?.content).toBe('A1');
	});

	it('refuses an answer when no question is pending', async () => {
		const {session} = make(['Q1']);

		await expect(session.recordAnswer('A')).rejects.toThrow('no question is pending');
	});

	it('holds the minimum viable set open until enough exchanges', async () => {
		const {session} = make(['Q']);

		for (let i = 0; i < 5; i++) {
			await drain(session.ask(new AbortController().signal));
			await session.recordAnswer(
				'A genuinely long and detailed answer about the world and its System.',
			);
		}

		expect(session.status().minimumReached).toBe(false);
		await drain(session.ask(new AbortController().signal));
		await session.recordAnswer(
			'Another long, detailed, opinionated answer that keeps the energy up.',
		);
		expect(session.status().minimumReached).toBe(true);
	});

	it('offers an exit when answers flatten after the minimum', async () => {
		const {session} = make(['Q']);

		for (let i = 0; i < 6; i++) {
			await drain(session.ask(new AbortController().signal));
			await session.recordAnswer(
				'A long, engaged answer with real detail in it about the world.',
			);
		}
		expect(session.status().shouldOfferExit).toBe(false);

		// Two short answers in a row is the spec's "shorter and flatter" signal.
		for (const short of ['dunno', 'sure']) {
			await drain(session.ask(new AbortController().signal));
			await session.recordAnswer(short);
		}

		expect(session.status().shouldOfferExit).toBe(true);
	});

	it('ranks questions by how much the author wrote back', async () => {
		const {session} = make(['Q1', 'Q2', 'Q3']);

		for (const answer of ['short', 'x'.repeat(400), 'medium length answer']) {
			await drain(session.ask(new AbortController().signal));
			await session.recordAnswer(answer);
		}

		const metrics = session.metrics();
		expect(metrics[0]?.question).toBe('Q2');
		expect(metrics[0]?.answerChars).toBe(400);
	});

	it('writes metrics to the disposable cache, not the corpus', async () => {
		const {session} = make(['Q1']);
		await drain(session.ask(new AbortController().signal));
		await session.recordAnswer('An answer.');

		const line = await readFile(
			path.join(root, '.litrpg', 'interview-metrics.jsonl'),
			'utf8',
		);
		expect(JSON.parse(line.trim())).toMatchObject({kind: 'system', answer_chars: 10});
	});

	it('leaves nothing pending when a turn is cancelled', async () => {
		const provider: Provider = {
			id: 'openai',
			model: 'test',
			async listModels() {
				return [];
			},
			// eslint-disable-next-line require-yield
			async *chat() {
				throw new Error('aborted');
			},
		};
		const session = new InterviewSession({
			root,
			kind: 'system',
			provider,
			grounding: '',
		});

		await expect(drain(session.ask(new AbortController().signal))).rejects.toThrow();
		expect(session.pendingQuestion).toBeUndefined();
	});
});

describe('transcripts', () => {
	it('round-trips through markdown', () => {
		const transcript = {
			id: 'system-2026-08-15T10-00-00',
			kind: 'system' as const,
			startedAt: '2026-08-15T10:00:00.000Z',
			status: 'complete' as const,
			exchanges: [
				{question: 'What broke?', answer: 'The sky, on a Tuesday.'},
				{question: 'Who was watching?', answer: 'Everyone. That was the point.'},
			],
		};

		const parsed = parseTranscript(renderTranscript(transcript));

		expect(parsed?.kind).toBe('system');
		expect(parsed?.exchanges).toEqual(transcript.exchanges);
	});

	it('saves into raw/ so it is corpus, not cache', async () => {
		await scaffoldVault(root);
		const file = await saveTranscript(root, {
			id: 'system-x',
			kind: 'system',
			startedAt: '2026-08-15T10:00:00.000Z',
			status: 'complete' as const,
			exchanges: [{question: 'Q', answer: 'A'}],
		});

		expect(file).toContain(path.join('raw', 'interviews'));
		expect(file).not.toContain('.litrpg');
		expect(await listTranscripts(root)).toHaveLength(1);
	});

	it('ignores a non-transcript markdown file', async () => {
		await scaffoldVault(root);
		await saveTranscript(root, {
			id: 'system-x',
			kind: 'system',
			startedAt: '',
			status: 'complete' as const,
			exchanges: [],
		});
		const {writeFile} = await import('node:fs/promises');
		await writeFile(
			path.join(root, 'raw', 'interviews', 'notes.md'),
			'# just notes\n',
			'utf8',
		);

		expect(await listTranscripts(root)).toHaveLength(1);
	});
});

describe('extraction', () => {
	const transcript = {
		id: 'themes-x',
		kind: 'themes' as const,
		startedAt: '',
		status: 'complete' as const,
		exchanges: [
			{
				question: 'What makes you angry about the real world?',
				answer:
					'That suffering gets packaged and sold back to the people it happened to.',
			},
		],
	};

	it('finds a JSON object wrapped in a fence', () => {
		const parsed = extractJsonObject('Sure!\n```json\n{"writes":[]}\n```\nDone.');
		expect(parsed).toEqual({writes: []});
	});

	it('finds a JSON object trailed by commentary', () => {
		const parsed = extractJsonObject('{"a":1} — hope that helps');
		expect(parsed).toEqual({a: 1});
	});

	it('is not fooled by braces inside strings', () => {
		const parsed = extractJsonObject('{"detail":"a } brace","n":2}');
		expect(parsed).toEqual({detail: 'a } brace', n: 2});
	});

	it('says a truncated reply was cut off, not that the JSON was bad', () => {
		// The reported symptom: a 30-exchange interview hit the provider's output
		// ceiling and the failure read as a JSON-handling bug, which sent the
		// reader after the parser instead of the budget that ran out.
		expect(() => extractJsonObject('{"writes":[{"path":"system/sys')).toThrow(
			/cut off before it finished/,
		);
	});

	it('carries a provider hint into the extraction failure', async () => {
		const {ProviderError} = await import('../source/llm/index.js');
		const provider: Provider = {
			id: 'kimi-code',
			model: 'k3',
			async listModels() {
				return [];
			},
			// eslint-disable-next-line require-yield
			async *chat() {
				throw new ProviderError(
					'the model stopped at its 8192-token output limit, mid-answer',
					'raise maxOutputTokens for this provider',
				);
			},
		};

		const result = await runExtraction(
			provider,
			{
				id: 't-1',
				kind: 'system',
				startedAt: '2026-01-01T00:00:00.000Z',
				status: 'complete',
				exchanges: [{question: 'q', answer: 'a'}],
			},
			'',
			new AbortController().signal,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('output limit');
			// The actionable half survives the boundary.
			expect(result.reason).toContain('raise maxOutputTokens');
		}
	});

	it('parses a well-formed extraction', async () => {
		const provider = scriptedProvider([
			JSON.stringify({
				writes: [
					{
						path: 'themes/commodification.md',
						contents: '---\nid: commodification\n---\n\n# Body\n',
						confidence: 'high',
					},
				],
				open_fields: [
					{field: 'subthemes[0].tension', question: 'What is the other pole?'},
				],
				contradictions: [],
			}),
		]);

		const result = await runExtraction(
			provider,
			transcript,
			'',
			new AbortController().signal,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.extraction.writes[0]?.path).toBe('themes/commodification.md');
			expect(result.extraction.open_fields[0]?.question).toBe('What is the other pole?');
		}
	});

	it('reports a bad response instead of throwing, keeping the raw text', async () => {
		const provider = scriptedProvider(['I could not do that.']);

		const result = await runExtraction(
			provider,
			transcript,
			'',
			new AbortController().signal,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.raw).toContain('could not');
		}
	});

	it('sends the transcript and a schema hint for the right kind', async () => {
		const provider = scriptedProvider(['{}']);

		await runExtraction(provider, transcript, '', new AbortController().signal);

		const sent = provider.seen[0]!;
		expect(sent[0]?.role).toBe('system');
		expect(sent[1]?.content).toContain('themes/<pillar-id>.md');
		expect(sent[1]?.content).toContain('sold back to the people');
	});
});

describe('resuming an unfinished interview', () => {
	const start = (replies: string[], resumeFrom?: Parameters<typeof saveTranscript>[1]) =>
		new InterviewSession({
			root,
			kind: 'system',
			provider: scriptedProvider(replies),
			grounding: '',
			...(resumeFrom === undefined ? {} : {resumeFrom}),
			now: new Date('2026-08-15T10:00:00Z'),
		});

	it('is in-progress until the author wraps up', async () => {
		const session = start(['Q1']);
		await drain(session.ask(new AbortController().signal));
		await session.recordAnswer('A1');

		expect(session.toTranscript().status).toBe('in-progress');
		session.complete();
		expect(session.toTranscript().status).toBe('complete');
	});

	it('offers only unfinished interviews of the same kind and focus', async () => {
		await saveTranscript(root, {
			id: 'system-a',
			kind: 'system',
			startedAt: '2026-08-15T10:00:00Z',
			status: 'in-progress',
			exchanges: [{question: 'Q', answer: 'A'}],
		});
		await saveTranscript(root, {
			id: 'themes-b',
			kind: 'themes',
			startedAt: '2026-08-15T11:00:00Z',
			status: 'in-progress',
			exchanges: [{question: 'Q', answer: 'A'}],
		});
		await saveTranscript(root, {
			id: 'system-done',
			kind: 'system',
			startedAt: '2026-08-15T12:00:00Z',
			status: 'complete',
			exchanges: [{question: 'Q', answer: 'A'}],
		});

		expect((await findResumable(root, 'system'))?.id).toBe('system-a');
		expect((await findResumable(root, 'themes'))?.id).toBe('themes-b');
		expect(await findResumable(root, 'character')).toBeUndefined();
	});

	it('does not offer a different character’s abandoned interview', async () => {
		await saveTranscript(root, {
			id: 'character-nyx',
			kind: 'character',
			startedAt: '2026-08-15T10:00:00Z',
			focus: 'nyx',
			status: 'in-progress',
			exchanges: [{question: 'Q', answer: 'A'}],
		});

		expect((await findResumable(root, 'character', 'nyx'))?.id).toBe('character-nyx');
		expect(await findResumable(root, 'character', 'vale')).toBeUndefined();
	});

	it('picks the most recent when several are unfinished', async () => {
		for (const [id, at] of [
			['system-old', '2026-08-01T10:00:00Z'],
			['system-new', '2026-08-14T10:00:00Z'],
		] as const) {
			await saveTranscript(root, {
				id,
				kind: 'system',
				startedAt: at,
				status: 'in-progress',
				exchanges: [{question: 'Q', answer: 'A'}],
			});
		}

		expect((await findResumable(root, 'system'))?.id).toBe('system-new');
	});

	it('replays prior exchanges to the model so it continues, not restarts', async () => {
		const prior = {
			id: 'system-x',
			kind: 'system' as const,
			startedAt: '2026-08-15T09:00:00Z',
			status: 'in-progress' as const,
			exchanges: [
				{question: 'Where was your protagonist?', answer: 'On the roof.'},
				{question: 'What did they see?', answer: 'An invoice.'},
			],
		};
		const provider = scriptedProvider(['Q3']);
		const session = new InterviewSession({
			root,
			kind: 'system',
			provider,
			grounding: '',
			resumeFrom: prior,
		});

		await drain(session.ask(new AbortController().signal));

		const sent = provider.seen[0]!;
		expect(sent.map(m => m.role)).toEqual([
			'system',
			'user',
			'assistant',
			'user',
			'assistant',
			'user',
		]);
		expect(sent[3]?.content).toBe('On the roof.');
		expect(sent[5]?.content).toBe('An invoice.');
		expect(session.resumed).toBe(true);
		expect(session.resumedWith).toBe(2);
	});

	it('keeps writing the same transcript file rather than littering', async () => {
		const prior = {
			id: 'system-keep',
			kind: 'system' as const,
			startedAt: '2026-08-15T09:00:00Z',
			status: 'in-progress' as const,
			exchanges: [{question: 'Q1', answer: 'A1'}],
		};
		await saveTranscript(root, prior);

		const session = new InterviewSession({
			root,
			kind: 'system',
			provider: scriptedProvider(['Q2']),
			grounding: '',
			resumeFrom: prior,
		});
		await drain(session.ask(new AbortController().signal));
		await session.recordAnswer('A2');
		await saveTranscript(root, session.toTranscript());

		const all = await listTranscripts(root);
		expect(all).toHaveLength(1);
		expect(all[0]?.exchanges).toHaveLength(2);
	});

	it('a completed interview stops offering itself', async () => {
		const session = start(['Q1']);
		await drain(session.ask(new AbortController().signal));
		await session.recordAnswer('A1');
		await saveTranscript(root, session.toTranscript());
		expect(await findResumable(root, 'system')).toBeDefined();

		session.complete();
		await saveTranscript(root, session.toTranscript());
		expect(await findResumable(root, 'system')).toBeUndefined();
	});

	it('ignores an unfinished transcript with no exchanges', async () => {
		await saveTranscript(root, {
			id: 'system-empty',
			kind: 'system',
			startedAt: '2026-08-15T10:00:00Z',
			status: 'in-progress',
			exchanges: [],
		});

		expect(await findResumable(root, 'system')).toBeUndefined();
	});
});

describe('an explicit resume', () => {
	const saveOne = async (id: string, status: 'in-progress' | 'complete', at: string) =>
		saveTranscript(root, {
			id,
			kind: 'system',
			startedAt: at,
			status,
			exchanges: [{question: 'Q', answer: 'A'}],
		});

	it('reopens a wrapped-up interview rather than reporting none', async () => {
		// The author typed /done, extraction produced nothing usable, and the
		// transcript sealed. Refusing to reopen it strands their answers.
		await saveOne('system-done', 'complete', '2026-08-15T11:00:00Z');

		expect(await findResumable(root, 'system')).toBeUndefined();

		const prior = await findForResume(root, 'system');
		expect(prior?.transcript.id).toBe('system-done');
		expect(prior?.reopened).toBe(true);
	});

	it('prefers genuinely unfinished work over a newer completed one', async () => {
		await saveOne('system-open', 'in-progress', '2026-08-15T10:00:00Z');
		await saveOne('system-sealed', 'complete', '2026-08-15T12:00:00Z');

		const prior = await findForResume(root, 'system');
		expect(prior?.transcript.id).toBe('system-open');
		expect(prior?.reopened).toBe(false);
	});

	it('still refuses when the kind has no transcript at all', async () => {
		await saveOne('system-done', 'complete', '2026-08-15T11:00:00Z');
		expect(await findForResume(root, 'themes')).toBeUndefined();
	});

	it('does not reopen a different character’s interview', async () => {
		await saveTranscript(root, {
			id: 'character-nyx',
			kind: 'character',
			startedAt: '2026-08-15T10:00:00Z',
			focus: 'nyx',
			status: 'complete',
			exchanges: [{question: 'Q', answer: 'A'}],
		});

		expect((await findForResume(root, 'character', 'nyx'))?.reopened).toBe(true);
		expect(await findForResume(root, 'character', 'vale')).toBeUndefined();
	});

	it('appends to the reopened transcript instead of starting a new file', async () => {
		await saveOne('system-done', 'complete', '2026-08-15T11:00:00Z');
		const prior = await findForResume(root, 'system');

		const session = new InterviewSession({
			root,
			kind: 'system',
			provider: scriptedProvider(['Q2']),
			grounding: '',
			resumeFrom: prior!.transcript,
		});
		await drain(session.ask(new AbortController().signal));
		await session.recordAnswer('A2');
		await saveTranscript(root, session.toTranscript());

		const all = await listTranscripts(root);
		expect(all).toHaveLength(1);
		expect(all[0]?.exchanges).toHaveLength(2);
		// Reopening makes it live again, so a crash mid-continuation is resumable.
		expect(all[0]?.status).toBe('in-progress');
	});
});

describe('transcripts written before status existed', () => {
	it('are treated as resumable, not silently discarded', async () => {
		// The field did not exist when these were written. Defaulting them to
		// complete would make an author's saved work unreachable.
		const legacy = [
			'---',
			'id: system-legacy',
			'kind: system',
			'started_at: 2026-08-15T11:07:19.771Z',
			'exchanges: 1',
			'generated: false',
			'---',
			'',
			'### 1. Interviewer',
			'',
			'Where was your protagonist?',
			'',
			'### Author',
			'',
			'On the roof.',
			'',
		].join('\n');

		const parsed = parseTranscript(legacy);
		expect(parsed?.status).toBe('in-progress');

		const {mkdir, writeFile} = await import('node:fs/promises');
		await mkdir(path.join(root, 'raw', 'interviews'), {recursive: true});
		await writeFile(
			path.join(root, 'raw', 'interviews', 'system-legacy.md'),
			legacy,
			'utf8',
		);

		expect((await findResumable(root, 'system'))?.id).toBe('system-legacy');
	});

	it('an explicitly complete transcript stays complete', () => {
		const done =
			'---\nid: x\nkind: system\nstatus: complete\n---\n\n### 1. Interviewer\n\nQ\n\n### Author\n\nA\n';
		expect(parseTranscript(done)?.status).toBe('complete');
	});
});

/**
 * The bug these pin: the interviewer is told "start with meaning, reach
 * mechanics late", and the extractor used to be given only mechanical
 * destinations — stats, skills, curves, formulas. A good meaning-first
 * interview therefore produced zero corpus writes every single time, because
 * there was nowhere on disk for any of it to go.
 */
describe('extraction has somewhere to put meaning', () => {
	const systemHint = () =>
		buildExtractionMessages(
			{
				id: 'system-x',
				kind: 'system',
				startedAt: '2026-08-15T11:07:19.000Z',
				focus: undefined,
				status: 'complete',
				exchanges: [{question: 'What does it cost?', answer: 'Memory.'}],
			},
			'',
		)
			.map(message => message.content)
			.join('\n');

	it('names system/system.md as a target, not only the mechanical files', () => {
		expect(systemHint()).toContain('system/system.md');
	});

	/** These two questions exist in the base brief precisely to set these fields. */
	it('asks for the descriptors the base brief interviews for', () => {
		const hint = systemHint();
		expect(hint).toContain('system_visibility');
		expect(hint).toContain('system_agency');
		expect(hint).toContain('system_origin');
	});

	/** A whole-file rewrite could otherwise reset the vault's vocabulary. */
	it('forbids touching the idiom', () => {
		expect(systemHint()).toContain('PRESERVE the existing `idiom`');
	});

	it('tells the extractor not to invent mechanics to fill the schema', () => {
		expect(systemHint()).toContain('Do not invent mechanics');
	});

	it('names returning nothing as the failure it is', () => {
		expect(EXTRACTION_PERSONA).toContain(
			'Returning no writes because nothing was numeric',
		);
	});

	it('gives an arc body somewhere to land too', () => {
		const timeline = buildExtractionMessages(
			{
				id: 'timeline-x',
				kind: 'timeline',
				startedAt: '2026-08-15T11:07:19.000Z',
				focus: undefined,
				status: 'complete',
				exchanges: [{question: 'What is the shape?', answer: 'A descent.'}],
			},
			'',
		)
			.map(message => message.content)
			.join('\n');

		expect(timeline).toContain('what the arc is *about*');
	});
});
