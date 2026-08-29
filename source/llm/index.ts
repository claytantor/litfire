import {createAnthropicProvider} from './anthropic.js';
import {baseUrlEnvVar, findProvider, hasBaseUrlOverride} from './catalog.js';
import {resolveKey, type ResolvedKey} from './credentials.js';
import {createOpenAiCompatProvider} from './openai-compat.js';
import {
	ProviderError,
	type Provider,
	type ProviderConfig,
	type ProviderId,
	type TestOutcome,
} from './types.js';

export function createProvider(config: ProviderConfig): Provider {
	return config.id === 'anthropic'
		? createAnthropicProvider(config)
		: createOpenAiCompatProvider(config);
}

/**
 * What a keyless provider sends when nothing is stored.
 *
 * Not a secret and never treated as one: llama.cpp requires the header to be
 * non-empty and does not look at it, Ollama ignores it. A literal is honest
 * here — the alternative is omitting the header, which llama.cpp rejects with a
 * 401 that reads like a credential problem when there is no credential.
 */
export const PLACEHOLDER_KEY = 'litfire-local';

const TEST_TIMEOUT_MS = 15_000;

/**
 * Validates a key by listing models — an authenticated GET that spends no
 * tokens, so testing a connection never costs anything. The model list it
 * returns is exactly what the picker needs next.
 */
export async function testConnection(
	config: Omit<ProviderConfig, 'model'> & {model?: string},
): Promise<TestOutcome> {
	const spec = findProvider(config.id);
	const provider = createProvider({...config, model: config.model ?? ''});

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

	try {
		const models = await provider.listModels(controller.signal);
		if (models.length === 0) {
			return {
				ok: true,
				models: spec.suggestedModels.map(id => ({id})),
				note: 'key accepted, but the provider returned no model list',
			};
		}
		return {ok: true, models};
	} catch (caught) {
		if (controller.signal.aborted) {
			return {ok: false, reason: 'timed out after 15s', hint: 'check the base URL'};
		}
		if (caught instanceof ProviderError) {
			// A rejected key is nearly always a good key against the wrong entry —
			// the two Kimi products being the standing example — so the spec's own
			// hint wins over the adapter's generic one.
			const hint =
				(caught.status === 401 || caught.status === 403) && spec.authHint !== undefined
					? spec.authHint
					: caught.hint;
			return {
				ok: false,
				reason: caught.message,
				...(hint === undefined ? {} : {hint}),
			};
		}
		return {
			ok: false,
			reason: caught instanceof Error ? caught.message : String(caught),
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Verifies whatever key is already resolved for a provider, without the wizard.
 *
 * The wizard tests on entry, but a key that was accepted in March can be
 * revoked, expire, or stop matching its host — and until now the only way to
 * find that out was an interview failing mid-question. This is the same
 * zero-token model-list call, pointed at what is already on disk.
 */
export async function verifyStoredKey(
	id: ProviderId,
): Promise<{outcome: TestOutcome; resolved: ResolvedKey}> {
	const resolved = await resolveKey(id);
	if (!resolved.key) {
		return {
			outcome: {
				ok: false,
				// A broken `…_FILE` is the more useful thing to say when there is one:
				// "no key stored" is true but sends the reader to the wrong place.
				reason: resolved.problem ?? 'no key stored',
				hint: `run /provider, set ${resolved.envVar}, or point ${resolved.fileEnvVar} at a file`,
			},
			resolved,
		};
	}

	return {outcome: await testConnection({id, apiKey: resolved.key}), resolved};
}

/** Builds a ready provider from saved config, or explains what is missing. */
export async function loadProvider(
	id: ProviderId | undefined,
	model: string | undefined,
	baseUrl?: string,
): Promise<{provider: Provider} | {error: string}> {
	if (!id) {
		return {error: 'no provider configured — run /provider'};
	}
	if (!model) {
		return {error: `no model selected for ${id} — run /provider`};
	}

	const spec = findProvider(id);
	const resolved = await resolveKey(id);

	// A keyless provider is one on a host the author controls, and it takes any
	// non-empty string or ignores the header entirely. A stored key still wins
	// where there is one — a GPU box behind a proxy has a real token — but its
	// absence is not a failure, and demanding one would teach an author that
	// their own machine needs a credential.
	const apiKey = resolved.key ?? (spec.keyless === true ? PLACEHOLDER_KEY : undefined);
	if (apiKey === undefined) {
		return {
			error:
				resolved.problem ??
				`no API key for ${id} — run /provider, set ${resolved.envVar}, or point ${resolved.fileEnvVar} at a file`,
		};
	}

	// The catalog default is only a first guess for a local endpoint, so a
	// missing base URL there means the author never finished pointing it
	// anywhere — worth saying plainly rather than failing against localhost.
	if (spec.needsBaseUrl === true && baseUrl === undefined && !hasBaseUrlOverride(id)) {
		return {
			error: `no base URL for ${id} — run /provider, or set ${baseUrlEnvVar(id)}`,
		};
	}

	return {
		provider: createProvider({
			id,
			model,
			apiKey,
			...(baseUrl === undefined ? {} : {baseUrl}),
		}),
	};
}

export {LOCAL_BASE_URLS, PROVIDERS, baseUrlEnvVar, findProvider} from './catalog.js';
export {
	credentialsPath,
	forgetKey,
	keyFileEnvVar,
	maskKey,
	resolveKey,
	saveKey,
	type KeySource,
	type ResolvedKey,
} from './credentials.js';
export {
	ProviderError,
	providerIdSchema,
	type ChatMessage,
	type ChatRole,
	type ModelInfo,
	type Provider,
	type ProviderConfig,
	type ProviderId,
	type ProviderSpec,
	type TestOutcome,
} from './types.js';
