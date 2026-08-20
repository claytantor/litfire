import {Box, Text, useInput} from 'ink';
import {useMemo, useState} from 'react';
import type {Line} from '../commands/types.js';
import {
	contentWidth,
	rowsFor,
	rowsForAll,
	splitRow,
	useWrappedLines,
	viewportHeight,
	wrapText,
} from '../hooks/use-viewport.js';
import {
	diffStat,
	renderDiff,
	type ApplyOutcome,
	type ReviewBatch,
	type ReviewItem,
} from '../review/index.js';
import {useSpinnerFrame} from '../hooks/use-spinner.js';
import {theme} from '../theme.js';
import {LineView} from './line-view.js';
import {TextBuffer} from './text-buffer.js';

type Props = {
	readonly batch: ReviewBatch;
	readonly title: string;
	readonly rows: number;
	readonly columns: number;
	readonly onDone: (outcome: ApplyOutcome) => void;
	readonly onCancel: () => void;
	/**
	 * Opens the current proposal in $EDITOR and resolves with the edited text.
	 * `undefined` means the author backed out — leave the proposal alone.
	 */
	readonly onExternalEdit?: (
		contents: string,
		path: string,
	) => Promise<string | undefined>;
};

/**
 * The review gate (§9): every LLM write is shown as a unified diff with
 * accept / reject / edit / accept-all-in-this-batch. Nothing reaches disk
 * without an explicit decision (P3).
 *
 * `e` opens the §10 native buffer over the diff, so the ruling and the text it
 * rules on stay in one frame. $EDITOR remains reachable from inside it (^e) for
 * the edits a one-screen buffer is the wrong shape for.
 */
/** What this item does to the file, for the row that measures and the row that draws. */
function label(item: ReviewItem | undefined): string {
	if (item === undefined) {
		return '';
	}
	if (item.proposal.remove === true) {
		return ' (removes file)';
	}
	// Called out because `raw/` is the author's own record and everything else
	// in the tool is forbidden from touching it. A change here should never look
	// like an ordinary corpus write.
	if (item.proposal.path.startsWith('raw/')) {
		return item.existing === undefined ? ' (new raw file)' : ' (your raw record)';
	}
	return item.existing === undefined ? ' (new file)' : '';
}

