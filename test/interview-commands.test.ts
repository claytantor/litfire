import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {saveProvider} from '../source/vault/config.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-cmd-'));
	await scaffoldVault(root);
	await saveProvider(root, {id: 'openai', model: 'gpt-4o'});
	context = {
		root,
		project: await computeProject(root),
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	};
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

/** Dispatches the way App does: split the line, strip the slash, look it up. */
async function dispatch(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	const command = findCommand(head.replace(/^\//, ''));
	if (!command) {
		throw new Error(`no command for ${line}`);
	}
	return command.run(args, context);
}

describe('all four interview paths reach the interview', () => {
	const cases: [string, string, string | undefined][] = [
		// A scaffolded vault has one system, id `system`, so a bare `/system`
		// namespaces to it rather than staying unfocused — the same transcript
		// namespace a vault with several would use.
		['/system', 'system', 'system'],
		['/system the-lathe', 'system', 'the-lathe'],
		['/timeline interview', 'timeline', undefined],
		['/character protagonist', 'character', 'protagonist'],
		['/themes interview', 'themes', undefined],
	];

	for (const [line, kind, focus] of cases) {
		it(`${line} → ${kind}`, async () => {
			const result = await dispatch(line);

			expect(result.interview).toBeDefined();
			expect(result.interview?.kind).toBe(kind);
			expect(result.interview?.focus).toBe(focus);
		});
	}
});

describe('the structural views are not shadowed', () => {
	it('bare /timeline still renders the structural view', async () => {
		const result = await dispatch('/timeline');

		expect(result.interview).toBeUndefined();
		expect(result.lines.map(l => l.text).join('\n')).toContain('timeline');
	});

	it('bare /themes still renders coverage', async () => {
		const result = await dispatch('/themes');

		expect(result.interview).toBeUndefined();
		expect(result.lines.map(l => l.text).join('\n')).toContain('coverage');
	});
});

describe('interview preconditions', () => {
	it('/character requires a name', async () => {
		const result = await dispatch('/character');

		expect(result.interview).toBeUndefined();
		expect(result.lines[0]?.text).toContain('usage: /character <name>');
	});

	it('every interview refuses without a configured provider', async () => {
		const bare = await mkdtemp(path.join(tmpdir(), 'litfire-bare-'));
		await scaffoldVault(bare);
		const bareContext: CommandContext = {
			...context,
			root: bare,
			project: await computeProject(bare),
		};

		for (const line of ['/system', '/timeline interview', '/themes interview']) {
			const [head = '', ...args] = line.trim().split(/\s+/);
			const result = await findCommand(head.replace(/^\//, ''))!.run(args, bareContext);

			expect(result.interview).toBeUndefined();
			expect(result.lines.map(l => l.text).join(' ')).toContain('/provider');
		}

		await rm(bare, {recursive: true, force: true});
	});

	it('interviews refuse when there is no vault at all', async () => {
		const result = await findCommand('system')!.run([], {
			...context,
			project: undefined,
		});

		expect(result.interview).toBeUndefined();
		expect(result.lines[0]?.text).toContain('/init');
	});
});

describe('discoverability', () => {
	it('/help lists the interviews that have their own command', async () => {
		const rendered = (await dispatch('/help')).lines.map(l => l.text).join('\n');

		expect(rendered).toContain('/system');
		expect(rendered).toContain('/character <name>');
	});

	/** All four take the same directives, and /help has to say so. */
	it('/help shows the same show|resume|extract form on every interview', async () => {
		const rendered = (await dispatch('/help')).lines.map(l => l.text).join('\n');

		for (const line of [
			'/system <id> [show|resume|extract [all]]',
			'/timeline [show|interview|resume|extract [all]]',
			'/themes [show|interview|resume|extract [all]]',
			'/character <name> [show|resume|extract [all]]',
		]) {
			expect(rendered).toContain(line);
		}
	});
});

describe('resuming from the command layer', () => {
	const unfinished = async (kind: 'system' | 'themes', focus?: string) => {
		const {saveTranscript} = await import('../source/interview/index.js');
		await saveTranscript(root, {
			id: `${kind}-pending`,
			kind,
			startedAt: '2026-08-15T09:00:00Z',
			...(focus === undefined ? {} : {focus}),
			status: 'in-progress',
			exchanges: [{question: 'Where was your protagonist?', answer: 'On the roof.'}],
		});
	};

	it('offers to resume instead of silently discarding or restarting', async () => {
		await unfinished('system');

		const result = await dispatch('/system');

		// Neither action is taken automatically: one would surprise, the other
		// would lose work.
		expect(result.interview).toBeUndefined();
		const rendered = result.lines.map(l => l.text).join('\n');
		expect(rendered).toContain('unfinished system interview');
		expect(rendered).toContain('1 exchange');
		expect(rendered).toContain('/system resume');
		expect(rendered).toContain('/system new');
	});

	it('/system resume continues it', async () => {
		await unfinished('system');

		const result = await dispatch('/system resume');

		// The focus is the single system's id: a resumed interview stays in
		// the same namespace a new one would use.
		expect(result.interview).toEqual({
			kind: 'system',
			focus: 'system',
			resume: true,
		});
	});

	it('/system new starts fresh and keeps the old transcript', async () => {
		await unfinished('system');

		const result = await dispatch('/system new');

		expect(result.interview).toEqual({kind: 'system', focus: 'system'});
		const {listTranscripts} = await import('../source/interview/index.js');
		expect(await listTranscripts(root)).toHaveLength(1);
	});

	it('resume with nothing to resume says so', async () => {
		const result = await dispatch('/system resume');

		expect(result.interview).toBeUndefined();
		expect(result.lines[0]?.text).toContain('no system interview to resume');
	});

	it('/system resume reopens a wrapped-up interview', async () => {
		const {saveTranscript} = await import('../source/interview/index.js');
		await saveTranscript(root, {
			id: 'system-sealed',
			kind: 'system',
			startedAt: '2026-08-15T09:00:00Z',
			status: 'complete',
			exchanges: [{question: 'Where was your protagonist?', answer: 'On the roof.'}],
		});

		const result = await dispatch('/system resume');

		// The focus is the single system's id: a resumed interview stays in
		// the same namespace a new one would use.
		expect(result.interview).toEqual({
			kind: 'system',
			focus: 'system',
			resume: true,
		});
		// Said out loud, because reopening something the author wrapped up is a
		// surprise if it happens silently.
		expect(result.lines.map(l => l.text).join('\n')).toContain('reopening');
	});

	it('a completed interview is reopened only when asked for by name', async () => {
		const {saveTranscript} = await import('../source/interview/index.js');
		await saveTranscript(root, {
			id: 'system-sealed',
			kind: 'system',
			startedAt: '2026-08-15T09:00:00Z',
			status: 'complete',
			exchanges: [{question: 'Q', answer: 'A'}],
		});

		// A bare /system must not nag about work the author already finished.
		const result = await dispatch('/system');
		expect(result.interview).toEqual({kind: 'system', focus: 'system'});
	});

	it('starts normally when nothing is unfinished', async () => {
		const result = await dispatch('/system');

		expect(result.interview).toEqual({kind: 'system', focus: 'system'});
	});

	it('routes /themes interview resume too', async () => {
		await unfinished('themes');

		const result = await dispatch('/themes interview resume');

		expect(result.interview).toEqual({kind: 'themes', resume: true});
	});

	it('does not mistake resume for a character name', async () => {
		const result = await dispatch('/character resume');

		// `resume` is a directive, so this is still a missing name.
		expect(result.lines[0]?.text).toContain('usage: /character <name>');
	});
});

/**
 * All four interviews take the same directives. `/timeline` and `/themes` show
 * their view as the bare command and `/system` and `/character` start an
 * interview — but `show`, `resume`, and `extract` mean the same thing on every
 * one of them.
 */
describe('the four interviews take the same directives', () => {
	const said = (result: {lines: readonly {text: string}[]}) =>
		result.lines.map(line => line.text).join('\n');

	for (const line of ['/system show', '/timeline show', '/themes show']) {
		it(`${line} renders a view instead of interviewing`, async () => {
			const result = await dispatch(line);

			expect(result.interview).toBeUndefined();
			expect(result.extract).toBeUndefined();
			expect(result.lines.length).toBeGreaterThan(0);
		});
	}

	it('/character <name> show reports a character the corpus does not have', async () => {
		expect(said(await dispatch('/character nobody show'))).toContain(
			'no characters/nobody.md',
		);
	});

	it('/character show without a name says so rather than guessing', async () => {
		expect(said(await dispatch('/character show'))).toContain('usage: /character');
	});

	for (const [line, kind] of [
		['/system resume', 'system'],
		['/timeline resume', 'timeline'],
		['/themes resume', 'themes'],
		['/character carl resume', 'character'],
	] as const) {
		it(`${line} reaches the interview layer`, async () => {
			// No transcript exists, so the interview layer is what refuses it — the
			// view would have rendered instead and said nothing about resuming.
			expect(said(await dispatch(line))).toContain(`no ${kind} interview to resume`);
		});
	}

	for (const line of [
		'/system extract',
		'/timeline extract',
		'/themes extract',
		'/character carl extract',
	]) {
		it(`${line} reaches the extract layer`, async () => {
			expect(said(await dispatch(line))).toContain('transcript to extract from');
		});
	}

	for (const line of [
		'/system extract all',
		'/timeline extract all',
		'/character carl extract all',
	]) {
		it(`${line} reaches the extract layer`, async () => {
			expect(said(await dispatch(line))).toContain('transcript to extract from');
		});
	}

	describe('extract all, with transcripts on disk', () => {
		const save = async (id: string, at: string) => {
			const {saveTranscript} = await import('../source/interview/index.js');
			await saveTranscript(root, {
				id,
				kind: 'system',
				startedAt: at,
				status: 'complete',
				exchanges: [{question: 'Who grades?', answer: 'The Assessors.'}],
			});
		};

		beforeEach(async () => {
			await save('system-2026-01-01T00-00-00', '2026-01-01T00:00:00.000Z');
			await save('system-2026-06-01T00-00-00', '2026-06-01T00:00:00.000Z');
		});

		it('sweeps every transcript and says the writes come from the newest', async () => {
			const result = await dispatch('/system extract all');

			expect(result.extract).toEqual({kind: 'system', all: true, focus: 'system'});
			expect(said(result)).toContain('sweeping 2 system transcript(s)');
			expect(said(result)).toContain('corpus writes come from system-2026-06-01');
		});

		it('bare extract takes the newest, and points at the ones it skipped', async () => {
			const result = await dispatch('/system extract');

			expect(result.extract).toEqual({kind: 'system', focus: 'system'});
			expect(said(result)).toContain('system-2026-06-01T00-00-00');
			expect(said(result)).toContain('1 older system transcript(s) not touched');
		});
	});

	/** The original spelling, kept working. */
	it('/timeline interview still starts an interview', async () => {
		expect((await dispatch('/timeline interview')).interview?.kind).toBe('timeline');
	});

	it('bare /timeline and /themes still render their view', async () => {
		expect((await dispatch('/timeline')).interview).toBeUndefined();
		expect((await dispatch('/themes')).interview).toBeUndefined();
	});
});
