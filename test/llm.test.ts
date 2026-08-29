import {chmod, mkdtemp, readFile, rm, stat, writeFile as write} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	baseUrlEnvVar,
	findProvider,
	LOCAL_BASE_URLS,
	PROVIDERS,
} from '../source/llm/catalog.js';
import {
	credentialsPath,
	forgetKey,
	keyFileEnvVar,
	maskKey,
	resolveKey,
	saveKey,
} from '../source/llm/credentials.js';
import {
	loadProvider,
	PLACEHOLDER_KEY,
	testConnection,
	verifyStoredKey,
} from '../source/llm/index.js';

let configHome = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
	configHome = await mkdtemp(path.join(tmpdir(), 'litfire-cfg-'));
	savedEnv['XDG_CONFIG_HOME'] = process.env['XDG_CONFIG_HOME'];
	process.env['XDG_CONFIG_HOME'] = configHome;
	for (const spec of PROVIDERS) {
		savedEnv[spec.envVar] = process.env[spec.envVar];
		delete process.env[spec.envVar];
	}
});

afterEach(async () => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	await rm(configHome, {recursive: true, force: true});
});

describe('catalog', () => {
	it('covers the requested providers, with both Kimi hosts and a local one', () => {
		expect(PROVIDERS.map(p => p.id).toSorted()).toEqual([
			'anthropic',
			'kimi',
			'kimi-code',
			'local',
			'openai',
			'together',
		]);
	});

	it('keeps the two Kimi products on separate hosts and env vars', () => {
		const platform = findProvider('kimi');
		const code = findProvider('kimi-code');

		// A subscription key is rejected by the Moonshot platform host and vice
		// versa, so they must never collapse into one entry.
		expect(platform.baseUrl).toContain('moonshot.ai');
		// kimi.ai, not kimi.com: the two answer identically but .com is the
		// mainland-China front door, so the international host is the default.
		expect(code.baseUrl).toBe('https://api.kimi.ai/coding/v1');
		expect(code.keysUrl).toContain('kimi.ai');
		expect(platform.envVar).not.toBe(code.envVar);
	});

	it('never points a user at the mainland-China host', () => {
		// The default must be kimi.ai end to end: host, keys link, and hint. The
		// .com host stays available through LITFIRE_KIMI_CODE_BASE_URL.
		const code = findProvider('kimi-code');
		for (const surface of [
			code.baseUrl,
			code.keysUrl,
			code.label,
			code.note ?? '',
			code.authHint ?? '',
		]) {
			expect(surface).not.toContain('kimi.com');
		}
	});

	it('labels the two Kimi entries by how you pay for them', () => {
		// The choice a user has to make is "subscription or API key", so that is
		// what the list has to say — "Kimi" and "Kimi Code" are indistinguishable
		// to anyone who has not already read the docs.
		expect(findProvider('kimi').label).toMatch(/api key/i);
		expect(findProvider('kimi-code').label).toMatch(/subscription/i);
	});

	it('points each Kimi entry at the other when a key is refused', () => {
		// The usual auth failure here is a good key against the wrong entry, and
		// "check the API key" sends someone to the one place nothing is wrong.
		expect(findProvider('kimi').authHint).toMatch(/kimi code/i);
		expect(findProvider('kimi-code').authHint).toMatch(/moonshot/i);
	});

	it('produces a base-URL override a shell can actually export', () => {
		// `LITFIRE_KIMI-CODE_BASE_URL` is not a name bash will take, which would
		// have left the one provider most likely to need a host override with an
		// escape hatch nobody could use.
		expect(baseUrlEnvVar('kimi-code')).toBe('LITFIRE_KIMI_CODE_BASE_URL');
		expect(baseUrlEnvVar('kimi-code')).not.toContain('-');
		expect(baseUrlEnvVar('openai')).toBe('LITFIRE_OPENAI_BASE_URL');
	});

	it('offers k3 on the subscription and kimi-k3 on the platform', () => {
		// The same model carries different ids on the two products.
		expect(findProvider('kimi-code').suggestedModels).toContain('k3');
		expect(findProvider('kimi').suggestedModels).toContain('kimi-k3');
	});

	it('gives every provider an output budget, and Kimi Code the largest', () => {
		// The budget the *answer* comes out of, not the context window. Measured
		// against a 30-exchange interview: at 8192 the extraction JSON was cut
		// mid-string and surfaced as a parse error blaming the parser.
		for (const spec of PROVIDERS.filter(p => p.id !== 'anthropic')) {
			expect(spec.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(8192);
		}
		// Thinking-only models draw reasoning from the same budget — 50k
		// characters of it on that transcript — so this one needs the most room.
		expect(findProvider('kimi-code').maxOutputTokens).toBeGreaterThanOrEqual(32_768);
	});

	it('uses anthropic auth only for anthropic', () => {
		for (const spec of PROVIDERS) {
			expect(spec.auth).toBe(spec.id === 'anthropic' ? 'anthropic' : 'bearer');
		}
	});
});

describe('credentials', () => {
	it('stores keys outside the vault, at 0600', async () => {
		const file = await saveKey('openai', 'sk-secret-value');

		// The critical property: not inside any vault directory.
		expect(file.startsWith(configHome)).toBe(true);
		expect(file).not.toContain('.litrpg');

		const mode = (await stat(file)).mode & 0o777;
		expect(mode).toBe(0o600);
		expect(await readFile(file, 'utf8')).toContain('sk-secret-value');
	});

	it('round-trips a stored key', async () => {
		await saveKey('together', 'together-key');

		const resolved = await resolveKey('together');
		expect(resolved.key).toBe('together-key');
		expect(resolved.source).toBe('stored');
	});

	it('prefers the environment variable over a stored key', async () => {
		await saveKey('openai', 'stored-key');
		process.env[findProvider('openai').envVar] = 'env-key';

		const resolved = await resolveKey('openai');
		expect(resolved.key).toBe('env-key');
		expect(resolved.source).toBe('env');
	});

	it('reports a missing key rather than throwing', async () => {
		const resolved = await resolveKey('kimi');

		expect(resolved.key).toBeUndefined();
		expect(resolved.source).toBe('missing');
		expect(resolved.envVar).toBe('MOONSHOT_API_KEY');
	});

	it('keeps providers independent and forgets one at a time', async () => {
		await saveKey('openai', 'a');
		await saveKey('anthropic', 'b');
		await forgetKey('openai');

		expect((await resolveKey('openai')).key).toBeUndefined();
		expect((await resolveKey('anthropic')).key).toBe('b');
	});

	it('survives a corrupt credentials file', async () => {
		await saveKey('openai', 'a');
		const {writeFile} = await import('node:fs/promises');
		await writeFile(credentialsPath(), 'not json at all', 'utf8');

		expect((await resolveKey('openai')).key).toBeUndefined();
	});

	it('never renders a raw key', () => {
		expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-a…mnop');
		expect(maskKey('short')).toBe('•••••');
		expect(maskKey('sk-abcdefghijklmnop')).not.toContain('efghij');
	});
});

/**
 * These hit the real endpoints with a deliberately invalid key. They assert the
 * failure path — that a bad key is reported clearly rather than crashing — which
 * is the path users actually hit when they mistype a key.
 *
 * Opt-in via `LITFIRE_LIVE_TESTS=1`. They are worth having and they are not
 * worth firing at four companies' APIs from a shared CI address on every pull
 * request, or making a contributor's first `pnpm test` depend on the network.
 * Run them before touching anything in `source/llm/`.
 */
const live = process.env['LITFIRE_LIVE_TESTS'] === '1' ? describe : describe.skip;

live('testConnection against live endpoints (invalid key)', () => {
	const cases = [
		{id: 'openai', match: /401|invalid|incorrect/i},
		{id: 'together', match: /401|unauthor/i},
		{id: 'kimi', match: /401|auth/i},
		{id: 'kimi-code', match: /401|auth|unauthor/i},
		{id: 'anthropic', match: /401|invalid/i},
	] as const;

	for (const {id, match} of cases) {
		it(`${id} rejects a bad key with a readable reason`, async () => {
			const outcome = await testConnection({id, apiKey: 'definitely-not-valid'});

			expect(outcome.ok).toBe(false);
			if (!outcome.ok) {
				expect(outcome.reason).toMatch(match);
				// A spec that carries its own auth hint replaces the generic one.
				expect(outcome.hint).toBe(findProvider(id).authHint ?? 'check the API key');
			}
		}, 30_000);
	}

	it('tells a refused Kimi key which entry it probably belongs to', async () => {
		const outcome = await testConnection({
			id: 'kimi-code',
			apiKey: 'definitely-not-valid',
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.hint).toContain('kimi.ai/code');
			// The China host is a documented override, never something the app
			// suggests to an American user who simply pasted the wrong key.
			expect(outcome.hint).not.toContain('kimi.com');
		}
	}, 30_000);

	it('reports an unreachable base URL without hanging', async () => {
		const outcome = await testConnection({
			id: 'openai',
			apiKey: 'x',
			baseUrl: 'http://127.0.0.1:9/v1',
		});

		expect(outcome.ok).toBe(false);
	}, 30_000);
});

describe('key files', () => {
	let secrets = '';

	beforeEach(async () => {
		secrets = await mkdtemp(path.join(tmpdir(), 'litfire-secrets-'));
	});

	afterEach(async () => {
		await rm(secrets, {recursive: true, force: true});
		delete process.env['KIMI_CODE_API_KEY'];
		delete process.env['KIMI_CODE_API_KEY_FILE'];
	});

	const writeSecret = async (body: string, mode = 0o600) => {
		const file = path.join(secrets, 'kimi-api-key');
		await write(file, body, {encoding: 'utf8', mode});
		await chmod(file, mode);
		return file;
	};

	it('names the file variant off the provider env var', () => {
		expect(keyFileEnvVar('kimi-code')).toBe('KIMI_CODE_API_KEY_FILE');
		expect(keyFileEnvVar('anthropic')).toBe('ANTHROPIC_API_KEY_FILE');
	});

	it('reads the key from the file, trailing newline and all', async () => {
		process.env['KIMI_CODE_API_KEY_FILE'] = await writeSecret('sk-kimi-from-a-file\n');
		const resolved = await resolveKey('kimi-code');

		expect(resolved.key).toBe('sk-kimi-from-a-file');
		expect(resolved.source).toBe('file');
		expect(resolved.path).toContain('kimi-api-key');
		expect(resolved.problem).toBeUndefined();
	});

	it('expands a leading ~, which no shell was there to expand', async () => {
		const file = await writeSecret('sk-kimi-tilde');
		// Simulates a value written into a config file rather than typed at a
		// prompt: `~` arrives literally.
		process.env['KIMI_CODE_API_KEY_FILE'] = file.replace(homedir(), '~');

		const resolved = await resolveKey('kimi-code');
		// Only meaningful if the temp dir really is under $HOME; otherwise the
		// replace was a no-op and this still asserts the plain path works.
		expect(resolved.key).toBe('sk-kimi-tilde');
	});

	it('lets a literal env var win, so a one-off override still works', async () => {
		process.env['KIMI_CODE_API_KEY_FILE'] = await writeSecret('sk-kimi-from-a-file');
		process.env['KIMI_CODE_API_KEY'] = 'sk-kimi-one-off';

		const resolved = await resolveKey('kimi-code');
		expect(resolved.key).toBe('sk-kimi-one-off');
		expect(resolved.source).toBe('env');
	});

	it('reports an unreadable path instead of looking like no key at all', async () => {
		process.env['KIMI_CODE_API_KEY_FILE'] = path.join(secrets, 'not-here');
		const resolved = await resolveKey('kimi-code');

		expect(resolved.key).toBeUndefined();
		expect(resolved.problem).toContain('cannot be read');
		expect(resolved.problem).toContain('KIMI_CODE_API_KEY_FILE');
	});

	it('falls through to a stored key rather than locking anyone out', async () => {
		await saveKey('kimi-code', 'sk-kimi-stored');
		process.env['KIMI_CODE_API_KEY_FILE'] = path.join(secrets, 'not-here');

		const resolved = await resolveKey('kimi-code');
		expect(resolved.key).toBe('sk-kimi-stored');
		expect(resolved.source).toBe('stored');
		// Reported anyway — the typo is still a typo (P4).
		expect(resolved.problem).toContain('cannot be read');
	});

	it('says so when the key file is readable by other users', async () => {
		process.env['KIMI_CODE_API_KEY_FILE'] = await writeSecret('sk-kimi-loose', 0o644);
		const resolved = await resolveKey('kimi-code');

		expect(resolved.key).toBe('sk-kimi-loose');
		expect(resolved.problem).toContain('chmod 600');
	});

	it('shows the file as the source in /provider status, masked', async () => {
		process.env['KIMI_CODE_API_KEY_FILE'] = await writeSecret('sk-kimi-abcdefghij');
		const {findCommand} = await import('../source/commands/registry.js');

		const rendered = (
			await findCommand('provider')!.run(['status'], {
				root: configHome,
				project: undefined,
				activeCharacter: undefined,
				setActiveCharacter: () => {},
				consentFormulas: () => {},
			})
		).lines
			.map(l => l.text)
			.join('\n');

		expect(rendered).toContain('kimi-api-key');
		expect(rendered).toContain('sk-k…ghij');
		expect(rendered).not.toContain('sk-kimi-abcdefghij');
	});
});

describe('/provider command', () => {
	it('opens the wizard with no arguments', async () => {
		const {findCommand} = await import('../source/commands/registry.js');
		const command = findCommand('provider');
		expect(command).toBeDefined();

		const result = await command!.run([], {
			root: configHome,
			project: undefined,
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		});

		expect(result.wizard).toBe('provider');
	});

	const dispatch = async (args: string[]) => {
		const {findCommand} = await import('../source/commands/registry.js');
		return findCommand('provider')!.run(args, {
			root: configHome,
			project: undefined,
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		});
	};

	it('test says plainly when there is no key to verify', async () => {
		const rendered = (await dispatch(['test', 'kimi-code'])).lines
			.map(l => l.text)
			.join('\n');

		expect(rendered).toContain('Kimi Code');
		expect(rendered).toContain('no key stored');
		expect(rendered).toContain('KIMI_CODE_API_KEY');
	});

	it('test re-checks a stored key and names the entry it belongs to', async () => {
		await saveKey('kimi-code', 'definitely-not-valid');
		// Named explicitly; the bare form falls back to the vault's chosen provider.
		const rendered = (await dispatch(['test', 'kimi-code'])).lines
			.map(l => l.text)
			.join('\n');

		// Shows what it tested against, masked, and why it failed.
		expect(rendered).toContain('https://api.kimi.ai/coding/v1');
		expect(rendered).toContain('defi…alid');
		expect(rendered).toContain('kimi.ai/code');
		expect(rendered).not.toContain('definitely-not-valid');
	}, 30_000);

	it('test refuses an unknown provider id', async () => {
		const rendered = (await dispatch(['test', 'not-a-provider'])).lines
			.map(l => l.text)
			.join('\n');
		expect(rendered).toContain('usage: /provider test');
	});

	it('verifyStoredKey reports the source of the key it used', async () => {
		await saveKey('together', 'definitely-not-valid');
		const {resolved, outcome} = await verifyStoredKey('together');

		expect(resolved.source).toBe('stored');
		expect(outcome.ok).toBe(false);
	}, 30_000);

	it('status lists all four providers and masks stored keys', async () => {
		const {findCommand} = await import('../source/commands/registry.js');
		await saveKey('openai', 'sk-abcdefghijklmnop');

		const result = await findCommand('provider')!.run(['status'], {
			root: configHome,
			project: undefined,
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		});

		const rendered = result.lines.map(l => l.text).join('\n');
		for (const label of ['Anthropic Claude', 'OpenAI', 'Together AI', 'Kimi']) {
			expect(rendered).toContain(label);
		}
		expect(rendered).toContain('sk-a…mnop');
		expect(rendered).not.toContain('sk-abcdefghijklmnop');
		expect(rendered).toContain('no key');
	});

	it('clear removes only the named provider key', async () => {
		const {findCommand} = await import('../source/commands/registry.js');
		await saveKey('openai', 'a');
		await saveKey('kimi', 'b');

		await findCommand('provider')!.run(['clear', 'openai'], {
			root: configHome,
			project: undefined,
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		});

		expect((await resolveKey('openai')).key).toBeUndefined();
		expect((await resolveKey('kimi')).key).toBe('b');
	});

	it('rejects clear with an unknown provider', async () => {
		const {findCommand} = await import('../source/commands/registry.js');
		const result = await findCommand('provider')!.run(['clear', 'bogus'], {
			root: configHome,
			project: undefined,
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		});

		expect(result.lines[0]?.text).toContain('usage:');
	});
});

/**
 * §9 requires "any local OpenAI-compatible endpoint". Ollama, llama.cpp,
 * LM Studio and vLLM differ in exactly one thing — the port — so they are one
 * catalog entry rather than four, and what makes it different from every other
 * entry is that there is no key to have.
 */
describe('the local provider', () => {
	const local = PROVIDERS.find(spec => spec.id === 'local')!;

	it('needs no key and needs a base URL', () => {
		expect(local.keyless).toBe(true);
		expect(local.needsBaseUrl).toBe(true);
		// No keys page, because there are no keys.
		expect(local.keysUrl).toBeUndefined();
	});

	it('names the servers it covers, so they are findable', () => {
		for (const server of ['Ollama', 'llama.cpp', 'LM Studio', 'vLLM']) {
			expect(local.label, server).toContain(server);
		}
		expect(LOCAL_BASE_URLS.map(one => one.url)).toContain('http://localhost:11434/v1');
		expect(LOCAL_BASE_URLS.map(one => one.url)).toContain('http://localhost:8080/v1');
	});

	it('is the only keyless provider — the hosted ones still need keys', () => {
		expect(PROVIDERS.filter(spec => spec.keyless === true).map(spec => spec.id)).toEqual([
			'local',
		]);
	});

	it('builds without a stored key, where a hosted provider will not', async () => {
		const built = await loadProvider('local', 'qwen3:8b', 'http://127.0.0.1:1/v1');
		expect('provider' in built).toBe(true);

		// The rule that keyless relaxes is relaxed for this one provider only.
		const hosted = await loadProvider('openai', 'gpt-4o', 'http://127.0.0.1:1/v1');
		expect('error' in hosted && hosted.error).toMatch(/no API key/);
	});

	it('says so when it has not been pointed anywhere', async () => {
		const built = await loadProvider('local', 'qwen3:8b', undefined);
		expect('error' in built && built.error).toMatch(/no base URL/);
	});

	it('sends a non-empty Authorization header', () => {
		// llama-server rejects an empty one with a 401, which reads like a
		// credential problem on a server that has no credentials. The placeholder
		// exists to make that impossible, and is never written to the key store.
		expect(PLACEHOLDER_KEY).not.toBe('');
	});
});
