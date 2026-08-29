import type {ProviderId, ProviderSpec} from './types.js';

/**
 * The four providers from the requirements. Three speak the OpenAI
 * chat-completions shape; Anthropic speaks its own Messages API and uses
 * `x-api-key` plus a version header rather than a bearer token.
 *
 * Model lists are fetched live at setup time — `suggestedModels` only seeds the
 * picker when the endpoint is unreachable or returns nothing.
 */
export const PROVIDERS: readonly ProviderSpec[] = [
	{
		id: 'anthropic',
		label: 'Anthropic Claude',
		baseUrl: 'https://api.anthropic.com',
		auth: 'anthropic',
		envVar: 'ANTHROPIC_API_KEY',
		keysUrl: 'https://platform.claude.com/settings/keys',
		suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
		note: 'Messages API — not OpenAI-compatible',
	},
	{
		id: 'openai',
		label: 'OpenAI',
		baseUrl: 'https://api.openai.com/v1',
		auth: 'bearer',
		envVar: 'OPENAI_API_KEY',
		keysUrl: 'https://platform.openai.com/api-keys',
		suggestedModels: ['gpt-4o', 'gpt-4o-mini'],
		maxOutputTokens: 16_384,
	},
	{
		id: 'together',
		label: 'Together AI',
		baseUrl: 'https://api.together.xyz/v1',
		auth: 'bearer',
		envVar: 'TOGETHER_API_KEY',
		keysUrl: 'https://api.together.ai/settings/api-keys',
		suggestedModels: [
			'meta-llama/Llama-3.3-70B-Instruct-Turbo',
			'Qwen/Qwen2.5-72B-Instruct-Turbo',
		],
		maxOutputTokens: 8192,
	},
	// Kimi ships two unrelated products and the difference is the single most
	// common way to get a 401 here, so they are two entries rather than one with
	// a toggle. Both `authHint`s name the other, because "check the API key" is
	// useless advice when the key is fine and the entry is wrong.
	{
		id: 'kimi',
		label: 'Kimi — Moonshot API key',
		baseUrl: 'https://api.moonshot.ai/v1',
		auth: 'bearer',
		envVar: 'MOONSHOT_API_KEY',
		keysUrl: 'https://platform.moonshot.ai/console/api-keys',
		suggestedModels: ['kimi-k3', 'kimi-k2-0905-preview', 'moonshot-v1-128k'],
		maxOutputTokens: 16_384,
		note: 'pay-per-token platform key (sk-…)',
		authHint:
			'this host takes a platform key from platform.moonshot.ai — a kimi.ai subscription key belongs under "Kimi Code"',
	},
	{
		// api.kimi.ai and api.kimi.com answer identically, but kimi.com is the
		// mainland-China front door and kimi.ai is the international one, so the
		// .ai host is the default and the .com host is the override.
		id: 'kimi-code',
		label: 'Kimi Code — kimi.ai subscription',
		baseUrl: 'https://api.kimi.ai/coding/v1',
		auth: 'bearer',
		envVar: 'KIMI_CODE_API_KEY',
		keysUrl: 'https://www.kimi.ai/code',
		suggestedModels: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
		// Measured, not guessed. Extracting a 30-exchange interview: at 8192 the
		// model spent 26k characters reasoning and the JSON was cut mid-string;
		// given room it spent 50k on reasoning and 18k on the answer — roughly
		// 19k tokens — and finished. The host accepts 131072, and this is a
		// ceiling rather than a target, so headroom is free and truncation is a
		// hard failure the author only discovers after a long wait.
		maxOutputTokens: 65_536,
		note: 'subscription plan — kimi.ai, thinking-only models',
		// Deliberately says nothing about api.kimi.com. It is a valid override and
		// it is documented in the README, but naming it here would put the
		// mainland-China host in front of every user who mistypes a key — which is
		// how the app came to look like it thought kimi.com was the default.
		authHint:
			'this host takes a subscription key from kimi.ai/code — a platform key (sk-…) belongs under "Kimi — Moonshot API key"',
	},
	/**
	 * Anything speaking the OpenAI shape on a host you control.
	 *
	 * One entry rather than one per server, because Ollama, llama.cpp,
	 * LM Studio and vLLM differ here in exactly one thing — the port — and the
	 * wire protocol, the auth story and the model list are identical. The two
	 * Kimi entries above are two because they are two products with two kinds of
	 * key; these are one product with several front doors.
	 *
	 * The label names them anyway, so an author looking for "Ollama" finds this
	 * rather than concluding it is unsupported.
	 */
	{
		id: 'local',
		label: 'Local — Ollama, llama.cpp, LM Studio, vLLM',
		// Ollama's default, and the most common thing behind this entry. The
		// wizard asks and llama.cpp's :8080 is offered beside it, so this is a
		// first guess rather than an assumption.
		baseUrl: 'http://localhost:11434/v1',
		auth: 'bearer',
		envVar: 'LITFIRE_LOCAL_API_KEY',
		keyless: true,
		needsBaseUrl: true,
		// Live from the endpoint in practice: a local server lists exactly what it
		// has pulled, which is far more useful than anything guessable. These only
		// show when it is unreachable, and are named to look like examples.
		suggestedModels: ['qwen3:8b', 'llama3.3:70b', 'gpt-oss:20b'],
		// A ceiling asked for, not a promise the server makes: llama-server and
		// Ollama both clamp to whatever they were started with. It matters because
		// extraction emits whole file bodies as JSON, and a budget too small cuts
		// the reply mid-string — which surfaces as a parse error blaming the
		// parser. 16384 is what a llama-server on a 24GB card is typically run
		// with, and headroom here is free.
		maxOutputTokens: 16_384,
		note: 'your own machine — no API key needed',
		authHint:
			'a local server usually needs no key at all; if yours sits behind a proxy that does, set LITFIRE_LOCAL_API_KEY',
	},
];

/** Base URLs offered beside the default, for a provider the author must point somewhere. */
export const LOCAL_BASE_URLS: readonly {readonly url: string; readonly label: string}[] =
	[
		{url: 'http://localhost:11434/v1', label: 'Ollama'},
		{url: 'http://localhost:8080/v1', label: 'llama.cpp — llama-server'},
		{url: 'http://localhost:1234/v1', label: 'LM Studio'},
		{url: 'http://localhost:8000/v1', label: 'vLLM'},
	];

/**
 * §9 requires supporting "any local OpenAI-compatible endpoint", so every
 * provider's host is overridable: `LITFIRE_OPENAI_BASE_URL`,
 * `LITFIRE_KIMI_BASE_URL` (for the api.moonshot.cn host), and so on. Also the
 * seam that makes the success path testable without a paid key.
 *
 * The hyphen in `kimi-code` becomes an underscore: `LITFIRE_KIMI-CODE_BASE_URL`
 * is not a name a shell will export, so the one provider most likely to need a
 * host override would have had an escape hatch nobody could actually use.
 */
export function baseUrlEnvVar(id: ProviderId): string {
	return `LITFIRE_${id.toUpperCase().replace(/-/g, '_')}_BASE_URL`;
}

/** Whether the environment has already pointed this provider somewhere. */
export function hasBaseUrlOverride(id: ProviderId): boolean {
	return (process.env[baseUrlEnvVar(id)] ?? '').trim() !== '';
}

export function findProvider(id: ProviderId): ProviderSpec {
	const spec = PROVIDERS.find(provider => provider.id === id);
	if (!spec) {
		throw new Error(`unknown provider '${id}'`);
	}

	const override = process.env[baseUrlEnvVar(id)]?.trim();
	return override ? {...spec, baseUrl: override} : spec;
}
