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

export function findProvider(id: ProviderId): ProviderSpec {
	const spec = PROVIDERS.find(provider => provider.id === id);
	if (!spec) {
		throw new Error(`unknown provider '${id}'`);
	}

	const override = process.env[baseUrlEnvVar(id)]?.trim();
	return override ? {...spec, baseUrl: override} : spec;
}
