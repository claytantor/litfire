import Anthropic from '@anthropic-ai/sdk';
import {findProvider} from './catalog.js';
import {
	ProviderError,
	type ModelInfo,
	type Provider,
	type ProviderConfig,
} from './types.js';

/**
 * Anthropic via the official SDK and the Messages API.
 *
 * It is deliberately not routed through the OpenAI-compatible adapter: the
 * endpoint (`/v1/messages`), the auth header (`x-api-key`, not a bearer token),
 * the required `anthropic-version` header, and the request/response shape all
 * differ. Anthropic's own guidance is to use the SDK rather than a
 * compatibility shim, and the SDK tracks those details as the API moves.
 */

/**
 * Output ceiling for the Messages API. Not the context window — the budget the
 * *answer* is drawn from, which is what an extraction of a long interview runs
 * into first. A cut-off reply is reported as such rather than parsed.
 */
const MAX_OUTPUT_TOKENS = 16_000;

function describeFailure(caught: unknown): ProviderError {
	if (caught instanceof Anthropic.AuthenticationError) {
		return new ProviderError('401 API key is invalid', 'check the API key', 401);
	}
	if (caught instanceof Anthropic.PermissionDeniedError) {
		return new ProviderError('403 permission denied', 'key lacks access', 403);
	}
	if (caught instanceof Anthropic.NotFoundError) {
		return new ProviderError('404 not found', 'check the model id');
	}
	if (caught instanceof Anthropic.RateLimitError) {
		return new ProviderError('429 rate limited', 'try again shortly');
	}
	if (caught instanceof Anthropic.APIConnectionError) {
		return new ProviderError('could not reach api.anthropic.com', 'check the network');
	}
	if (caught instanceof Anthropic.APIError) {
		return new ProviderError(`${caught.status ?? ''} ${caught.message}`.trim());
	}
	return new ProviderError(caught instanceof Error ? caught.message : String(caught));
}

export function createAnthropicProvider(config: ProviderConfig): Provider {
	const spec = findProvider('anthropic');
	const client = new Anthropic({
		apiKey: config.apiKey,
		...((config.baseUrl ?? spec.baseUrl) === spec.baseUrl
			? {}
			: {baseURL: config.baseUrl}),
	});

	return {
		id: 'anthropic',
		model: config.model,

		async listModels() {
			try {
				const models: ModelInfo[] = [];
				// The SDK auto-paginates on iteration.
				for await (const model of client.models.list()) {
					models.push({id: model.id, label: model.display_name});
				}
				return models;
			} catch (caught) {
				throw describeFailure(caught);
			}
		},

		async *chat(messages, signal) {
			try {
				// The Messages API takes `system` as a top-level field, not a role in
				// the array — several system turns are concatenated.
				const system = messages
					.filter(m => m.role === 'system')
					.map(m => m.content)
					.join('\n\n');
				const turns = messages
					.filter(
						(m): m is {role: 'user' | 'assistant'; content: string} =>
							m.role !== 'system',
					)
					.map(m => ({role: m.role, content: m.content}));

				const stream = client.messages.stream(
					{
						model: config.model,
						max_tokens: MAX_OUTPUT_TOKENS,
						...(system === '' ? {} : {system}),
						messages: turns,
					},
					{signal},
				);

				let truncated = false;
				for await (const event of stream) {
					if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
						yield event.delta.text;
					}
					// Same failure as `finish_reason: length` on the OpenAI shape: the
					// answer is cut off, not merely short, and a caller parsing it as
					// JSON would blame its parser.
					if (
						event.type === 'message_delta' &&
						event.delta.stop_reason === 'max_tokens'
					) {
						truncated = true;
					}
				}

				if (truncated) {
					throw new ProviderError(
						`the model stopped at its ${String(MAX_OUTPUT_TOKENS)}-token output limit, mid-answer`,
						'a long interview needs a bigger budget — raise MAX_OUTPUT_TOKENS, or extract a shorter transcript',
					);
				}
			} catch (caught) {
				if (signal.aborted) {
					return;
				}
				throw describeFailure(caught);
			}
		},
	};
}
