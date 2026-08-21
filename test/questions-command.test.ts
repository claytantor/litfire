import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {agendaFor, BRIEF_FOR} from '../source/interview/agenda.js';
import {BRIEFS} from '../source/interview/prompts.js';
import {INGEST_KINDS} from '../source/ingest/index.js';
import {saveProvider} from '../source/vault/config.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-questions-'));
	await scaffoldVault(root, 'arcane');
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

async function file(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), {recursive: true});
	await writeFile(target, contents, 'utf8');
}

const refresh = async () => {
	context = {...context, project: await computeProject(root)};
};

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

/** A moment with no `at:`, which is `moment_undated` and nothing else. */
async function undatedMoment() {
	await file(
		`${VAULT.moments}/the-threshold.md`,
		'---\nid: the-threshold\nname: The Threshold\n---\n\nIt happened.\n',
	);
	await refresh();
}

describe('/questions, bare', () => {
	it('still lists the queue', async () => {
		await undatedMoment();
		const output = said(await run('/questions'));

		expect(output).toContain('open questions');
		expect(output).toContain('the-threshold');
		// P4: the whole point of the queue is that none of it stops you.
		expect(output).toContain('nothing here blocks writing');
	});
});

describe('/questions <kind>, with something to ask about', () => {
	it('opens the interview on what the checks found', async () => {
		await undatedMoment();
		const result = await run('/questions moment');

		expect(result.interview?.kind).toBe('moment');
		expect(said(result)).toContain('open question');
		expect(said(result)).toContain('the-threshold');
	});

	it('does not ask permission when there is a reason to be asking', async () => {
		await undatedMoment();
		expect((await run('/questions moment')).confirm).toBeUndefined();
	});

	it('narrows to one thing when told to', async () => {
		await undatedMoment();
		expect((await run('/questions moment the-threshold')).interview?.focus).toBe(
			'the-threshold',
		);
	});

	it('resumes without recomputing an agenda', async () => {
		const result = await run('/questions system resume');

		expect(result.interview?.resume).toBe(true);
		expect(result.confirm).toBeUndefined();
	});
});

describe('/questions <kind>, with nothing to ask about', () => {
	/**
	 * The decided behaviour: not silence, and not an interview that starts
	 * without being asked for. The two sessions are different work — filling
	 * gaps, or going deeper into something already consistent — and the prompt
	 * is what tells the author which one they are entering.
	 */
	it('says so, and offers anyway', async () => {
		const result = await run('/questions theme');

		expect(said(result)).toContain('no open questions about themes');
		expect(result.confirm?.question).toBe('begin interview anyway?');
	});

	it('does not start one on its own', async () => {
		const result = await run('/questions theme');

		expect(result.interview).toBeUndefined();
		expect(result.confirm?.proceed.interview?.kind).toBe('theme');
	});
});

describe('every primitive can be asked about', () => {
	/**
	 * The asymmetry this feature existed to remove. Four of the kinds had an
	 * interview because `interviewKindSchema` had four members; the other six
	 * had none, for no reason beyond the order things were built in. This is
	 * the assertion that keeps it removed — a primitive added without a brief
	 * fails here rather than in front of an author.
	 */
	it('has a brief for every ingest kind', () => {
		for (const kind of INGEST_KINDS) {
			expect(BRIEF_FOR[kind], kind).toBeDefined();
			expect(BRIEFS[BRIEF_FOR[kind]!].length, kind).toBeGreaterThan(400);
		}
	});

	it('opens an interview about a kind that never had one', async () => {
		const result = await run('/questions place');

		// `place` had no brief at all before this: writing notes by hand or
		// describing them to the curator were the only ways in.
		expect(result.confirm?.proceed.interview?.kind).toBe('place');
	});

	it('refuses a kind that is not a primitive', async () => {
		expect(said(await run('/questions nonsense'))).toContain("no kind 'nonsense'");
	});

	it('needs a provider, and says which command sets one', async () => {
		// A vault whose provider was never chosen, which is every vault on the
		// first evening. Reported before the agenda is computed, because being
		// told what is missing is no use without the means to act on it.
		await writeFile(
			path.join(root, VAULT.config),
			JSON.stringify({version: 1, provider: {}}, null, 2),
			'utf8',
		);
		await refresh();

		expect(said(await run('/questions moment'))).toContain('/provider');
	});
});

describe('the agenda', () => {
	/**
	 * A finding names an id, not a kind, so the vault is what resolves one to
	 * the other. Matching on ids rather than on the finding's name is what keeps
	 * this working when a check is renamed.
	 */
	it('files a question under the page it is about', async () => {
		await undatedMoment();

		expect(agendaFor(context.project!, 'moment').map(q => q.where)).toContain(
			'the-threshold',
		);
		expect(agendaFor(context.project!, 'character')).toEqual([]);
	});

	it('follows a cross-cutting finding to the page carrying it', async () => {
		// A scene naming a character who does not exist is a question about the
		// scene: that is the page with something wrong on it.
		await file(
			`${VAULT.situations}/sit-900.md`,
			'---\nid: sit-900\ntitle: Loose\ncharacters:\n  - nobody\n---\n\nProse.\n',
		);
		await refresh();

		expect(agendaFor(context.project!, 'situation').map(q => q.where)).toContain(
			'sit-900',
		);
	});
});
