import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {
	INTERVIEWS_DIR,
	findOrphanedInterviews,
	saveTranscript,
} from '../source/interview/index.js';
import {stringifyDocument} from '../source/vault/frontmatter.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {saveProvider} from '../source/vault/config.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

/**
 * The failure this exists for: an interview runs, extraction produces nothing or
 * the gate is cancelled, and the answers sit in `raw/interviews/` while the
 * corpus stays empty. Silent until now.
 */

let root = '';
let context: CommandContext;

/**
 * The check is a timestamp comparison, so a fixture has to sit on the right side
 * of the scaffold's own mtime. `after()` is an interview that happened since the
 * corpus was last written; `before()` is one the corpus already answered.
 */
const after = (offset = 0) => new Date(Date.now() + 60_000 + offset).toISOString();
const before = () => new Date(Date.now() - 60_000).toISOString();

const transcript = (
	kind: 'system' | 'moment' | 'character' | 'theme',
	exchanges: number,
	extra: {focus?: string; startedAt?: string} = {},
) => ({
	id: `${kind}-${extra.focus ?? 'x'}-${(extra.startedAt ?? after()).replaceAll(/[.:]/g, '-')}`,
	kind,
	startedAt: extra.startedAt ?? after(),
	focus: extra.focus,
	status: 'complete' as const,
	exchanges: Array.from({length: exchanges}, (_, index) => ({
		question: `q${index}`,
		answer: `a${index}`,
	})),
});

const refresh = async () => {
	context = {...context, project: await computeProject(root)};
};

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-orphan-'));
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

async function dispatch(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	const command = findCommand(head.replace(/^\//, ''));
	if (!command) {
		throw new Error(`no command for ${line}`);
	}
	return command.run(args, context);
}

const said = (result: {lines: readonly {text: string}[]}) =>
	result.lines.map(line => line.text).join('\n');

describe('findOrphanedInterviews', () => {
	it('reports a system interview whose answers never reached the corpus', async () => {
		await saveTranscript(root, transcript('system', 5));
		await refresh();

		const orphans = await findOrphanedInterviews(root);

		expect(orphans).toHaveLength(1);
		expect(orphans[0]?.kind).toBe('system');
		expect(orphans[0]?.exchanges).toBe(5);
		expect(orphans[0]?.detail).toContain('corpus/systems/');
	});

	it('stays quiet once the corpus has the work', async () => {
		await saveTranscript(root, transcript('system', 5, {startedAt: before()}));
		await mkdir(resolve(root, VAULT.legacySetting), {recursive: true});
		await writeFile(
			resolve(root, VAULT.stats),
			stringifyDocument({
				data: {stats: [{id: 'memory', default: 10}]},
				body: '\n',
			}),
			'utf8',
		);
		await refresh();

		expect(await findOrphanedInterviews(root)).toHaveLength(0);
	});

	it('ignores a transcript with no exchanges', async () => {
		await saveTranscript(root, transcript('system', 0));
		await refresh();

		expect(await findOrphanedInterviews(root)).toHaveLength(0);
	});

	/** Resuming splits one interview across files; the author cares about the total. */
	it('sums a resumed interview into one finding', async () => {
		await saveTranscript(root, transcript('system', 3, {startedAt: after(0)}));
		await saveTranscript(root, transcript('system', 4, {startedAt: after(1000)}));
		await refresh();

		const orphans = await findOrphanedInterviews(root);

		expect(orphans).toHaveLength(1);
		expect(orphans[0]?.exchanges).toBe(7);
	});

	it('tracks a character interview by who it was about', async () => {
		await saveTranscript(root, transcript('character', 4, {focus: 'carl'}));
		await mkdir(resolve(root, VAULT.characters), {recursive: true});
		await writeFile(
			resolve(root, VAULT.characters, 'donut.md'),
			stringifyDocument({data: {id: 'donut'}, body: '\n'}),
			'utf8',
		);
		await refresh();

		const orphans = await findOrphanedInterviews(root);

		expect(orphans[0]?.focus).toBe('carl');
		expect(orphans[0]?.detail).toContain('carl');
	});
});

describe('/lint surfaces it', () => {
	it('names the interview and how to re-run it', async () => {
		await saveTranscript(root, transcript('system', 5));
		await refresh();

		const output = said(await dispatch('/lint'));

		expect(output).toContain('interviews that produced nothing');
		expect(output).toContain('5 exchanges saved');
		expect(output).toContain('/ingest interview files it, through the same review gate');
	});

	it('says nothing when there is nothing to say', async () => {
		expect(said(await dispatch('/lint'))).not.toContain('produced nothing');
	});
});

describe('/system show', () => {
	it('shows the archetype stats /init seeded, without a provider', async () => {
		// Worth pinning: `/init` seeds stats from the profile, which is why the
		// orphan check above cannot be built on "the corpus is empty".
		const result = await dispatch('/system show');

		expect(result.interview).toBeUndefined();
		expect(said(result)).toContain('strength');
	});

	it('reports a genuinely empty System rather than starting an interview', async () => {
		// The scaffold's system-01 is real content — a genuinely empty vault has
		// no named system at all, only the always-present empty legacy fallback.
		await rm(resolve(root, VAULT.systems, 'system-01.md'), {force: true});
		await refresh();

		const result = await dispatch('/system show');

		expect(result.interview).toBeUndefined();
		expect(said(result)).toContain('nothing defined yet');
	});

	it('shows stats, skills, and curves once they exist', async () => {
		// Isolate the legacy system so it is the vault's only one — otherwise
		// `/system show` with no id and two systems renders the summary list.
		await rm(resolve(root, VAULT.systems, 'system-01.md'), {force: true});
		await mkdir(resolve(root, VAULT.legacySetting), {recursive: true});
		await writeFile(
			resolve(root, VAULT.stats),
			stringifyDocument({data: {stats: [{id: 'memory', default: 10}]}, body: '\n'}),
			'utf8',
		);
		await writeFile(
			resolve(root, VAULT.curves),
			stringifyDocument({data: {xp_for_level: 'missing-curve'}, body: '\n'}),
			'utf8',
		);
		await refresh();

		const output = said(await dispatch('/system show'));

		expect(output).toContain('memory');
		// A curve naming a formula nobody defined is silently broken arithmetic.
		expect(output).toContain("no formula 'missing-curve' is defined");
	});
});

/**
 * `/system extract` retired along with the interview. Re-running extraction
 * over a saved transcript is now `/ingest interview`, which reads every
 * transcript under `raw/interviews/` the same way it reads any other kind's
 * raw notes.
 */
describe('/ingest interview', () => {
	it('refuses when there is no transcript to work from', async () => {
		expect(said(await dispatch('/ingest interview'))).toContain(
			`nothing to ingest — ${INTERVIEWS_DIR}/ has no markdown`,
		);
	});

	it('hands the transcript to the app rather than interviewing again', async () => {
		await saveTranscript(root, transcript('system', 5));
		await refresh();

		const result = await dispatch('/ingest interview');

		expect(result.ingest?.kind).toBe('interview');
		expect(result.interview).toBeUndefined();
		expect(said(result)).toContain(`ingesting 1 of 1 from ${INTERVIEWS_DIR}/`);
	});
});
