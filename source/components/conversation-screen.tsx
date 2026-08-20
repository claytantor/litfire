import {Box, Text, useInput} from 'ink';
import Spinner from 'ink-spinner';
import {useMemo, useState, type ReactElement} from 'react';
import type {Line} from '../commands/types.js';
import type {ConversationRole, ConversationTurn} from '../conversation/types.js';
import {
	contentWidth,
	rowsFor,
	splitRow,
	viewportHeight,
	wrapText,
} from '../hooks/use-viewport.js';
import {theme} from '../theme.js';
import {Composer} from './composer.js';
import {LineView} from './line-view.js';

type Props = {
	readonly turns: readonly ConversationTurn[];
	/** Partial reply mid-stream; undefined when not streaming. */
	readonly streaming: string | undefined;
	/** Short activity note, e.g. "scanning 12 files…". */
	readonly status: string | undefined;
	readonly busy: boolean;
	readonly rows: number;
	readonly columns: number;
	readonly onSubmit: (text: string) => void;
	/** esc — cancels an in-flight reply, or leaves the conversation when idle. */
	readonly onCancel: () => void;
	/**
	 * Who the assistant side of the conversation is — `reviewer`, `architect`.
	 *
	 * Names every user-visible mention of them: the heading, the turn labels,
	 * the placeholder, the busy line. Required, and deliberately without a
	 * default: this screen is shared, and the last time it defaulted, it greeted
	 * `/architect` users as the editor. A screen that names the wrong agent is
	 * worse than one that names none, and the type system is a better guard
	 * against that than remembering to pass the prop.
	 */
	readonly speaker: string;
};

type Speaker = {readonly label: string; readonly color: string};

/**
 * The turn labels, keyed by role rather than chosen by a ternary: if
 * `ConversationRole` ever grows a third member this stops compiling, instead of
 * silently rendering the new role in the agent's colours.
 */
function speakersFor(speaker: string): Record<ConversationRole, Speaker> {
	return {
		author: {label: `${theme.symbol.user} you`, color: theme.color.user},
		agent: {
			label: `${theme.symbol.assistant} ${speaker}`,
			color: theme.color.assistant,
		},
	};
}

/** One turn as speaker row, wrapped body rows, and a blank to separate it. */
function turnLines(
	role: ConversationRole,
	text: string,
	width: number,
	speakers: Record<ConversationRole, Speaker>,
): Line[] {
	const speaker = speakers[role];
	return [
		{text: speaker.label, color: speaker.color},
		...wrapText(text, width).map(row => ({text: row})),
		{text: ''},
	];
}

/**
 * The `/editor` conversation (§9): the author asks, a literary editor answers
 * over the whole corpus, and the reply streams so the wait reads as thinking
 * rather than as a hang.
 *
 * Purely presentational — `turns` is the source of truth and belongs to the
 * caller. This screen owns a draft and a scroll position and nothing else, so
 * the conversation survives it being unmounted.
 *
 * Unlike interview-screen.tsx this does *not* use `<Static>`. Static output is
 * permanent and beyond the app's reach once written, which rules out the
 * scroll-back the author needs to re-read an agent's earlier reasoning while a
 * new reply is still arriving. The cost is that the transcript is windowed here
 * (§10) the way pager.tsx and diff-review.tsx window theirs.
 */
