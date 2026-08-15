import type {Message} from '../types.js';

/**
 * The seam between the TUI and whatever actually answers.
 *
 * The UI only ever awaits an async iterable of text deltas, so swapping the
 * echo stub for a real model client (or a local process, or an HTTP stream)
 * touches nothing above this file. Implementations must honour `signal` so
 * that Esc can cancel an in-flight turn.
 */
export type Engine = {
	readonly name: string;
	send(messages: readonly Message[], signal: AbortSignal): AsyncIterable<string>;
};

export class AbortedError extends Error {
	constructor() {
		super('aborted');
		this.name = 'AbortedError';
	}
}
