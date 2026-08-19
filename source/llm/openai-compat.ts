import {findProvider} from './catalog.js';
import {
	ProviderError,
	type ModelInfo,
	type Provider,
	type ProviderConfig,
} from './types.js';

/**
 * OpenAI, Together AI, and Kimi all speak the OpenAI chat-completions shape:
 * `Authorization: Bearer`, `GET /models`, `POST /chat/completions`. One adapter
 * covers all three; only the base URL differs.
 *
 * Anthropic is deliberately not routed through here — see `anthropic.ts`.
 */

/**
 * Generous by design. Kimi Code's models are thinking-only: reasoning tokens are
 * drawn from the same budget as the answer, so a small ceiling returns an empty
 * `content` with `finish_reason: "length"` — the reasoning ate it. Observed
 * directly: 20 tokens yielded no answer, 300 yielded one.
 */
const MAX_TOKENS = 8192;

type ErrorBody = {error?: {message?: string; type?: string}};

async function describeFailure(response: Response): Promise<ProviderError> {
	const text = await response.text().catch(() => '');
	let message = text.slice(0, 200);
	try {
		message = (JSON.parse(text) as ErrorBody).error?.message ?? message;
	} catch {
		// Non-JSON body — the raw text is the best we have.
	}

	const hint =
		response.status === 401 || response.status === 403
			? 'check the API key'
			: response.status === 404
				? 'check the base URL'
				: response.status === 429
					? 'rate limited — try again shortly'
					: undefined;

	return new ProviderError(
		`${response.status} ${message || response.statusText}`,
		hint,
		response.status,
	);
}

export function createOpenAiCompatProvider(config: ProviderConfig): Provider {
	const spec = findProvider(config.id);
	const baseUrl = (config.baseUrl ?? spec.baseUrl).replace(/\/+$/, '');
	const headers = {
		authorization: `Bearer ${config.apiKey}`,
		'content-type': 'application/json',
	};
	const budget = spec.maxOutputTokens ?? MAX_TOKENS;

	return {
		id: config.id,
		model: config.model,

		async listModels(signal) {
			const response = await fetch(`${baseUrl}/models`, {headers, signal});
			if (!response.ok) {
				throw await describeFailure(response);
			}

			const body = (await response.json()) as {data?: {id?: unknown}[]};
			return (body.data ?? [])
				.map((entry): ModelInfo | undefined =>
					typeof entry.id === 'string' ? {id: entry.id} : undefined,
				)
				.filter((entry): entry is ModelInfo => entry !== undefined);
		},

		async *chat(messages, signal) {
			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				signal,
				body: JSON.stringify({
					model: config.model,
					stream: true,
					max_tokens: budget,
					messages: messages.map(m => ({role: m.role, content: m.content})),
				}),
			});

			if (!response.ok || !response.body) {
				throw await describeFailure(response);
			}

			// Server-sent events: `data: {json}` per line, terminated by [DONE].
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let truncated = false;

			stream: while (true) {
				const {done, value} = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, {stream: true});

				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) {
						continue;
					}
					const payload = trimmed.slice(5).trim();
					if (payload === '[DONE]') {
						break stream;
					}
					try {
						const chunk = JSON.parse(payload) as {
							choices?: {delta?: {content?: unknown}; finish_reason?: unknown}[];
						};
						// `length` means the model was cut off mid-answer. Recorded here
						// rather than thrown, so everything it did manage to say still
						// reaches the caller before the failure does.
						if (chunk.choices?.[0]?.finish_reason === 'length') {
							truncated = true;
						}
						const delta = chunk.choices?.[0]?.delta?.content;
						if (typeof delta === 'string' && delta !== '') {
							yield delta;
						}
					} catch {
						// A partial frame; the next read completes it.
					}
				}
			}

			if (truncated) {
				// Worth an exception rather than a quietly short answer. A cut-off
				// reply is not a smaller reply, it is a broken one — and the caller
				// that has to parse it as JSON would otherwise report an
				// "unterminated object", sending the reader after a bug in the parser
				// instead of the budget that actually ran out.
				throw new ProviderError(
					`the model stopped at its ${String(budget)}-token output limit, mid-answer`,
					'a long interview needs a bigger budget — raise maxOutputTokens for this provider in the catalog, or extract a shorter transcript',
				);
			}
		},
	};
}
