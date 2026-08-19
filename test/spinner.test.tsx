import {Text} from 'ink';
import {render} from 'ink-testing-library';
import {describe, expect, it} from 'vitest';
import {SPINNER_FRAMES, useSpinnerFrame} from '../source/hooks/use-spinner.js';

const flush = (ms = 40) => new Promise(done => setTimeout(done, ms));

function Probe({active}: {readonly active: boolean}) {
	const frame = useSpinnerFrame(active);
	return <Text>[{frame}]</Text>;
}

describe('the text spinner', () => {
	it('renders nothing at all when idle', async () => {
		// Deliberately empty rather than a first frame: a spinner that has stopped
		// reads as a hang, which is the impression it exists to prevent.
		const ui = render(<Probe active={false} />);
		await flush(200);
		expect(ui.lastFrame()).toBe('[]');
		ui.unmount();
	});

	it('advances while active', async () => {
		const ui = render(<Probe active />);
		await flush();
		const first = ui.lastFrame();
		await flush(260);
		const later = ui.lastFrame();

		expect(first).not.toBe('[]');
		expect(later).not.toBe(first);
		ui.unmount();
	});

	it('uses the same frames as ink-spinner, so two waits look like one program', () => {
		expect([...SPINNER_FRAMES]).toEqual([
			'⠋',
			'⠙',
			'⠹',
			'⠸',
			'⠼',
			'⠴',
			'⠦',
			'⠧',
			'⠇',
			'⠏',
		]);
	});
});
