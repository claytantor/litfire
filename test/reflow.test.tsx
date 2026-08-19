import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {App} from '../source/app.js';
import type {Line} from '../source/commands/types.js';
import {DiffReview} from '../source/components/diff-review.js';
import {EditorScreen} from '../source/components/editor-screen.js';
import {InterviewScreen} from '../source/components/interview-screen.js';
import {Pager} from '../source/components/pager.js';
import {ProviderWizard} from '../source/components/provider-wizard.js';
import {SelectList} from '../source/components/select-list.js';
import type {EditorTurn} from '../source/editor/types.js';
import {InterviewSession} from '../source/interview/index.js';
import type {ChatMessage, Provider} from '../source/llm/index.js';
import {ReviewBatch} from '../source/review/index.js';
import {scaffoldVault} from '../source/vault/scaffold.js';
import {flush, heightOf, mount, widest} from './terminal.js';

/** Every width the layout has to survive, plus the narrow end of the range. */
const WIDTHS = [40, 60, 80, 200];

const paragraph =
	'The scene works but the last paragraph explains what the dialogue has already earned, and it flattens her into someone who narrates her own subtext.';

const longLines: Line[] = [
	{text: 'short'},
	{text: paragraph},
	{text: `  vault/characters/${'nested-'.repeat(12)}mira.md`},
	{text: 'a'.repeat(300)},
	{text: ''},
	...Array.from({length: 60}, (_unused, index) => ({
		text: `row-${String(index).padStart(3, '0')} ${paragraph}`,
	})),
];

let root = '';
let litfireHome = '';
let savedHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-reflow-'));
	litfireHome = await mkdtemp(path.join(tmpdir(), 'litfire-reflow-home-'));
	savedHome = process.env['LITFIRE_HOME'];
	process.env['LITFIRE_HOME'] = litfireHome;
});

afterEach(async () => {
	if (savedHome === undefined) {
		delete process.env['LITFIRE_HOME'];
	} else {
		process.env['LITFIRE_HOME'] = savedHome;
	}
	await rm(root, {recursive: true, force: true});
	await rm(litfireHome, {recursive: true, force: true});
});

/**
 * The two properties every screen owes the terminal it was handed.
 *
 * Overflowing either one is not cosmetic: a row wider than the terminal is
 * re-wrapped by the terminal itself and pushes the frame down, and a frame
 * taller than the viewport makes Ink clear the screen and replay all of
 * `<Static>` on every render.
 *
 * This measures one render's own output — what this screen drew. It is a real
 * property and worth holding, but it says nothing about what an *earlier* frame
 * may have left on the terminal; only `term.screen()` can see that. See the
 * `it.fails` at the end of this file for the part these cannot prove.
 */
function expectFits(frame: string, columns: number, rows: number) {
	expect(widest(frame)).toBeLessThanOrEqual(columns);
	expect(heightOf(frame)).toBeLessThanOrEqual(rows);
}

describe('Pager', () => {
	it.each(WIDTHS)('fits a %i-column terminal and keeps its hints', async columns => {
		const term = mount(
			<Pager
				title="pacing"
				lines={longLines}
				rows={24}
				columns={columns}
				onClose={vi.fn()}
			/>,
			columns,
			24,
		);
		await flush();

		const frame = term.frame();
		expectFits(frame, columns, 24);
		expect(frame).toContain('q close');
		term.unmount();
	});

	it('keeps the hint bar reachable on a 10-row terminal', async () => {
		const term = mount(
			<Pager title="pacing" lines={longLines} rows={10} columns={40} onClose={vi.fn()} />,
			40,
			10,
		);
		await flush();

		const frame = term.frame();
		expectFits(frame, 40, 10);
		expect(frame).toContain('q close');
		term.unmount();
	});

	it('reflows to the new width when the terminal is resized', async () => {
		const term = mount(
			<Pager
				title="pacing"
				lines={longLines}
				rows={40}
				columns={200}
				onClose={vi.fn()}
			/>,
			200,
			40,
		);
		await flush();
		const wide = term.frame();
		expect(widest(wide)).toBeGreaterThan(100);

		// The parent owns the size, so a resize arrives as new props — exactly what
		// App does off `useWindowSize`.
		await term.resize(44, 20);
		term.instance.rerender(
			<Pager title="pacing" lines={longLines} rows={20} columns={44} onClose={vi.fn()} />,
		);
		await flush();

		const narrow = term.frame();
		expectFits(narrow, 44, 20);
		// Nothing from the wide layout survived into the frame it drew. The
		// *terminal* may still be holding rows from the wide frame — that is
		// Ink's erase arithmetic, not this component's layout, and it is pinned
		// by the `it.fails` at the end of this file.
		expect(narrow).not.toContain(paragraph);
		term.unmount();
	});
});

