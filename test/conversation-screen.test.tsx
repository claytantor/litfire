import {render} from 'ink-testing-library';
import {describe, expect, it, vi} from 'vitest';
import {ConversationScreen} from '../source/components/conversation-screen.js';
import type {ConversationTurn} from '../source/conversation/types.js';

const flush = async (ms = 60) => {
	await new Promise(resolve => setTimeout(resolve, ms));
};

const base = {
	speaker: 'reviewer',
	turns: [] as readonly ConversationTurn[],
	streaming: undefined as string | undefined,
	status: undefined as string | undefined,
	busy: false,
	rows: 24,
	columns: 60,
};

function mount(over: Partial<typeof base> = {}) {
	const onSubmit = vi.fn<(text: string) => void>();
	const onCancel = vi.fn();
	const props = {...base, ...over};

	const ui = render(
		<ConversationScreen {...props} onSubmit={onSubmit} onCancel={onCancel} />,
	);

	/** Re-renders with a fresh slice of parent state, as the session would. */
	const show = (next: Partial<typeof base>) => {
		ui.rerender(
			<ConversationScreen {...props} {...next} onSubmit={onSubmit} onCancel={onCancel} />,
		);
	};

	return {onSubmit, onCancel, show, ...ui};
}

// rows=24 leaves a 15-row transcript, so 30 single-line turns overflow it.
const many: readonly ConversationTurn[] = Array.from({length: 30}, (_unused, index) => ({
	role: index % 2 === 0 ? 'author' : 'agent',
	text: `turn-${String(index).padStart(2, '0')}`,
}));

