import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {App} from '../source/app.js';
import type {Engine} from '../source/engine/types.js';

function stubEngine(reply: string): Engine {
	return {
		name: 'stub',
		async *send() {
			for (const word of reply.split(' ')) {
				yield `${word} `;
			}
		},
	};
}

const flush = async (ms = 25) => {
	await new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Ink needs a tick to process each stdin chunk, so typing and pressing Enter
 * in the same synchronous block loses the submit.
 */
async function type(stdin: {write: (data: string) => void}, text: string) {
	stdin.write(text);
	await flush(10);
	stdin.write('\r');
	await flush();
}

describe('App', () => {
	it('renders the banner and the composer on first paint', () => {
		const {lastFrame} = render(<App engine={stubEngine('hi')} version="1.2.3" />);
		const frame = lastFrame() ?? '';

		expect(frame).toContain('litfire');
		expect(frame).toContain('v1.2.3');
		expect(frame).toContain('Ask something');
	});

	it('shows the engine name in the status bar', () => {
		const {lastFrame} = render(<App engine={stubEngine('hi')} version="1.2.3" />);

		expect(lastFrame() ?? '').toContain('stub');
	});

	it('streams a reply and commits it to the transcript', async () => {
		const {stdin, frames} = render(
			<App engine={stubEngine('pong from the engine')} version="1.2.3" />,
		);

		await type(stdin, 'ping');

		const all = frames.join('\n');
		expect(all).toContain('ping');
		expect(all).toContain('pong from the engine');
	});

	it('submits when text and Enter arrive in one chunk (paste / piped input)', async () => {
		const {stdin, frames} = render(
			<App engine={stubEngine('chunked reply')} version="1.2.3" />,
		);

		// Ink delivers this as a single input event with no key.return.
		stdin.write('ping\r');
		await flush();

		expect(frames.join('\n')).toContain('chunked reply');
	});

	it('keeps text after the first newline as the next draft', async () => {
		const {stdin, lastFrame} = render(<App engine={stubEngine('ok')} version="1.2.3" />);

		stdin.write('first\rsecond');
		await flush();

		expect(lastFrame() ?? '').toContain('second');
	});

	it('renders help without calling the engine', async () => {
		let called = false;
		const engine: Engine = {
			name: 'never',
			async *send() {
				called = true;
				yield 'nope';
			},
		};

		const {stdin, lastFrame} = render(<App engine={engine} version="1.2.3" />);

		await type(stdin, '/help');

		expect(called).toBe(false);
		expect(lastFrame() ?? '').toContain('/clear');
	});
});