describe('DiffReview', () => {
	const proposal = {
		path: `characters/${'deeply-'.repeat(8)}mira.md`,
		contents: `---\nid: mira\n---\n\n# Mira\n\n${paragraph}\n\n${'b'.repeat(240)}\n`,
		rationale: paragraph,
		confidence: 'low' as const,
	};

	it.each(WIDTHS)('fits a %i-column terminal and keeps the key hints', async columns => {
		const batch = await ReviewBatch.create(root, [proposal]);
		const term = mount(
			<DiffReview
				batch={batch}
				title="review — system"
				rows={24}
				columns={columns}
				onDone={vi.fn()}
				onCancel={vi.fn()}
			/>,
			columns,
			24,
		);
		await flush();

		const frame = term.frame();
		expectFits(frame, columns, 24);
		expect(frame).toContain('q cancel');
		term.unmount();
	});

	it('keeps the decision on screen on a 16-row terminal', async () => {
		const batch = await ReviewBatch.create(root, [proposal]);
		const term = mount(
			<DiffReview
				batch={batch}
				title="review — system"
				rows={16}
				columns={50}
				onDone={vi.fn()}
				onCancel={vi.fn()}
			/>,
			50,
			16,
		);
		await flush();

		const frame = term.frame();
		expectFits(frame, 50, 16);
		expect(frame).toContain('a accept');
		term.unmount();
	});

	/**
	 * Below about 14 rows the frame the gate *must* draw — border, which file is
	 * changing, the diff stat, and the keys out — is taller than the terminal.
	 * What is guaranteed there is that it degrades rather than breaks: the
	 * rationale and the overflow note give up their rows first, the decision and
	 * the way out survive, and nothing is drawn wider than the terminal.
	 */
	it('degrades rather than breaking on a 10-row terminal', async () => {
		const batch = await ReviewBatch.create(root, [proposal]);
		const term = mount(
			<DiffReview
				batch={batch}
				title="review"
				rows={10}
				columns={50}
				onDone={vi.fn()}
				onCancel={vi.fn()}
			/>,
			50,
			10,
		);
		await flush();

		const frame = term.frame();
		expect(widest(frame)).toBeLessThanOrEqual(50);
		expect(frame).toContain('a accept');
		expect(frame).toContain('• pending');
		// The rationale is the first thing to go, and the note goes with it.
		expect(frame).not.toContain('The scene works');
		expect(frame).not.toContain(' lines');
		term.unmount();
	});

	it('keeps the buffer’s save hint on screen while editing a long proposal', async () => {
		const batch = await ReviewBatch.create(root, [proposal]);
		const term = mount(
			<DiffReview
				batch={batch}
				title="review"
				rows={22}
				columns={44}
				onDone={vi.fn()}
				onCancel={vi.fn()}
			/>,
			44,
			22,
		);
		await flush();

		term.stdin.write('e');
		await flush(150);

		const frame = term.frame();
		expectFits(frame, 44, 22);
		expect(frame).toContain('^s save');
		expect(frame).toContain('esc cancel');
		term.unmount();
	});
});

describe('EditorScreen', () => {
	const turns: readonly EditorTurn[] = Array.from({length: 20}, (_unused, index) => ({
		role: index % 2 === 0 ? 'author' : 'editor',
		text: `${String(index).padStart(2, '0')} ${paragraph}`,
	}));

	it.each(WIDTHS)('fits a %i-column terminal and keeps the composer', async columns => {
		const term = mount(
			<EditorScreen
				turns={turns}
				streaming={undefined}
				status={undefined}
				busy={false}
				rows={24}
				columns={columns}
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
			/>,
			columns,
			24,
		);
		await flush();

		const frame = term.frame();
		expectFits(frame, columns, 24);
		expect(frame).toContain('ask the editor…');
		expect(frame).toContain('↑↓ scroll');
		term.unmount();
	});

	it('fits while a reply is streaming into a 14-row terminal', async () => {
		const term = mount(
			<EditorScreen
				turns={turns}
				streaming={`${paragraph} ${paragraph}`}
				status="thinking…"
				busy
				rows={14}
				columns={46}
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
			/>,
			46,
			14,
		);
		await flush();

		const frame = term.frame();
		expectFits(frame, 46, 14);
		expect(frame).toContain('the editor is replying…');
		term.unmount();
	});
});