describe('ConversationScreen', () => {
	it('renders both sides of the conversation, each with its own prefix', async () => {
		const {lastFrame} = mount({
			turns: [
				{role: 'author', text: 'Does Mira ever learn her father lied?'},
				{role: 'agent', text: 'Not on the page.'},
			],
		});
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).toContain('› you');
		expect(frame).toContain('⏺ reviewer');
		expect(frame).toContain('Does Mira ever learn her father lied?');
		expect(frame).toContain('Not on the page.');
	});

	it('invites a first question when there is nothing to show yet', async () => {
		const {lastFrame} = mount();
		await flush();

		expect(lastFrame()).toContain('Nothing asked yet');
	});

	it('renders the streaming partial as it arrives', async () => {
		const {lastFrame, show} = mount({busy: true});
		await flush();

		show({busy: true, streaming: 'The opening'});
		await flush();
		expect(lastFrame()).toContain('The opening');

		show({busy: true, streaming: 'The opening chapter withholds too much.'});
		await flush();

		const frame = lastFrame() ?? '';
		// Attributed to the reviewer while still in flight, not once it lands.
		expect(frame).toContain('⏺ reviewer');
		expect(frame).toContain('The opening chapter withholds too much.');
	});

	it('shows the activity note and a cancel affordance while busy', async () => {
		const {lastFrame} = mount({busy: true, status: 'scanning 12 files…'});
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).toContain('scanning 12 files…');
		expect(frame).toContain('esc to cancel');
	});

	it('cancels on esc while busy — the reply worth escaping is the hung one', async () => {
		const {stdin, onCancel} = mount({busy: true, streaming: 'thinking about it'});
		await flush();

		stdin.write('\x1b');
		// A lone ESC is held pending in Ink and flushed ~20ms later.
		await flush(120);

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('cancels on esc when idle', async () => {
		const {stdin, onCancel} = mount({turns: many});
		await flush();

		stdin.write('\x1b');
		await flush(120);

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('submits a line and clears the draft', async () => {
		const {stdin, lastFrame, onSubmit} = mount();
		await flush();

		stdin.write('tighten the second act');
		await flush();
		expect(lastFrame()).toContain('tighten the second act');

		stdin.write('\r');
		await flush();

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith('tighten the second act');
		// The turn belongs to the parent, so the text leaves the screen entirely.
		expect(lastFrame()).not.toContain('tighten the second act');
		expect(lastFrame()).toContain('ask the reviewer…');
	});

	it('takes no composer input while busy', async () => {
		const {stdin, lastFrame, onSubmit} = mount({busy: true});
		await flush();

		stdin.write('zebra');
		await flush();
		stdin.write('\r');
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).not.toContain('zebra');
		expect(frame).toContain('the reviewer is replying…');
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('shows the tail of a transcript longer than the viewport', async () => {
		const {lastFrame} = mount({turns: many});
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).toContain('turn-29');
		expect(frame).not.toContain('turn-00');
		expect(frame).toContain('last 15 of 90');
	});

	it('scrolls back on pageup and says it is no longer following', async () => {
		const {stdin, lastFrame} = mount({turns: many});
		await flush();

		stdin.write('\x1b[5~');
		await flush();

		const back = lastFrame() ?? '';
		expect(back).toContain('turn-20');
		expect(back).not.toContain('turn-29');
		expect(back).toContain('back · ↓ to follow');

		stdin.write('\x1b[6~');
		await flush();

		const forward = lastFrame() ?? '';
		expect(forward).toContain('turn-29');
		expect(forward).not.toContain('back · ↓ to follow');
	});

	it('follows new output while pinned to the tail', async () => {
		const {lastFrame, show} = mount({turns: many});
		await flush();

		show({turns: [...many, {role: 'agent', text: 'turn-30'}]});
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).toContain('turn-30');
		expect(frame).not.toContain('turn-20');
	});

	it('holds its scroll-back position as new output arrives', async () => {
		const {stdin, lastFrame, show} = mount({turns: many});
		await flush();

		stdin.write('\x1b[A');
		await flush();
		show({turns: many, streaming: 'a reply landing underneath'});
		await flush();

		// Still reading back, not yanked to the bottom mid-sentence.
		expect(lastFrame()).toContain('back · ↓ to follow');
	});

	it('wraps a long reply instead of truncating it', async () => {
		const reply =
			'The scene works but the last paragraph explains what the dialogue has already earned, and it flattens her.';
		const {lastFrame} = mount({turns: [{role: 'agent', text: reply}]});
		await flush();

		const frame = lastFrame() ?? '';
		// Both ends survive: nothing was clipped at the column edge…
		expect(frame).toContain('The scene works');
		expect(frame).toContain('flattens her.');
		// …and it did not arrive as one over-long row.
		expect(frame).not.toContain(reply);
	});

	it('keeps the composer on screen when the terminal is short', async () => {
		const {lastFrame} = mount({turns: many, rows: 12});
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).toContain('ask the reviewer…');
		expect(frame).toContain('enter send');
		// 12 rows − 9 chrome floors at the 3-row minimum, not a negative slice.
		expect(frame).toContain('last 3 of 90');
	});
});

describe('who the author is talking to', () => {
	const turns: readonly ConversationTurn[] = [
		{role: 'author', text: 'split the lathe'},
		{role: 'agent', text: 'two systems, then'},
	];

	it('names the reviewer throughout when it is the reviewer', async () => {
		const ui = mount({turns, speaker: 'reviewer'});
		await flush();
		const frame = ui.lastFrame() ?? '';

		expect(frame).toContain('reviewer');
		expect(frame).toContain('ask the reviewer…');
		expect(frame).not.toContain('architect');
		ui.unmount();
	});

	it('names the architect throughout when it is the architect', async () => {
		// The reported bug: `/architect` greeted the author as the editor. They do
		// different jobs — one shapes raw material into corpus, the other corrects
		// prose — and a screen that misnames itself is worse than an unnamed one.
		// The screen has no default speaker now, which is why it cannot recur.
		const ui = mount({turns, speaker: 'architect'});
		await flush();
		const frame = ui.lastFrame() ?? '';

		expect(frame).toContain('architect');
		expect(frame).toContain('ask the architect…');
		// Not one mention of the other agent survives.
		expect(frame).not.toContain('reviewer');
		ui.unmount();
	});

	it('names it in the busy line too', async () => {
		const ui = mount({turns, speaker: 'architect', busy: true});
		await flush();
		expect(ui.lastFrame() ?? '').toContain('the architect is replying…');
		ui.unmount();
	});
});
