import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import * as llm from '../source/llm/index.js';
import {saveProvider} from '../source/vault/config.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-provider-'));
	await scaffoldVault(root);
	context = {
		root,
		project: await computeProject(root),
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	};
});

afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, {recursive: true, force: true});
});

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

const run = async (line: string) => {
	const [head = '', ...args] = line.trim().split(/\s+/);
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
};

function keyAccepts(models: string[]) {
	vi.spyOn(llm, 'verifyStoredKey').mockResolvedValue({
		outcome: {ok: true, models: models.map(id => ({id}))},
		resolved: {key: 'sk-test', source: 'file'},
	} as never);
}

/**
 * A key can be perfectly good against a model the account cannot reach, and
 * that fails at request time — long after a test reporting only "key accepted,
 * 4 models available" said everything was fine.
 */
describe('/provider test says whether your model is one of them', () => {
	it('names the models rather than counting them', async () => {
		await saveProvider(root, {id: 'kimi-code', model: 'k3-256k'});
		keyAccepts(['k3', 'k3-256k', 'kimi-for-coding']);

		const output = said(await run('/provider test'));

		expect(output).toContain('3 model(s) available');
		expect(output).toContain('k3-256k');
		expect(output).toContain('kimi-for-coding');
	});

	it('confirms the configured model when the key can reach it', async () => {
		await saveProvider(root, {id: 'kimi-code', model: 'k3-256k'});
		keyAccepts(['k3', 'k3-256k']);

		expect(said(await run('/provider test'))).toContain(
			'this vault is set to k3-256k, and it is available',
		);
	});

	it('says so plainly when it cannot, and how to fix it', async () => {
		await saveProvider(root, {id: 'kimi-code', model: 'k3-256k'});
		keyAccepts(['k3', 'kimi-for-coding']);

		const output = said(await run('/provider test'));

		expect(output).toContain('this vault is set to k3-256k, which this key cannot reach');
		expect(output).toContain('/provider picks one');
	});

	it('says nothing about the vault when testing some other provider', async () => {
		await saveProvider(root, {id: 'kimi-code', model: 'k3-256k'});
		keyAccepts(['gpt-4o']);

		// `/provider test openai` asks about that key, not about this vault's
		// choice — reporting a mismatch here would be answering a different
		// question than the one asked.
		expect(said(await run('/provider test openai'))).not.toContain('this vault is set to');
	});
});