export function DiffReview({
	batch,
	title,
	rows,
	columns,
	onDone,
	onCancel,
	onExternalEdit,
}: Props) {
	// The batch is mutable; this counter forces a re-render after each decision.
	const [revision, setRevision] = useState(0);
	const [busy, setBusy] = useState(false);
	const frame = useSpinnerFrame(busy);
	// Two-step save: `ctrl+s` asks, a second `ctrl+s` writes. Applying is the one
	// irreversible thing this screen does, and the confirm is where the author
	// finds out that pending items are about to be skipped rather than written.
	/**
	 * Which question is on screen, if any.
	 *
	 * `write` is the deliberate save. `discard` is the one that was missing: `q`
	 * and `esc` used to call `onCancel` outright, so an author who accepted six
	 * proposals and then left the gate lost all six with nothing said. Accepting
	 * marks a decision; only applying writes it, and that distinction is
	 * invisible until it costs someone their work.
	 */
	const [prompt, setPrompt] = useState<'none' | 'write' | 'discard'>('none');
	const [editing, setEditing] = useState(false);
	const bump = () => setRevision(n => n + 1);

	const item = batch.current;
	const counts = batch.counts();

	const {lines, stat} = useMemo(() => {
		if (!item) {
			return {lines: [], stat: {added: 0, removed: 0}};
		}
		return {lines: renderDiff(item), stat: diffStat(item)};
		// `revision` is the signal that the mutable batch changed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [item, revision]);

	const width = contentWidth(columns);
	// Wrapped before it is windowed: a diff row wider than the terminal costs
	// the viewport every row it takes, and counting it as one is what pushed the
	// key hints off the bottom of a narrow terminal.
	const wrapped = useWrappedLines(lines, width);

	const [offset, setOffset] = useState(0);

	/**
	 * Accepted items whose path the gate would refuse anyway.
	 *
	 * `apply` already reports these as failures afterwards, but afterwards is too
	 * late to be useful — an author who just confirmed a save should not learn at
	 * that point that one of the writes was never possible.
	 */
	const blocked = useMemo(() => {
		const unsafe = new Set(batch.validatePaths().map(problem => problem.path));
		return batch.items.filter(
			item => item.decision === 'accepted' && unsafe.has(item.proposal.path),
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [batch, revision]);

	const badge =
		item?.decision === 'accepted'
			? {text: '✔ accepted', color: theme.color.assistant}
			: item?.decision === 'rejected'
				? {text: '✖ rejected', color: theme.color.error}
				: {text: '• pending', color: '#e0af68'};

	/**
	 * The frame around the diff, measured rather than assumed.
	 *
	 * Every one of these rows can wrap — a proposal path, a rationale, and the
	 * key hints all outgrow a narrow terminal — and the old `rows - 12` counted
	 * each of them as one. The diff window is what gives way; the hints and the
	 * decision have to stay on screen at every size.
	 */
	// `busy` here covers writing the batch *and* waiting on the author's $EDITOR,
	// which blocks until they close it. A static word through a multi-minute wait
	// on an external process is the worst case for looking hung.
	const hints: readonly Line[] = busy
		? [{text: `${frame} working…`.trim(), dim: true}]
		: prompt === 'discard'
			? [
					{
						text: `${String(counts.accepted)} accepted change(s) have not been written yet`,
						color: '#e0af68',
					},
					{
						text: 'ctrl+s to write them · esc again to discard · any other key to go back',
						dim: true,
					},
				]
			: prompt === 'write'
				? [
						blocked.length > 0
							? {
									text: `${String(blocked.length)} accepted item(s) have a path the vault refuses — ${blocked
										.map(entry => entry.proposal.path)
										.join(', ')}`,
									color: theme.color.error,
								}
							: counts.accepted === 0
								? {
										text: 'nothing is accepted — there is nothing to write',
										color: '#e0af68',
									}
								: {
										text: `write ${String(counts.accepted)} file(s)?${
											counts.rejected + counts.pending > 0
												? ` ${String(counts.rejected)} rejected and ${String(counts.pending)} still pending will be skipped`
												: ''
										}`,
										color: '#e0af68',
									},
						{
							text:
								counts.accepted > 0 && blocked.length === 0
									? 'ctrl+s again to write · any other key to go back'
									: 'any key to go back',
							dim: true,
						},
					]
				: [
						{
							text: `a accept · r reject · ${
								item?.proposal.remove === true ? '' : 'e edit · '
							}A accept-all · ←→ item · ↑↓ scroll · ${
								batch.settled ? 'enter apply · ' : ''
							}ctrl+s save · q cancel`,
							dim: true,
						},
					];

	/** The hints wrap on a narrow terminal; the diff window pays for it. */
	const hintRows = rowsForAll(
		hints.map(hint => hint.text),
		width,
	);

	const header = splitRow(
		title,
		`${String(batch.cursor + 1)}/${String(batch.size)} · ${String(counts.accepted)}✔ ${String(counts.rejected)}✖ ${String(counts.pending)}•`,
		width,
	);
	const pathRow = splitRow(
		`${item?.proposal.path ?? ''}${label(item)}${
			item?.edited === true ? ' (edited)' : ''
		}`,
		badge.text,
		width,
	);
	const statRows = rowsFor(
		`+${String(stat.added)} −${String(stat.removed)}${
			item?.proposal.confidence === 'low' ? ' · confidence: low' : ''
		}`,
		width,
	);

	/**
	 * What cannot be given up: the border, which file is about to change, what
	 * the change amounts to, and the keys that get the author out. Everything
	 * else is spent from what is left over.
	 */
	const essential =
		2 + header.rows + pathRow.rows + statRows + 2 /* the two marginTops */ + hintRows;
	const spare = rows - essential;

	// The "… n/m lines" note only earns its row once there is a window worth
	// describing.
	const noteRow = spare > 2 ? 1 : 0;

	/**
	 * The rationale is the one part of the frame that can be arbitrarily long,
	 * so it is windowed like everything else — a few rows when there is room,
	 * none at all when the terminal is too short to afford them. It explains the
	 * decision; it must never be the reason the decision scrolls away.
	 */
	const rationale =
		item?.proposal.rationale === undefined
			? []
			: wrapText(item.proposal.rationale, width).slice(
					0,
					Math.max(0, Math.min(4, spare - noteRow - 1)),
				);

	const height = viewportHeight(rows, essential + noteRow + rationale.length);
	const maxOffset = Math.max(0, wrapped.length - height);
	// Clamped at render: a resize changes `height` underneath a stored offset, so
	// a value clamped in state would be stale by the next frame.
	const clamped = Math.min(offset, maxOffset);

	const finish = () => {
		setBusy(true);
		void (async () => {
			onDone(await batch.apply());
		})();
	};

	const external = () => {
		if (onExternalEdit === undefined || !item) {
			return;
		}
		// Close the buffer first: $EDITOR takes the terminal, and returning to a
		// buffer still seeded with the pre-edit text would undo what it wrote.
		setEditing(false);
		setBusy(true);
		void (async () => {
			const edited = await onExternalEdit(item.contents, item.proposal.path);
			if (edited !== undefined) {
				batch.edit(edited);
			}
			setBusy(false);
			bump();
		})();
	};

	useInput(
		(input, key) => {
			if (busy) {
				return;
			}

			// While confirming, every key means yes or no and nothing else — a
			// stray `a` must not quietly accept another item behind the prompt.
			if (prompt !== 'none') {
				if (key.ctrl && input === 's' && counts.accepted > 0 && blocked.length === 0) {
					setPrompt('none');
					finish();
					return;
				}
				// Leaving is confirmed by repeating the key that asked, so an author
				// who meant it is one keystroke away and one who did not is safe.
				if (prompt === 'discard' && (key.escape || input === 'q')) {
					onCancel();
					return;
				}
				setPrompt('none');
				return;
			}

			if (key.ctrl && input === 's') {
				setPrompt('write');
				return;
			}
			if (key.escape || input === 'q') {
				// Nothing accepted means nothing to lose, and asking then would be
				// a prompt that always has the same answer.
				if (counts.accepted > 0) {
					setPrompt('discard');
					return;
				}
				onCancel();
				return;
			}
			if (input === 'a') {
				batch.decide('accepted');
				setOffset(0);
				bump();
				return;
			}
			if (input === 'r') {
				batch.decide('rejected');
				setOffset(0);
				bump();
				return;
			}
			if (input === 'A') {
				batch.acceptAllPending();
				bump();
				return;
			}
			// Not offered for a removal: there is nothing to edit, and the buffer
			// would accept changes that `applyAccepted` then ignores — it deletes
			// on the proposal's say-so, not on the contents. Reject it instead.
			if (input === 'e' && item && item.proposal.remove !== true) {
				setEditing(true);
				return;
			}
			if (key.rightArrow || input === 'n') {
				batch.move(1);
				setOffset(0);
				bump();
				return;
			}
			if (key.leftArrow || input === 'p') {
				batch.move(-1);
				setOffset(0);
				bump();
				return;
			}
			if (key.downArrow || input === 'j') {
				setOffset(current => Math.min(maxOffset, current + 1));
			}
			if (key.upArrow || input === 'k') {
				setOffset(current => Math.max(0, current - 1));
			}
			if (key.pageDown || input === ' ') {
				setOffset(current => Math.min(maxOffset, current + height));
			}
			if (key.pageUp) {
				setOffset(current => Math.max(0, current - height));
			}
			if (key.return && batch.settled) {
				finish();
			}
		},
		// The buffer owns the keyboard while it is open; every key is text there.
		{isActive: !editing},
	);

	if (!item) {
		return (
			<Box borderStyle="round" borderColor={theme.color.border} paddingX={1}>
				<Text dimColor>nothing to review</Text>
			</Box>
		);
	}

	return (
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
					{title}
				</Text>
				<Text dimColor>
					{batch.cursor + 1}/{batch.size} · {counts.accepted}✔ {counts.rejected}✖{' '}
					{counts.pending}•
				</Text>
			</Box>

			<Box
				flexDirection={pathRow.stacked ? 'column' : 'row'}
				justifyContent="space-between"
			>
				<Text>
					<Text color={theme.color.user}>{item.proposal.path}</Text>
					{item.proposal.path.startsWith('raw/') && item.proposal.remove !== true ? (
						<Text color="#e0af68">{label(item)}</Text>
					) : item.proposal.remove === true ? (
						// Coloured like an error rather than dimmed: this is the one
						// decision in the gate that cannot be undone by rejecting the
						// next item, and it should not look like an ordinary write.
						<Text color={theme.color.error}> (removes file)</Text>
					) : (
						item.existing === undefined && <Text dimColor> (new file)</Text>
					)}
					{item.edited && <Text color="#e0af68"> (edited)</Text>}
				</Text>
				<Text color={badge.color}>{badge.text}</Text>
			</Box>

			<Box>
				<Text dimColor>
					+{stat.added} −{stat.removed}
					{item.proposal.confidence === 'low' ? ' · confidence: low' : ''}
				</Text>
			</Box>

			{rationale.length > 0 && (
				<Box flexDirection="column">
					{rationale.map((row, index) => (
						<Text key={`rationale-${index}`} dimColor>
							{row}
						</Text>
					))}
				</Box>
			)}

			{editing ? (
				<Box flexDirection="column" marginTop={1}>
					<TextBuffer
						contents={item.contents}
						path={item.proposal.path}
						columns={columns}
						// The hints and the overflow note are not drawn while the buffer
						// is open, so those rows go back to the text being edited.
						height={height + noteRow + hintRows}
						onSave={text => {
							batch.edit(text);
							setEditing(false);
							bump();
						}}
						onCancel={() => setEditing(false)}
						onExternal={onExternalEdit === undefined ? undefined : external}
					/>
				</Box>
			) : (
				<>
					<Box flexDirection="column" marginTop={1}>
						{wrapped.slice(clamped, clamped + height).map((line, index) => (
							<LineView key={`${clamped + index}`} line={line} />
						))}
						{noteRow === 1 && wrapped.length > height && (
							<Text dimColor>
								… {clamped + height}/{wrapped.length} lines
							</Text>
						)}
					</Box>

					{/*
						Rendered from the same array the chrome was measured against, so
						the height budget cannot drift from what is actually drawn.
					*/}
					<Box marginTop={1} flexDirection="column">
						{hints.map((hint, index) => (
							<LineView key={`hint-${index}`} line={hint} />
						))}
					</Box>
				</>
			)}
		</Box>
	);
}