export function ConversationScreen({
	turns,
	streaming,
	status,
	busy,
	rows,
	columns,
	onSubmit,
	onCancel,
	speaker,
}: Props): ReactElement {
	/**
	 * Memoised on the speaker, not rebuilt per render.
	 *
	 * This is a dependency of the memo that wraps the *entire* conversation, so
	 * a fresh object each render meant re-wrapping every turn on every frame —
	 * and during a streaming reply that is every token. The work is quadratic in
	 * the length of the conversation and it happens while the terminal is at its
	 * busiest.
	 */
	const speakers = useMemo(() => speakersFor(speaker), [speaker]);
	const [draft, setDraft] = useState('');
	/**
	 * Counted from the *tail*, not the head: 0 always means "pinned to the live
	 * edge", so following new output is a property of the anchor rather than
	 * something an effect has to chase. A head-anchored offset (pager.tsx) drifts
	 * one row further behind with every line the agent streams, and correcting
	 * that needs a second piece of state — "has the author scrolled back?" — that
	 * this screen has no business owning.
	 */
	const [scrollUp, setScrollUp] = useState(0);

	// Round border (2) plus paddingX={1} (2).
	const width = contentWidth(columns);
	// The status and hint rows sit outside the border, so they only pay for the
	// screen's own paddingX.
	const outerWidth = contentWidth(columns, 2);

	const settled = useMemo(
		() => turns.flatMap(turn => turnLines(turn.role, turn.text, width, speakers)),
		[turns, width, speakers],
	);

	// Kept separate from `settled` so an arriving token re-wraps only the partial
	// reply, not the entire conversation standing behind it.
	const partial = useMemo(
		() => (streaming === undefined ? [] : turnLines('agent', streaming, width, speakers)),
		[streaming, width, speakers],
	);

	const lines = useMemo(() => [...settled, ...partial], [settled, partial]);

	// Widest the right half can get, so the header's height does not depend on
	// the height it is helping to compute.
	const header = splitRow(speaker, `↑ ${String(lines.length)} back · ↓ to follow`, width);
	const statusText = busy ? ` ${status ?? 'thinking…'} · esc to cancel` : (status ?? ' ');
	const hintText = `↑↓ scroll · pgup/pgdn page · enter send · esc ${
		busy ? 'cancel reply' : 'back'
	}`;

	// rows − chrome: border (2), title, status, composer (3), hints, and a row of
	// slack. Every one of those single rows becomes two on a terminal too narrow
	// for it, so they are measured rather than counted. The transcript is what
	// gives way on a short terminal; the composer has to stay reachable at every
	// height.
	const chrome =
		2 +
		// Widest the header can get, so its height does not depend on the height
		// it is helping to compute.
		header.rows +
		rowsFor(statusText, outerWidth) +
		3 +
		rowsFor(hintText, outerWidth) +
		1;
	const height = viewportHeight(rows, chrome, 3);
	const maxUp = Math.max(0, lines.length - height);
	// Clamped at render rather than in state: `lines` grows underneath the offset
	// on every token, so a value stored clamped would be stale by the next frame.
	const up = Math.min(scrollUp, maxUp);
	const start = Math.max(0, lines.length - height - up);
	const visible = lines.slice(start, start + height);

	useInput((_input, key) => {
		// First, and deliberately not behind a `busy` guard — the same reasoning
		// interview-screen.tsx gives for keeping esc live through `finishing`. The
		// reply the author most needs to escape is the one that has hung, and
		// guarding this leaves killing the process as the only way out.
		if (key.escape) {
			onCancel();
			return;
		}
		// Only non-printing keys are bound. The composer's text input shares this
		// keyboard, so pager.tsx's j/k/g/G would scroll the transcript *and* type
		// themselves into the draft.
		if (key.upArrow) {
			setScrollUp(current => Math.min(maxUp, current + 1));
			return;
		}
		if (key.downArrow) {
			setScrollUp(current => Math.max(0, current - 1));
			return;
		}
		if (key.pageUp) {
			setScrollUp(current => Math.min(maxUp, current + height));
			return;
		}
		if (key.pageDown) {
			setScrollUp(current => Math.max(0, current - height));
		}
	});

	const submit = (value: string) => {
		const trimmed = value.trim();
		setDraft('');

		if (trimmed === '') {
			return;
		}

		// Sending is an implicit "show me what happens next", so it returns to the
		// tail — otherwise the reply to the question just asked arrives off-screen.
		setScrollUp(0);
		onSubmit(trimmed);
	};

	return (
		<Box flexDirection="column">
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={theme.color.border}
				paddingX={1}
			>
				<Box
					flexDirection={header.stacked ? 'column' : 'row'}
					justifyContent="space-between"
				>
					<Text bold color={theme.color.brand}>
						{speaker}
					</Text>
					{/*
						Says plainly when the view is not at the live edge. Replies keep
						streaming while the author reads back, and a transcript that looks
						idle but is not is how someone concludes the agent has stalled.
					*/}
					{up > 0 ? (
						<Text color="#e0af68">↑ {up} back · ↓ to follow</Text>
					) : (
						<Text dimColor>
							{lines.length > height ? `last ${height} of ${lines.length}` : 'following'}
						</Text>
					)}
				</Box>

				<Box flexDirection="column">
					{lines.length === 0 ? (
						<Text dimColor wrap="wrap">
							Nothing asked yet — try a character&apos;s arc, a gap in the timeline, or a
							name spelled two ways.
						</Text>
					) : (
						visible.map((line, index) => (
							<LineView key={`${start + index}`} line={line} />
						))
					)}
				</Box>
			</Box>

			{/*
				Always occupies its row, spinner or not, so the transcript above does
				not shift by one every time the agent starts or stops working.
			*/}
			<Box paddingX={1}>
				{busy && (
					<Text color={theme.color.brand}>
						<Spinner type="dots" />
					</Text>
				)}
				<Text dimColor>{statusText}</Text>
			</Box>

			{/*
				Reuses Composer rather than a bare TextInput: Ink delivers a paste or a
				piped line as one chunk with no key.return, and Composer is where that
				newline-boundary handling lives. A second input widget here would
				silently reintroduce the bug.
			*/}
			<Composer
				value={draft}
				onChange={setDraft}
				onSubmit={submit}
				disabled={busy}
				placeholder={`ask the ${speaker}…`}
				busyLabel={`the ${speaker} is replying…`}
			/>

			<Box paddingX={1}>
				<Text dimColor>{hintText}</Text>
			</Box>
		</Box>
	);
}
