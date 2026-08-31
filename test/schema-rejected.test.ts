import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import {computeProject} from '../source/core/project.js';
import {loadVault} from '../source/vault/load.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-rejected-'));
	await scaffoldVault(root, 'arcane');
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

const put = async (relative: string, frontmatter: string) => {
	await writeFile(
		resolve(root, relative),
		`---\n${frontmatter}\n---\n\nThe scene body.\n`,
		'utf8',
	);
};

const say = async (name: string) => {
	const project = await computeProject(root);
	const result = await findCommand(name)!.run([], {
		root,
		project,
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	});
	return result.lines.map(line => line.text).join('\n');
};

/**
 * The bug: a page whose frontmatter fails schema validation is dropped from the
 * model, so it has no timeline entry, no wiki page and no cross-references —
 * and until now the queue an author works never mentioned it. The way to find
 * out was to notice something missing.
 *
 * `TODO` is the vault's own convention for "decision pending", and ingest
 * copies author frontmatter verbatim, so it lands in typed fields routinely.
 */
describe('a page the loader rejects', () => {
	const REJECTED = `${VAULT.situations}/ancestors-addressed-shrines.md`;

	beforeEach(async () => {
		await put(
			REJECTED,
			['id: ancestors-addressed-shrines', 'arc: arc-01', 'order: TODO'].join('\n'),
		);
	});

	it('is absent from the model, as it always was', async () => {
		const vault = await loadVault(root);
		expect(vault.situations.map(one => one.id)).not.toContain(
			'ancestors-addressed-shrines',
		);
	});

	it('names the file, the field, what was expected and what was found', async () => {
		const vault = await loadVault(root);
		const issue = vault.issues[0]!;

		expect(issue.file).toBe(REJECTED);
		expect(issue.fields).toEqual(['order']);
		expect(issue.message).toBe("order: expected number, found 'TODO'");
	});

	it('reports the path vault-relative, like every other finding', async () => {
		const vault = await loadVault(root);
		// It used to be absolute, so it matched nothing else on screen.
		expect(vault.issues[0]!.file.startsWith('/')).toBe(false);
		expect(path.isAbsolute(vault.issues[0]!.file)).toBe(false);
	});

	it('becomes an open question', async () => {
		const project = await computeProject(root);
		const found = project.questions.find(one => one.kind === 'schema_rejected');

		expect(found).toBeDefined();
		expect(found!.where).toBe(REJECTED);
		expect(found!.detail).toContain("order: expected number, found 'TODO'");
		// The consequence, not just the cause: the page is gone from everything.
		expect(found!.detail).toMatch(/not loaded/);
	});

	it('appears in /questions and in /lint', async () => {
		expect(await say('questions')).toContain('schema_rejected');

		const lint = await say('lint');
		expect(lint).toContain(REJECTED);
		expect(lint).toContain("order: expected number, found 'TODO'");
		// The old rendering took `split('\n')[0]` of zod's pretty-printed JSON,
		// which is the single character `[` — a line that names a file and says
		// nothing, while looking like it said something.
		expect(lint).not.toMatch(/\.md: \[$/m);
	});
});

describe('what the diagnostic says for other bad values', () => {
	it('reports a malformed id against the rule it broke', async () => {
		await put(`${VAULT.places}/bad.md`, 'id: Not_An_Id');
		const vault = await loadVault(root);
		expect(vault.issues[0]!.message).toContain('id:');
		expect(vault.issues[0]!.message).toContain('kebab-case');
		expect(vault.issues[0]!.message).toContain("found 'Not_An_Id'");
	});

	it('reports a wrong container type', async () => {
		await put(`${VAULT.situations}/x.md`, ['id: x', 'characters: inanna'].join('\n'));
		const vault = await loadVault(root);
		expect(vault.issues[0]!.message).toBe("characters: expected array, found 'inanna'");
	});

	it('reports every bad field, not only the first', async () => {
		await put(
			`${VAULT.situations}/y.md`,
			['id: y', 'order: TODO', 'characters: nobody'].join('\n'),
		);
		const vault = await loadVault(root);
		expect(vault.issues[0]!.fields).toEqual(['order', 'characters']);
	});

	/**
	 * The formatter runs only when something has already gone wrong, so it has to
	 * be total. `JSON.stringify` is not: a moment's `at` is a bigint, which it
	 * refuses outright — and an out-of-range instant is exactly one of the things
	 * that fails to parse. A formatter that throws turns a reportable page into a
	 * crashed load.
	 */
	it('survives a value JSON cannot serialise', async () => {
		await put(
			`${VAULT.moments}/huge.md`,
			['id: huge', 'at: 99999999999999999999999999'].join('\n'),
		);
		await expect(loadVault(root)).resolves.toBeDefined();
		const vault = await loadVault(root);
		expect(vault.issues[0]!.message).toMatch(/at:/);
	});
});

describe('a valid page is unaffected', () => {
	it('still loads, and raises no rejection', async () => {
		await put(
			`${VAULT.situations}/sit-900.md`,
			['id: sit-900', 'title: Fine', 'arc: arc-01', 'order: 20'].join('\n'),
		);

		const project = await computeProject(root);
		expect(project.vault.situations.map(one => one.id)).toContain('sit-900');
		expect(project.vault.issues).toEqual([]);
		expect(project.questions.filter(one => one.kind === 'schema_rejected')).toEqual([]);
	});
});
