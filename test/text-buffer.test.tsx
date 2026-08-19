import {render} from 'ink-testing-library';
import {describe, expect, it, vi} from 'vitest';
import {TextBuffer} from '../source/components/text-buffer.js';

const flush = async (ms = 60) => {
	await new Promise(resolve => setTimeout(resolve, ms));
};

/** Control codes, named for the chord the hint line advertises. */
const SAVE = ''; // ^s
const UNDO = ''; // ^z
const REDO = ''; // ^y
const ESC = '';

function mount(over: {contents?: string; confirmDiscard?: boolean} = {}) {
	const onSave = vi.fn<(text: string) => void>();
	const onCancel = vi.fn();
	const ui = render(
		<TextBuffer
			contents={over.contents ?? 'the ledger room'}
			path="situations/inbox/sit-001.md"
			height={20}
			columns={60}
			confirmDiscard={over.confirmDiscard ?? false}
			onSave={onSave}
			onCancel={onCancel}
		/>,
	);
	return {...ui, onSave, onCancel};
}

describe('the native buffer', () => {
	it('saves what was typed', async () => {
		const {stdin, onSave} = mount({contents: ''});
		await flush();

		stdin.write('She lied.');
		await flush();
		stdin.write(SAVE);
		await flush();

		expect(onSave).toHaveBeenCalledWith('She lied.');
	});

	it('takes back a whole run of typing in one undo, not one character', async () => {
		const {stdin, onSave} = mount({contents: ''});
		await flush();

		for (const character of 'hello') {
			stdin.write(character);
			await flush(10);
		}
		stdin.write(UNDO);
		await flush();
		stdin.write(SAVE);
		await flush();

		expect(onSave).toHaveBeenCalledWith('');
	});

	it('redoes what it undid', async () => {
		const {stdin, onSave} = mount({contents: ''});
		await flush();

		for (const character of 'draft') {
			stdin.write(character);
			await flush(10);
		}
		stdin.write(UNDO);
		await flush();
		stdin.write(REDO);
		await flush();
		stdin.write(SAVE);
		await flush();

		expect(onSave).toHaveBeenCalledWith('draft');
	});

	it('offers undo in the hint only once there is something to undo', async () => {
		const {stdin, lastFrame} = mount({contents: ''});
		await flush();

		expect(lastFrame()).not.toContain('^z undo');
		stdin.write('x');
		await flush();
		expect(lastFrame()).toContain('^z undo');
	});

	it('leaves immediately when nothing has changed', async () => {
		const {stdin, onCancel} = mount({confirmDiscard: true});
		await flush();

		stdin.write(ESC);
		await flush();

		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('asks once before discarding unsaved prose, then takes the author at their word', async () => {
		const {stdin, onCancel, lastFrame} = mount({confirmDiscard: true});
		await flush();

		stdin.write('!');
		await flush();
		stdin.write(ESC);
		await flush();

		expect(onCancel).not.toHaveBeenCalled();
		expect(lastFrame()).toContain('esc again to discard');

		stdin.write(ESC);
		await flush();
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('does not ask in the review gate, where a rejected proposal costs nothing', async () => {
		const {stdin, onCancel} = mount({confirmDiscard: false});
		await flush();

		stdin.write('!');
		await flush();
		stdin.write(ESC);
		await flush();

		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
