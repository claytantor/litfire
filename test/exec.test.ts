import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject} from '../source/core/project.js';
import {EXIT} from '../source/exec/envelope.js';
import {runApply} from '../source/exec/apply.js';
import {branchesOf, runExec} from '../source/exec/runner.js';
import {
	INTERACTIVE_BRANCHES,
	REFUSAL,
	type InteractiveBranch,
} from '../source/exec/tiers.js';
import {stateHash} from '../source/exec/serialise.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
const VERSION = '0.0.0-test';

/**
 * `/init` ships formulas and writes `consentedFormulaHash: null`, so a brand new
 * vault is unconsented — and exec fails closed on that by design. Every test
 * below is about something else, so they start from a vault whose author has
 * run `/consent`, which is the ordinary state.
 */
async function consent(): Promise<void> {
	const project = await computeProject(root);
	const file = resolve(root, VAULT.config);
	const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
	config['consentedFormulaHash'] = project.formulaHash;
	await writeFile(file, JSON.stringify(config), 'utf8');
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-exec-'));
	await scaffoldVault(root, 'arcane');
	await consent();
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

const run = async (argv: string[], extra: Record<string, unknown> = {}) =>
	runExec({root, argv, version: VERSION, ...extra});

/** Every file in the vault, by content hash — for asserting nothing moved. */
const snapshot = (): string =>
	execFileSync('sh', [
		'-c',
		`cd ${root} && find . -type f -exec md5sum {} + | sort`,
	]).toString();

describe('tier 1 — read-only commands', () => {
	it('returns a valid, versioned envelope', async () => {
		const {envelope, code} = await run(['/questions']);

		expect(code).toBe(EXIT.ok);
		expect(envelope.ok).toBe(true);
		expect(envelope.schemaVersion).toBe(1);
		expect(envelope.command).toBe('questions');
		expect(envelope.vault).toBe(root);
		expect(envelope.litfireVersion).toBe(VERSION);
		expect(envelope.dirty).toBe(false);
		expect(envelope.error).toBeUndefined();
		// The human rendering is kept, not replaced.
		expect(envelope.lines.length).toBeGreaterThan(0);
	});

	it('gives /questions and /lint real payloads, not scraped text', async () => {
		const questions = (await run(['/questions'])).envelope.data as {
			questions: {id: string; kind: string}[];
		};
		expect(Array.isArray(questions.questions)).toBe(true);
		expect(questions.questions[0]).toHaveProperty('kind');

		const lint = (await run(['/lint'])).envelope.data as Record<string, unknown>;
		for (const key of [
			'findings',
			'byKind',
			'parseFailures',
			'orphanedInterviews',
			'legacyLocations',
		]) {
			expect(lint, key).toHaveProperty(key);
		}
	});

	it('changes nothing in the vault but the log', async () => {
		const before = snapshot();
		await run(['/questions']);
		await run(['/lint']);
		await run(['/status', 'protagonist']);

		const changed = snapshot()
			.split('\n')
			.filter(line => !before.includes(line) && line.trim() !== '')
			.map(line => line.split(/\s+/)[1]);

		// The log is the one write, and it is deliberate: an agent touching the
		// vault belongs in the vault's own record.
		expect(changed).toEqual([`./${VAULT.log}`]);
	});

	it('records every invocation in the log', async () => {
		await run(['/status', 'protagonist']);
		const log = await readFile(resolve(root, VAULT.log), 'utf8');
		expect(log).toMatch(/exec \/status protagonist/);
	});
});

describe('the interactive branches', () => {
	/**
	 * One synthetic result per branch, so the table is walked exhaustively and
	 * cannot quietly stop covering one. Reaching some of them end-to-end needs a
	 * vault in a particular state — a provider configured, a second vault to
	 * switch to — and a test that silently stopped exercising a branch because a
	 * fixture changed would be worse than no test.
	 */
	const SYNTHETIC: Readonly<Record<InteractiveBranch, unknown>> = {
		confirm: {question: 'go?', proceed: {lines: []}},
		ingest: {kind: 'character'},
		generateStats: {system: 'system-01', what: 'stats'},
		adopt: {proposals: [], title: 'x'},
		curator: true,
		reviewer: true,
		interview: {kind: 'character'},
		wizard: 'provider',
		openEditor: '/tmp/x.md',
		switchProject: '/tmp/elsewhere',
		exit: true,
	};

	it.each(INTERACTIVE_BRANCHES)('detects and explains %s', branch => {
		const result = {lines: [], [branch]: SYNTHETIC[branch]} as never;
		expect(branchesOf(result)).toContain(branch);
		// A refusal reason for every branch, so none can be answered with silence.
		expect(REFUSAL[branch]).toMatch(/\S/);
	});

	it('sees an interview hiding behind a confirm', () => {
		const wrapped = {
			lines: [],
			confirm: {question: 'go?', proceed: {lines: [], interview: {kind: 'character'}}},
		} as never;
		expect(branchesOf(wrapped)).toEqual(expect.arrayContaining(['confirm', 'interview']));
	});

	it('exits 3 on a branch it can reach end to end', async () => {
		// A real second vault, so `/project` gets as far as returning the branch
		// rather than stopping at "that path does not exist".
		const other = await mkdtemp(path.join(tmpdir(), 'litfire-other-'));
		await scaffoldVault(other, 'arcane');

		const {code, envelope} = await run(['/project', other]);
		expect(code).toBe(EXIT.refused);
		expect(envelope.error?.reason).toMatch(/switching projects/);

		await rm(other, {recursive: true, force: true});
	});

	it('exits 3 on an interview, and --yes does not unlock it', async () => {
		// `/questions <kind>` checks for a provider before it offers the
		// interview, so one has to exist for the branch to be reachable at all.
		const file = resolve(root, VAULT.config);
		const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
		config['provider'] = {id: 'anthropic', model: 'claude-sonnet-5'};
		await writeFile(file, JSON.stringify(config), 'utf8');

		for (const options of [{}, {yes: true}]) {
			const {code, envelope} = await run(['/questions', 'character'], options);
			expect(code).toBe(EXIT.refused);
			// Refused for the interview, not the confirm it was wrapped in — so
			// answering the question is not permission for what it was guarding.
			expect(envelope.error?.reason).toMatch(/interview/);
		}
	});

	it.each([['/curator'], ['/reviewer'], ['/provider'], ['/export'], ['/init']])(
		'refuses %s, which is on no tier at all',
		async name => {
			const {code, envelope} = await run([name]);
			expect(code).toBe(EXIT.refused);
			expect(envelope.error?.remedy).toMatch(/run litfire/);
		},
	);
});

describe('the derived-write tier', () => {
	it('refuses /wiki build without the explicit flag', async () => {
		const {code, envelope} = await run(['/wiki', 'build']);
		expect(code).toBe(EXIT.refused);
		expect(envelope.error?.remedy).toMatch(/--allow-derived-write/);
	});

	it('runs it with the flag', async () => {
		const {code} = await run(['/wiki', 'build'], {allowDerivedWrite: true});
		expect(code).toBe(EXIT.ok);
	});
});

describe('consent', () => {
	it('fails closed when formulas are not consented, and says what to run', async () => {
		const file = resolve(root, VAULT.config);
		const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
		config['consentedFormulaHash'] = null;
		await writeFile(file, JSON.stringify(config), 'utf8');

		const {code, envelope} = await run(['/questions']);
		expect(code).toBe(EXIT.consentRequired);
		expect(envelope.error?.remedy).toMatch(/\/consent/);
	});
});

describe('review apply — tier 3', () => {
	const batchFile = () => path.join(root, '..', `batch-${path.basename(root)}.json`);

	const writeBatch = async (
		items: {path: string; contents: string; existing?: string}[],
	) => {
		const file = batchFile();
		await writeFile(
			file,
			JSON.stringify({
				batchVersion: 1,
				vault: root,
				title: 'test',
				createdAt: '2026-01-01T00:00:00.000Z',
				items: items.map((item, index) => ({
					index: index + 1,
					proposal: {path: item.path, contents: item.contents},
					existing: item.existing ?? null,
					diff: [],
					stat: {added: 1, removed: 0},
					stateHash: stateHash(item.existing),
				})),
			}),
			'utf8',
		);
		return file;
	};

	it('writes only what was named', async () => {
		const file = await writeBatch([
			{path: 'corpus/places/one.md', contents: '# One\n'},
			{path: 'corpus/places/two.md', contents: '# Two\n'},
		]);

		const {code, envelope} = await runApply({
			batchFile: file,
			accept: [1],
			acceptAll: undefined,
			version: VERSION,
		});

		expect(code).toBe(EXIT.ok);
		expect((envelope.data as {written: string[]}).written).toEqual([
			'corpus/places/one.md',
		]);
		// The one not named never reached disk.
		await expect(
			readFile(resolve(root, 'corpus/places/two.md'), 'utf8'),
		).rejects.toThrow();
	});

	/** The constraint the whole design is built around. */
	it('refuses a proposal targeting raw/', async () => {
		const file = await writeBatch([{path: 'raw/places/sneaky.md', contents: '# no\n'}]);

		const {code, envelope} = await runApply({
			batchFile: file,
			accept: [],
			acceptAll: 1,
			version: VERSION,
		});

		expect(code).toBe(EXIT.commandError);
		const outcome = envelope.data as {failed: {path: string; reason: string}[]};
		expect(outcome.failed[0]?.reason).toMatch(/raw\/ is not author-writable/);
		await expect(
			readFile(resolve(root, 'raw/places/sneaky.md'), 'utf8'),
		).rejects.toThrow();
	});

	it('refuses every other closed directory too', async () => {
		const file = await writeBatch([
			{path: 'ledger/state.md', contents: 'x'},
			{path: 'wiki/index.md', contents: 'x'},
			{path: '.litrpg/config.md', contents: 'x'},
			{path: '../escape.md', contents: 'x'},
		]);

		const {envelope} = await runApply({
			batchFile: file,
			accept: [],
			acceptAll: 4,
			version: VERSION,
		});
		expect((envelope.data as {failed: unknown[]}).failed).toHaveLength(4);
		expect((envelope.data as {written: unknown[]}).written).toHaveLength(0);
	});

	it('refuses a stale batch rather than overwriting', async () => {
		await writeFile(resolve(root, 'corpus/places/one.md'), '# original\n', 'utf8');
		const file = await writeBatch([
			{path: 'corpus/places/one.md', contents: '# proposed\n', existing: '# original\n'},
		]);

		// Somebody else edits the target between propose and apply.
		await writeFile(resolve(root, 'corpus/places/one.md'), '# theirs\n', 'utf8');

		const {code, envelope} = await runApply({
			batchFile: file,
			accept: [1],
			acceptAll: undefined,
			version: VERSION,
		});

		expect(code).toBe(EXIT.staleBatch);
		expect((envelope.data as {stale: {path: string}[]}).stale[0]?.path).toBe(
			'corpus/places/one.md',
		);
		// Their edit survived.
		expect(await readFile(resolve(root, 'corpus/places/one.md'), 'utf8')).toBe(
			'# theirs\n',
		);
	});

	/**
	 * Absent and empty must not hash alike: a proposal for a file that did not
	 * exist, applied after something else created it, would otherwise overwrite
	 * work nobody reviewed.
	 */
	it('treats a file appearing since propose time as stale', async () => {
		const file = await writeBatch([{path: 'corpus/places/new.md', contents: '# mine\n'}]);
		await writeFile(resolve(root, 'corpus/places/new.md'), '', 'utf8');

		const {code} = await runApply({
			batchFile: file,
			accept: [1],
			acceptAll: undefined,
			version: VERSION,
		});
		expect(code).toBe(EXIT.staleBatch);
		expect(stateHash(undefined)).not.toBe(stateHash(''));
	});

	it('rejects an index that is not in the batch', async () => {
		const file = await writeBatch([{path: 'corpus/places/one.md', contents: 'x'}]);
		const {code} = await runApply({
			batchFile: file,
			accept: [9],
			acceptAll: undefined,
			version: VERSION,
		});
		expect(code).toBe(EXIT.usageError);
	});

	/**
	 * `--accept-all` was a bare boolean, which made it the one flag an agent
	 * could pass without knowing what it covered. The count turns it into an
	 * assertion about the file in hand.
	 */
	it('applies everything when the count is right', async () => {
		const file = await writeBatch([
			{path: 'corpus/places/one.md', contents: '# One\n'},
			{path: 'corpus/places/two.md', contents: '# Two\n'},
		]);

		const {code, envelope} = await runApply({
			batchFile: file,
			accept: [],
			acceptAll: 2,
			version: VERSION,
		});

		expect(code).toBe(EXIT.ok);
		expect((envelope.data as {written: string[]}).written).toHaveLength(2);
	});

	it('refuses a count that does not match, and writes nothing', async () => {
		const file = await writeBatch([
			{path: 'corpus/places/one.md', contents: '# One\n'},
			{path: 'corpus/places/two.md', contents: '# Two\n'},
		]);

		const {code, envelope} = await runApply({
			batchFile: file,
			accept: [],
			acceptAll: 3,
			version: VERSION,
		});

		expect(code).toBe(EXIT.usageError);
		expect(envelope.error?.reason).toMatch(/has 2 item\(s\)/);
		// The whole point: a wrong assertion applies nothing at all, rather than
		// applying whatever happened to be there.
		await expect(
			readFile(resolve(root, 'corpus/places/one.md'), 'utf8'),
		).rejects.toThrow();
	});

	it('needs an explicit choice', async () => {
		const file = await writeBatch([{path: 'corpus/places/one.md', contents: 'x'}]);
		const {code, envelope} = await runApply({
			batchFile: file,
			accept: [],
			acceptAll: undefined,
			version: VERSION,
		});
		expect(code).toBe(EXIT.usageError);
		expect(envelope.error?.reason).toMatch(/nothing accepted/);
	});
});
