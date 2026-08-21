import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext, CommandResult} from '../source/commands/types.js';
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

/**
 * `/questions <kind>` starts the interview directly when the checks have
 * something open to ask about, and otherwise offers it behind a
 * confirmation (§`/questions <kind>, with nothing to ask about` in
 * `questions-command.test.ts`). Either way, this is the interview that would
 * actually run — which is what these tests care about, not which of the two
 * paths a freshly scaffolded vault happens to take for a given kind.
 */
const interviewOf = (result: CommandResult) =>
	result.interview ?? result.confirm?.proceed.interview;

/**
 * `/system`, `/character`, `/timeline` and `/themes` used to be four separate
 * interviews. `/questions <kind>` replaced all four with one entry point, so
 * every case that used to dispatch a bespoke command now dispatches
 * `/questions` with that kind instead — `timeline` becomes `moment` and
 * `themes` becomes `theme`, since those are what the retired briefs split
 * into.
 */
describe('every retired interview command routes through /questions now', () => {
	const cases: [string, string, string | undefined][] = [
		// A lone system is focused without being asked, which the retired
		// `/system` also did: one system is not a choice, and naming it keeps
		// every transcript in the same namespace as a vault that has several.
		['/questions system', 'system', 'system-01'],
		['/questions system the-lathe', 'system', 'the-lathe'],
		['/questions moment', 'moment', undefined],
		['/questions character protagonist', 'character', 'protagonist'],
		['/questions theme', 'theme', undefined],
	];

	for (const [line, kind, focus] of cases) {
		it(`${line} → ${kind}`, async () => {
			const result = await dispatch(line);
			const interview = interviewOf(result);

			expect(interview).toBeDefined();
			expect(interview?.kind).toBe(kind);
			expect(interview?.focus).toBe(focus);
		});
	}

	/**
	 * The one disambiguation the old `/character` command had to make that
	 * `/questions character` still has to make: a bare directive is not a name.
	 */
	it('/questions character resume does not mistake resume for a character name', async () => {
		const result = await dispatch('/questions character resume');

		expect(result.interview).toEqual({kind: 'character', resume: true});
	});
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

		for (const line of ['/questions system', '/questions moment', '/questions theme']) {
			const [head = '', ...args] = line.trim().split(/\s+/);
			const result = await findCommand(head.replace(/^\//, ''))!.run(args, bareContext);

			expect(result.interview).toBeUndefined();
			expect(result.confirm).toBeUndefined();
			expect(result.lines.map(l => l.text).join(' ')).toContain('/provider');
		}

		await rm(bare, {recursive: true, force: true});
	});

	it('interviews refuse when there is no vault at all', async () => {
		const result = await findCommand('questions')!.run(['system'], {
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

	/**
	 * The four no longer share a directive form — two are plain views and two
	 * are namespaced views — so there is nothing left to assert they agree on.
	 * What replaced that guarantee is a single entry point for every kind, and
	 * `/help` has to say so.
	 */
	it('/help shows the plain view usage for the four retired commands, and /questions as the one interview entry point', async () => {
		const rendered = (await dispatch('/help')).lines.map(l => l.text).join('\n');

		for (const line of [
			'/system [<id>]',
			'/timeline',
			'/themes',
			'/character <name>',
			'/questions [<kind>] [<id>] [resume|new]',
		]) {
			expect(rendered).toContain(line);
		}
	});
});

/**
 * `/system`, `/timeline` and `/themes` all still tolerate a trailing `show` —
 * ignored as a positional rather than treated as an id or an error — so a
 * stray `show` from muscle memory still renders the view rather than erroring.
 */
describe('the retired commands still tolerate `show`', () => {
	const said = (result: CommandResult) => result.lines.map(line => line.text).join('\n');

	for (const line of ['/system show', '/timeline show', '/themes show']) {
		it(`${line} renders a view instead of interviewing`, async () => {
			const result = await dispatch(line);

			expect(result.interview).toBeUndefined();
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

	it('bare /timeline and /themes still render their view', async () => {
		expect((await dispatch('/timeline')).interview).toBeUndefined();
		expect((await dispatch('/themes')).interview).toBeUndefined();
	});
});
