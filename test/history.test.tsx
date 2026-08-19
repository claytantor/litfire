import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {render} from 'ink-testing-library';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Composer} from '../source/components/composer.js';
import {appendHistory, extendHistory, readHistory} from '../source/vault/history.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

const UP = '[A';
const DOWN = '[B';

/** Ink batches a keypress into the next frame; one tick is enough to see it. */
const flush = (ms = 40) => new Promise(done => setTimeout(done, ms));

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-history-'));
	await scaffoldVault(root, 'arcane');
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

describe('the history file', () => {
	it('round-trips through the vault cache', async () => {
		await appendHistory(root, '/lint');
		await appendHistory(root, '/system show');

		expect(await readHistory(root)).toEqual(['/lint', '/system show']);
	});

	it('lives in .litrpg, so deleting the cache costs only convenience', async () => {
		await appendHistory(root, '/lint');

		const raw = await readFile(resolve(root, `${VAULT.meta}/history.json`), 'utf8');
		expect(JSON.parse(raw)).toEqual(['/lint']);
	});

	it('survives a corrupt file rather than reporting one', async () => {
		await appendHistory(root, '/lint');
		const {writeFile} = await import('node:fs/promises');
		await writeFile(resolve(root, `${VAULT.meta}/history.json`), 'not json', 'utf8');

		expect(await readHistory(root)).toEqual([]);
	});

	it('is empty in a vault that has none', async () => {
		expect(await readHistory(root)).toEqual([]);
	});
});

describe('extendHistory', () => {
	it('collapses a repeated command the way a shell does', () => {
		let history = extendHistory([], '/lint');
		history = extendHistory(history, '/lint');
		history = extendHistory(history, '/lint');

		expect(history).toEqual(['/lint']);
	});

	it('keeps a repeat that is not consecutive', () => {
		let history = extendHistory([], '/lint');
		history = extendHistory(history, '/questions');
		history = extendHistory(history, '/lint');

		expect(history).toEqual(['/lint', '/questions', '/lint']);
	});

	it('ignores blank input', () => {
		expect(extendHistory(['/lint'], '   ')).toEqual(['/lint']);
	});

	it('caps the list so the file cannot grow without bound', () => {
		let history: string[] = [];
		for (let index = 0; index < 260; index += 1) {
			history = extendHistory(history, `/command-${index}`);
		}

		expect(history).toHaveLength(200);
		// The cap drops the oldest, never the newest.
		expect(history.at(-1)).toBe('/command-259');
	});
});

describe('arrowing through history', () => {
	function harness(history: readonly string[], initial = '') {
		let value = initial;
		const {stdin, rerender} = render(
			<Composer
				value={value}
				onChange={next => {
					value = next;
					rerender(
						<Composer
							value={value}
							onChange={n => {
								value = n;
							}}
							onSubmit={() => {}}
							disabled={false}
							history={history}
						/>,
					);
				}}
				onSubmit={() => {}}
				disabled={false}
				history={history}
			/>,
		);
		return {stdin, current: () => value};
	}

	it('walks backwards from the newest entry', async () => {
		const {stdin, current} = harness(['/lint', '/questions', '/system show']);

		stdin.write(UP);
		await flush();
		expect(current()).toBe('/system show');

		stdin.write(UP);
		await flush();
		expect(current()).toBe('/questions');
	});

	it('stops at the oldest rather than wrapping', async () => {
		const {stdin, current} = harness(['/lint', '/questions']);

		for (let index = 0; index < 5; index += 1) {
			stdin.write(UP);
			await flush(20);
		}

		expect(current()).toBe('/lint');
	});

	it('walks forward again and hands back the interrupted draft', async () => {
		const {stdin, current} = harness(['/lint', '/questions'], '/chap');

		stdin.write(UP);
		await flush();
		stdin.write(UP);
		await flush();
		expect(current()).toBe('/lint');

		stdin.write(DOWN);
		await flush();
		expect(current()).toBe('/questions');

		stdin.write(DOWN);
		await flush();
		// Past the newest is the half-typed line, not an empty box.
		expect(current()).toBe('/chap');
	});

	it('does nothing with an empty history', async () => {
		const {stdin, current} = harness([], '/half');

		stdin.write(UP);
		await flush();

		expect(current()).toBe('/half');
	});

	it('ignores arrows while busy', async () => {
		let value = '';
		const {stdin} = render(
			<Composer
				value={value}
				onChange={next => {
					value = next;
				}}
				onSubmit={() => {}}
				disabled
				history={['/lint']}
			/>,
		);

		stdin.write(UP);
		await flush();

		expect(value).toBe('');
	});
});

const mountComposer = (over: {disabled: boolean; busyLabel?: string}) =>
	render(
		<Composer
			value=""
			onChange={() => {}}
			onSubmit={() => {}}
			disabled={over.disabled}
			{...(over.busyLabel === undefined ? {} : {busyLabel: over.busyLabel})}
		/>,
	);

describe('waiting on a model', () => {
	/** `cli-spinners`' dots frames — one of these is on screen at any instant. */
	const DOTS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

	it('shows an animated icon beside the label while disabled', async () => {
		// Every model call in the app disables the composer, and until now the
		// only sign of one was a word that never moved — indistinguishable from a
		// hang on a request that takes a minute and a half.
		const ui = mountComposer({disabled: true, busyLabel: 'extracting 2 of 4…'});
		await flush();

		const frame = ui.lastFrame() ?? '';
		expect(frame).toMatch(DOTS);
		expect(frame).toContain('extracting 2 of 4…');
		ui.unmount();
	});

	it('actually animates rather than rendering one static glyph', async () => {
		const ui = mountComposer({disabled: true});
		await flush();
		const first = DOTS.exec(ui.lastFrame() ?? '')?.[0];
		// Longer than one spinner interval (80ms for dots).
		await flush(260);
		const later = DOTS.exec(ui.lastFrame() ?? '')?.[0];

		expect(first).toBeDefined();
		expect(later).toBeDefined();
		expect(later).not.toBe(first);
		ui.unmount();
	});

	it('shows no spinner when the author can type', async () => {
		const ui = mountComposer({disabled: false});
		await flush();
		expect(ui.lastFrame() ?? '').not.toMatch(DOTS);
		ui.unmount();
	});
});
