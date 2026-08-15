import {Text} from 'ink';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import type {Engine} from '../source/engine/types.js';
import {useChat, type UseChatResult} from '../source/hooks/use-chat.js';

/**
 * Ink has no `renderHook`, so a throwaway component publishes the hook result
 * to the caller and renders nothing meaningful.
 */
function harness(engine: Engine) {
	let latest: UseChatResult | undefined;

	function Probe() {
		latest = useChat(engine);
		return <Text>{latest.status}</Text>;
	}

	const instance = render(<Probe />);
	return {
		instance,
		get current(): UseChatResult {
			if (!latest) {
				throw new Error('hook did not render');
			}
			return latest;
		},
	};
}

const flush = async (ms = 25) => {
	await new Promise(resolve => setTimeout(resolve, ms));
};

const engine: Engine = {
	name: 'test',
	async *send() {
		yield 'alpha ';
		yield 'beta';
	},
};

describe('useChat', () => {
	it('starts idle with no messages', () => {
		const h = harness(engine);

		expect(h.current.status).toBe('idle');
		expect(h.current.messages).toHaveLength(0);
	});

	it('records the user turn and the assistant reply', async () => {
		const h = harness(engine);

		h.current.send('hello');
		await flush();

		expect(h.current.messages.map(m => m.role)).toEqual(['user', 'assistant']);
		expect(h.current.messages[0]?.content).toBe('hello');
		expect(h.current.messages[1]?.content).toBe('alpha beta');
		expect(h.current.status).toBe('idle');
	});

	it('ignores empty input', async () => {
		const h = harness(engine);

		h.current.send('   ');
		await flush();

		expect(h.current.messages).toHaveLength(0);
	});

	it('surfaces engine failures as an error status', async () => {
		const failing: Engine = {
			name: 'failing',
			// eslint-disable-next-line require-yield
			async *send() {
				throw new Error('upstream exploded');
			},
		};
		const h = harness(failing);

		h.current.send('hello');
		await flush();

		expect(h.current.status).toBe('error');
		expect(h.current.error).toBe('upstream exploded');
	});

	it('clear drops history and does not resurrect an in-flight reply', async () => {
		const slow: Engine = {
			name: 'slow',
			async *send() {
				yield 'partial ';
				await new Promise(resolve => setTimeout(resolve, 50));
				yield 'more';
			},
		};
		const h = harness(slow);

		h.current.send('hello');
		await flush(10);
		h.current.clear();
		await flush(80);

		expect(h.current.messages).toHaveLength(0);
		expect(h.current.streaming).toBe('');
	});
});
