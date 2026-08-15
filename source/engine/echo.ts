import type {Message} from '../types.js';
import {AbortedError, type Engine} from './types.js';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(timer);
			reject(new AbortedError());
		};

		signal.addEventListener('abort', onAbort, {once: true});
	});
}

/**
 * A stand-in engine so `pnpm dev` is a live, streaming app on first run.
 * It echoes the latest user message back one word at a time.
 *
 * Replace this with the real backend by implementing `Engine` — nothing in
 * `source/components` or `source/hooks` needs to change.
 */
export function createEchoEngine(delayMs = 45): Engine {
	return {
		name: 'echo',
		async *send(messages: readonly Message[], signal: AbortSignal) {
			const last = messages.at(-1);
			const reply = last
				? `You said: "${last.content}". Wire a real engine in source/engine/ to replace this.`
				: 'Nothing to echo yet.';

			for (const word of reply.split(' ')) {
				await sleep(delayMs, signal);
				yield `${word} `;
			}
		},
	};
}
