import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {render} from 'ink-testing-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DiffReview} from '../source/components/diff-review.js';
import {ReviewBatch, type ApplyOutcome} from '../source/review/index.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-gate-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

const flush = async (ms = 60) => {
	await new Promise(resolve => setTimeout(resolve, ms));
};

async function mount(proposals: {path: string; contents: string}[]) {
	const batch = await ReviewBatch.create(root, proposals);
	const onDone = vi.fn<(outcome: ApplyOutcome) => void>();
	const onCancel = vi.fn();
	const ui = render(
		<DiffReview
			batch={batch}
			title="review — system"
			rows={40}
			columns={100}
			onDone={onDone}
			onCancel={onCancel}
		/>,
	);
	return {batch, onDone, onCancel, ...ui};
}

const two = [
	{path: 'characters/a.md', contents: '---\nid: a\n---\n\n# A\n'},
	{path: 'characters/b.md', contents: '---\nid: b\n---\n\n# B\n'},
];

describe('DiffReview', () => {
	it('renders the path, a new-file marker, and a unified diff', async () => {
		const {lastFrame} = await mount([two[0]!]);
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).toContain('characters/a.md');
		expect(frame).toContain('(new file)');
		expect(frame).toContain('@@');
		expect(frame).toContain('• pending');
	});

	it('offers exactly the four actions the spec names', async () => {
		const {lastFrame} = await mount([two[0]!]);
		await flush();

		const frame = lastFrame() ?? '';
		for (const action of ['a accept', 'r reject', 'e edit', 'A accept-all']) {
			expect(frame).toContain(action);
		}
	});

	it('accepts on "a" and advances to the next proposal', async () => {
		const {stdin, batch, lastFrame} = await mount(two);
		await flush();

		stdin.write('a');
		await flush();

		expect(batch.items[0]?.decision).toBe('accepted');
		expect(lastFrame()).toContain('characters/b.md');
	});

	it('rejects on "r"', async () => {
		const {stdin, batch} = await mount(two);
		await flush();

		stdin.write('r');
		await flush();

		expect(batch.items[0]?.decision).toBe('rejected');
	});

	it('accept-all leaves an explicit rejection alone', async () => {
		const {stdin, batch} = await mount(two);
		await flush();

		stdin.write('r');
		await flush();
		stdin.write('A');
		await flush();

		expect(batch.items[0]?.decision).toBe('rejected');
		expect(batch.items[1]?.decision).toBe('accepted');
	});

	it('will not apply until every item is settled', async () => {
		const {stdin, onDone} = await mount(two);
		await flush();

		stdin.write('\r'); // enter with items still pending
		await flush();

		expect(onDone).not.toHaveBeenCalled();
	});

	it('applies on enter once settled, writing only accepted items', async () => {
		const {stdin, onDone} = await mount(two);
		await flush();

		stdin.write('a');
		await flush();
		stdin.write('r');
		await flush();
		stdin.write('\r');
		await flush(120);

		expect(onDone).toHaveBeenCalledTimes(1);
		const outcome = onDone.mock.calls[0]![0];
		expect(outcome.written).toEqual(['characters/a.md']);
		expect(await readFile(path.join(root, 'characters/a.md'), 'utf8')).toContain('# A');
		await expect(readFile(path.join(root, 'characters/b.md'), 'utf8')).rejects.toThrow();
	});

	/**
	 * Accepting marks a decision; only applying writes it. That distinction was
	 * invisible until it cost someone their work — `q` used to discard a batch
	 * of accepted proposals outright, with nothing said.
	 */
	it('asks before discarding changes that were accepted but never written', async () => {
		const {stdin, onCancel, lastFrame} = await mount(two);
		await flush();

		stdin.write('a');
		await flush();
		stdin.write('q');
		await flush();

		expect(onCancel).not.toHaveBeenCalled();
		expect(lastFrame()).toContain('have not been written yet');

		stdin.write('q');
		await flush();
		expect(onCancel).toHaveBeenCalled();
		await expect(readFile(path.join(root, 'characters/a.md'), 'utf8')).rejects.toThrow();
	});

	it('leaves at once when there is nothing to lose', async () => {
		const {stdin, onCancel} = await mount(two);
		await flush();

		stdin.write('q');
		await flush();

		expect(onCancel).toHaveBeenCalled();
	});

	it('offers to write them instead of discarding', async () => {
		const {stdin, onCancel} = await mount([two[0]!]);
		await flush();

		stdin.write('a');
		await flush();
		stdin.write('q');
		await flush();
		// ctrl+s from the leaving prompt saves rather than discards.
		stdin.write('\u0013');
		await flush(200);

		expect(onCancel).not.toHaveBeenCalled();
		await expect(readFile(path.join(root, 'characters/a.md'), 'utf8')).resolves.toContain(
			'id: a',
		);
	});

	it('opens the native buffer on "e"', async () => {
		const {stdin, lastFrame} = await mount([two[0]!]);
		await flush();

		stdin.write('e');
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).toContain('editing characters/a.md');
		expect(frame).toContain('^s save');
		// The diff gives up the screen to the buffer, keys and all.
		expect(frame).not.toContain('a accept');
	});

	it('writes the buffer back into the batch on ctrl+s', async () => {
		const {stdin, batch, lastFrame} = await mount([two[0]!]);
		await flush();

		stdin.write('e');
		await flush();
		stdin.write('X');
		await flush();
		stdin.write('\x13');
		await flush();

		expect(batch.items[0]?.contents).toBe(`X${two[0]!.contents}`);
		expect(batch.items[0]?.edited).toBe(true);
		expect(lastFrame()).toContain('a accept');
	});

	it('leaves the proposal alone when the buffer is cancelled', async () => {
		const {stdin, batch, lastFrame} = await mount([two[0]!]);
		await flush();

		stdin.write('e');
		await flush();
		stdin.write('X');
		await flush();
		stdin.write('\x1b');
		await flush(120);

		expect(batch.items[0]?.contents).toBe(two[0]!.contents);
		expect(batch.items[0]?.edited).toBe(false);
		expect(lastFrame()).toContain('a accept');
	});

	it('hands off to $EDITOR on ctrl+e and marks the item edited', async () => {
		const batch = await ReviewBatch.create(root, [two[0]!]);
		const onExternalEdit = vi.fn(async () => '---\nid: a\n---\n\n# A, by hand\n');
		const {stdin} = render(
			<DiffReview
				batch={batch}
				title="review"
				rows={40}
				columns={100}
				onDone={vi.fn()}
				onCancel={vi.fn()}
				onExternalEdit={onExternalEdit}
			/>,
		);
		await flush();

		stdin.write('e');
		await flush();
		stdin.write('\x05');
		await flush(120);

		expect(onExternalEdit).toHaveBeenCalledWith(two[0]!.contents, 'characters/a.md');
		expect(batch.items[0]?.edited).toBe(true);
		expect(batch.items[0]?.contents).toContain('by hand');
	});

	it('offers $EDITOR from the buffer only when the host supports it', async () => {
		const {stdin, lastFrame} = await mount([two[0]!]);
		await flush();

		stdin.write('e');
		await flush();

		expect(lastFrame()).not.toContain('$EDITOR');
	});

	it('shows a low-confidence proposal as such', async () => {
		const batch = await ReviewBatch.create(root, [
			{path: 'themes/x.md', contents: 'x\n', confidence: 'low', rationale: 'inferred'},
		]);
		const {lastFrame} = render(
			<DiffReview
				batch={batch}
				title="review"
				rows={40}
				columns={100}
				onDone={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).toContain('confidence: low');
		expect(frame).toContain('inferred');
	});

	it('handles an empty batch without crashing', async () => {
		const {lastFrame} = await mount([]);
		await flush();

		expect(lastFrame()).toContain('nothing to review');
	});
});

