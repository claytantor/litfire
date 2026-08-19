import {z} from 'zod';

export const providerIdSchema = z.enum([
	'openai',
	'anthropic',
	'together',
	'kimi',
	'kimi-code',
]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
	readonly role: ChatRole;
	readonly content: string;
};

export type ModelInfo = {
	readonly id: string;
	readonly label?: string;
};

export type TestOutcome =
	| {readonly ok: true; readonly models: readonly ModelInfo[]; readonly note?: string}
	| {readonly ok: false; readonly reason: string; readonly hint?: string};

/**
 * The seam every provider implements (§9). `listModels` doubles as the
 * connection test: it is a plain authenticated GET, so it validates the key
 * without spending a single token.
 */
export type Provider = {
	readonly id: ProviderId;
	readonly model: string;
	listModels(signal: AbortSignal): Promise<readonly ModelInfo[]>;
	/**
	 * Streams an assistant reply for a multi-turn exchange. An interview needs
	 * the whole history plus a system prompt, which a single prompt string
	 * cannot express — Anthropic in particular takes `system` as its own
	 * top-level field rather than a message role.
	 */
	chat(messages: readonly ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
};

export type ProviderConfig = {
	readonly id: ProviderId;
	readonly model: string;
	readonly apiKey: string;
	/** Overrides the catalog default; useful for self-hosted or regional hosts. */
	readonly baseUrl?: string;
};

/** Auth style. Anthropic is the odd one out and it is not negotiable. */
export type AuthStyle = 'bearer' | 'anthropic';

export type ProviderSpec = {
	readonly id: ProviderId;
	readonly label: string;
	readonly baseUrl: string;
	readonly auth: AuthStyle;
	/** Environment variable consulted before any stored key. */
	readonly envVar: string;
	readonly keysUrl: string;
	/** Shown before a live model list is available. */
	readonly suggestedModels: readonly string[];
	readonly note?: string;
	/**
	 * Replaces the generic "check the API key" on a 401/403.
	 *
	 * Worth its own field because the usual cause of an auth failure here is not
	 * a mistyped key — it is a good key entered against the wrong sibling entry,
	 * and telling someone to check a key that is already correct sends them
	 * looking in the one place the problem is not.
	 */
	readonly authHint?: string;
	/**
	 * Ceiling on tokens the model may *produce*, which is a different budget from
	 * the context window and the one that actually bites here.
	 *
	 * An extraction emits complete file bodies as JSON, so a long interview
	 * produces a long answer — and on a thinking-only model the reasoning is drawn
	 * from this same budget before a single character of the answer appears. Too
	 * low and the reply is cut mid-string, which surfaces as a JSON parse error
	 * blaming the wrong thing entirely.
	 */
	readonly maxOutputTokens?: number;
};

export class ProviderError extends Error {
	readonly hint: string | undefined;
	/** HTTP status when the failure came from a response, so callers can branch. */
	readonly status: number | undefined;

	constructor(message: string, hint?: string, status?: number) {
		super(message);
		this.name = 'ProviderError';
		this.hint = hint;
		this.status = status;
	}
}