/**
 * Streams one very long question slowly, so the measurement lands while the
 * question is still in the live region rather than after it has settled into
 * `<Static>` scrollback.
 */
function slowProvider(reply: string): Provider {
	return {
		id: 'openai',
		model: 'test',
		async listModels() {
			return [];
		},
		async *chat(_messages: readonly ChatMessage[]) {
			for (const word of reply.split(' ')) {
				await new Promise(done => {
					setTimeout(done, 4);
				});
				yield `${word} `;
			}
		},
	};
}

describe('InterviewScreen', () => {
	it('keeps the composer on screen while a long question streams in', async () => {
		await scaffoldVault(root);
		const provider = slowProvider(`${paragraph} ${paragraph} ${paragraph}`);
		const session = new InterviewSession({
			root,
			kind: 'system',
			provider,
			grounding: '',
			overlay: '',
		});

		const term = mount(
			<InterviewScreen
				session={session}
				provider={provider}
				root={root}
				grounding=""
				rows={16}
				columns={44}
				onDone={vi.fn()}
				onCancel={vi.fn()}
			/>,
			44,
			16,
		);
		await flush(300);

		const frame = term.frame();
		expectFits(frame, 44, 16);
		// Still mid-question: the live region carries the partial, the composer,
		// and the exit hint, and all three fit.
		expect(frame).toContain('◆ interviewer');
		expect(frame).toContain('waiting for the interviewer…');
		expect(frame).toContain('for a usable pass');
		term.unmount();
	});
});

describe('SelectList', () => {
	const items = Array.from({length: 40}, (_unused, index) => ({
		value: `model-${String(index)}`,
		label: `provider/very-long-model-identifier-${String(index).padStart(3, '0')}-preview`,
		hint: '— a note about this model that runs long',
	}));

	it.each(WIDTHS)('stays inside a %i-column, 10-row budget', async columns => {
		const term = mount(
			<SelectList items={items} height={10} width={columns - 4} onSelect={vi.fn()} />,
			columns,
			24,
		);
		await flush();

		const frame = term.frame();
		expect(widest(frame)).toBeLessThanOrEqual(columns);
		expect(heightOf(frame)).toBeLessThanOrEqual(10);
		term.unmount();
	});
});

describe('ProviderWizard', () => {
	it.each(WIDTHS)('fits a %i-column, 12-row terminal', async columns => {
		const term = mount(
			<ProviderWizard rows={12} columns={columns} onDone={vi.fn()} onCancel={vi.fn()} />,
			columns,
			12,
		);
		await flush();

		const frame = term.frame();
		expectFits(frame, columns, 12);
		expect(frame).toContain('/provider');
		term.unmount();
	});
});