/**
 * `enter` only applies once every item is settled, which makes it a silent
 * no-op mid-review — accept two of five, press enter, nothing happens. `ctrl+s`
 * is the explicit way out, and it confirms first because applying is the one
 * irreversible thing this screen does.
 */
describe('ctrl+s saves, with a confirmation', () => {
	const CTRL_S = '\u0013';

	it('does not write on the first press', async () => {
		const {stdin, onDone, lastFrame} = await mount(two);
		await flush();

		stdin.write('a');
		await flush();
		stdin.write(CTRL_S);
		await flush();

		expect(onDone).not.toHaveBeenCalled();
		expect(lastFrame()).toContain('write 1 file(s)?');
	});

	it('says what will be skipped', async () => {
		const {stdin, lastFrame} = await mount(two);
		await flush();

		stdin.write('a');
		await flush();
		stdin.write(CTRL_S);
		await flush();

		expect(lastFrame()).toContain('1 still pending will be skipped');
	});

	it('writes on the second press, accepted items only', async () => {
		const {stdin, onDone} = await mount(two);
		await flush();

		stdin.write('a');
		await flush();
		stdin.write(CTRL_S);
		await flush();
		stdin.write(CTRL_S);
		await flush(120);

		expect(onDone).toHaveBeenCalledTimes(1);
		expect(onDone.mock.calls[0]![0].written).toEqual(['characters/a.md']);
		// The untouched second proposal is still pending, so it never lands.
		await expect(readFile(path.join(root, 'characters/b.md'), 'utf8')).rejects.toThrow();
	});

	it('backs out on any other key without writing', async () => {
		const {stdin, onDone, lastFrame} = await mount(two);
		await flush();

		stdin.write('a');
		await flush();
		stdin.write(CTRL_S);
		await flush();
		stdin.write('x');
		await flush();

		expect(onDone).not.toHaveBeenCalled();
		expect(lastFrame()).toContain('a accept');
	});

	/** A stray keystroke behind the prompt must not decide an item. */
	it('does not let a key press through to the review while confirming', async () => {
		const {stdin, lastFrame} = await mount(two);
		await flush();

		stdin.write(CTRL_S);
		await flush();
		stdin.write('a');
		await flush();

		expect(lastFrame()).toContain('0✔');
	});

	it('refuses when nothing is accepted', async () => {
		const {stdin, onDone, lastFrame} = await mount(two);
		await flush();

		stdin.write(CTRL_S);
		await flush();
		expect(lastFrame()).toContain('nothing is accepted');

		stdin.write(CTRL_S);
		await flush(120);
		expect(onDone).not.toHaveBeenCalled();
	});

	it('advertises ctrl+s in the footer', async () => {
		const {lastFrame} = await mount(two);
		await flush();

		expect(lastFrame()).toContain('ctrl+s save');
	});
});