describe('the app shell', () => {
	it.each(WIDTHS)('fits a %i-column terminal', async columns => {
		await scaffoldVault(root);
		const term = mount(<App root={root} version="1.2.3" watch={false} />, columns, 24);
		await flush(200);

		const frame = term.frame();
		expect(widest(frame)).toBeLessThanOrEqual(columns);
		expect(frame).toContain('/help for commands');
		term.unmount();
	});

	it('reflows the footer and composer across a resize', async () => {
		await scaffoldVault(root);
		const term = mount(<App root={root} version="1.2.3" watch={false} />, 200, 40);
		await flush(200);
		expect(widest(term.frame())).toBeLessThanOrEqual(200);

		await term.resize(44, 18);
		await flush(100);

		const narrow = term.frame();
		expect(widest(narrow)).toBeLessThanOrEqual(44);
		// The status region survives the squeeze rather than being clipped away.
		expect(narrow).toContain('unplaced');

		await term.resize(120, 30);
		await flush(100);
		expect(widest(term.frame())).toBeLessThanOrEqual(120);
		term.unmount();
	});

	/**
	 * The height work in this file exists to keep Ink off its
	 * `shouldClearTerminalForFrame` path, which answers an over-tall frame by
	 * writing `clearTerminal + every <Static> line so far + the frame` on every
	 * render. This is the assertion that actually proves it: composite the whole
	 * session and count how many times the banner reached the terminal.
	 */
	it('writes each <Static> line exactly once, however the window is dragged', async () => {
		await scaffoldVault(root);
		const term = mount(<App root={root} version="1.2.3" watch={false} />, 90, 24, false);
		await flush(250);

		term.stdin.write('/timeline');
		await flush(60);
		term.stdin.write('\r');
		await flush(400);

		await term.drag([
			[70, 24],
			[54, 20],
			[80, 26],
			[44, 18],
		]);

		const composited = term.buffer();
		expect(composited.split('litfire v1.2.3')).toHaveLength(2);
		expect(composited.split('› /timeline')).toHaveLength(2);
		term.unmount();
	});

	it('never composites a row wider than the terminal during a drag', async () => {
		await scaffoldVault(root);
		const term = mount(<App root={root} version="1.2.3" watch={false} />, 120, 30, false);
		await flush(250);

		await term.drag([
			[104, 30],
			[88, 26],
			[72, 22],
			[56, 18],
			[44, 16],
		]);

		// Residue rows are reflowed by the terminal, so they stay inside the
		// width even when they should not be there at all — which is precisely
		// why the width assertions below can pass while the screen is wrong.
		expect(widest(term.screen())).toBeLessThanOrEqual(44);
		// The live region is still correct and still the last thing on screen.
		// The footer wraps to two rows at this width, so the tail is where both
		// halves of it land.
		const tail = term.screen().split('\n').slice(-2).join('\n');
		expect(tail).toContain('unplaced');
		expect(tail).toContain('no provider');
		term.unmount();
	});

	/**
	 * KNOWN DEFECT — Ink 7.1.1, no fix published (7.1.1 is latest).
	 *
	 * `log-update.js:49` erases with `eraseLines(previousLineCount)` where
	 * `previousLineCount = str.split('\n').length` — *logical* lines. When a
	 * window is dragged narrower the terminal reflows what it is already
	 * showing, so a row written at 100 columns becomes two rows at 96. Ink then
	 * erases fewer rows than the old frame occupies and draws the new frame
	 * below the survivors. `ink.js:279` only clears at all when the width
	 * decreases, and that clear has the same arithmetic.
	 *
	 * No layout choice can satisfy the real invariant — "no emitted line may
	 * exceed the terminal width at the moment Ink erases it" — because the next
	 * width is not knowable. Clearing the screen on resize does fix it, and
	 * costs the whole on-screen `<Static>` log; that trade is the user's.
	 *
	 * `it.fails` records the invariant we want and the fact that it does not
	 * hold. When it starts passing, this turns red — flip it to `it(...)`.
	 */
	// Was `it.fails` while ink@7.1.1 erased by logical line count. Fixed by
	// patches/ink@7.1.1.patch, which counts the terminal rows a frame actually
	// occupies at the current width. If this goes red, the patch has been lost.
	it('leaves no fragment of an earlier frame behind when dragged narrower', async () => {
		await scaffoldVault(root);
		const term = mount(<App root={root} version="1.2.3" watch={false} />, 100, 30, false);
		await flush(250);

		await term.drag([
			[96, 30],
			[92, 30],
			[88, 30],
			[84, 30],
			[80, 30],
		]);

		// The composer is the only bordered box on this screen, so its top
		// border is a direct count of how many frames are visible at once.
		const tops = term
			.screen()
			.split('\n')
			.filter(row => row.includes('╭'));
		expect(tops).toHaveLength(1);
		term.unmount();
	});

	/**
	 * The app renders with `incrementalRendering: true` (source/cli.tsx), which is
	 * a different renderer entirely — it walks logical lines, `cursorUp`s by
	 * `previousLines.length`, and skips unchanged ones with `cursorNextLine`. All
	 * three assume one logical line occupies one terminal row, which is exactly
	 * what a resize stops being true. Every other test here mounts without the
	 * flag, so they exercise a path the shipped binary never takes.
	 */
	it('leaves no fragment with incrementalRendering, as the app renders', async () => {
		await scaffoldVault(root);
		const term = mount(
			<App root={root} version="1.2.3" watch={false} />,
			100,
			30,
			false,
			{incrementalRendering: true},
		);
		await flush(250);

		await term.drag([
			[96, 30],
			[92, 30],
			[88, 30],
			[84, 30],
			[80, 30],
		]);

		const tops = term
			.screen()
			.split('\n')
			.filter(row => row.includes('\u256d'));
		expect(tops).toHaveLength(1);
		term.unmount();
	});
});
