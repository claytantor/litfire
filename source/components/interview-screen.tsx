import {Box, Static, Text, useInput} from 'ink';
import Spinner from 'ink-spinner';
import {useCallback, useEffect, useRef, useState} from 'react';
import {
	InterviewSession,
	fromTranscript,
	planSpillover,
	runExtraction,
	saveTranscript,
	type DroppedStub,
	type InterviewKind,
} from '../interview/index.js';
import {
	contentWidth,
	rowsFor,
	splitRow,
	viewportHeight,
	wrapText,
} from '../hooks/use-viewport.js';
import type {Provider} from '../llm/index.js';
import type {Proposal} from '../review/index.js';
import {theme} from '../theme.js';
import {Composer} from './composer.js';

export type InterviewOutcome = {
	readonly proposals: readonly Proposal[];
	readonly openFields: readonly {field: string; question: string}[];
	readonly contradictions: readonly {detail: string; where?: string}[];
	/** Cross-domain stubs the plan refused, so the author sees what was skipped. */
	readonly droppedStubs: readonly DroppedStub[];
	readonly transcriptPath: string;
	readonly extractionError?: string;
};

type Props = {
	readonly session: InterviewSession;
	readonly provider: Provider;
	readonly root: string;
	readonly grounding: string;
	readonly rows: number;
	readonly columns: number;
	readonly onDone: (outcome: InterviewOutcome) => void;
	/** Receives how many exchanges were saved, so the caller can say so. */
	readonly onCancel: (exchanges: number) => void;
};

type Phase = 'asking' | 'answering' | 'finishing';

type Entry = {readonly id: string; readonly role: 'q' | 'a'; readonly text: string};

/**
 * The conversational half of an interview.
 *
 * Questions stream token by token — §9 calls streaming more important here than
 * anywhere else in the app, because a pause before every question kills the
 * conversational feel. Finished exchanges go through `<Static>` so a long
 * interview scrolls into terminal scrollback rather than being redrawn.
 */
export function InterviewScreen({
	session,
	provider,
	root,
	grounding,
	rows,
	columns,
	onDone,
	onCancel,
}: Props) {
	const [entries, setEntries] = useState<readonly Entry[]>([]);
	const [streaming, setStreaming] = useState('');
	const [draft, setDraft] = useState('');
	const [phase, setPhase] = useState<Phase>('asking');
	const [error, setError] = useState<string | undefined>(undefined);
	const abort = useRef<AbortController | undefined>(undefined);
	const started = useRef(false);

	const append = useCallback((role: 'q' | 'a', text: string) => {
		setEntries(previous => [...previous, {id: `${role}-${previous.length}`, role, text}]);
	}, []);

	const ask = useCallback(async () => {
		setPhase('asking');
		setStreaming('');
		setError(undefined);

		const controller = new AbortController();
		abort.current = controller;
		let buffer = '';

		try {
			for await (const delta of session.ask(controller.signal)) {
				buffer += delta;
				setStreaming(buffer);
			}
			append('q', buffer.trim());
			setStreaming('');
			setPhase('answering');
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
			setStreaming('');
			setPhase('answering');
		} finally {
			abort.current = undefined;
		}
	}, [append, session]);

	// Opening question, once.
	useEffect(() => {
		if (started.current) {
			return;
		}
		started.current = true;
		void ask();
	}, [ask]);

	const finish = useCallback(async () => {
		abort.current?.abort();
		setPhase('finishing');

		// Held open across the whole wrap-up so esc can cancel a hung extraction.
		const controller = new AbortController();
		abort.current = controller;

		// Saved *before* extraction and still `in-progress`, so a failed, hung, or
		// cancelled extraction never costs the author their interview — and never
		// strands it as "complete" with nothing to show for it. The seal goes on
		// below, once there is actually an outcome to seal.
		const transcript = session.toTranscript();
		const transcriptPath = await saveTranscript(root, transcript);

		const result = await runExtraction(
			provider,
			transcript,
			grounding,
			controller.signal,
		);

		if (!result.ok) {
			onDone({
				proposals: [],
				openFields: [],
				contradictions: [],
				droppedStubs: [],
				transcriptPath,
				extractionError: result.reason,
			});
			return;
		}

		session.complete();
		await saveTranscript(root, session.toTranscript()).catch(() => undefined);

		const writes = result.extraction.writes.map(write => ({
			path: write.path,
			contents: write.contents,
			confidence: write.confidence,
			...(write.rationale === undefined ? {} : {rationale: write.rationale}),
		}));

		// Spillover runs after the writes are known so a stub can stand down when
		// the extraction is already proposing that page properly.
		const spillover = await planSpillover(
			fromTranscript(result.extraction.stubs, transcript.id),
			{root, kind: session.kind, taken: writes.map(write => write.path)},
		);

		onDone({
			proposals: [...writes, ...spillover.proposals],
			openFields: result.extraction.open_fields,
			contradictions: result.extraction.contradictions,
			droppedStubs: spillover.dropped,
			transcriptPath,
		});
	}, [grounding, onDone, provider, root, session]);

	useInput((_input, key) => {
		if (!key.escape) {
			return;
		}
		// Stays live during `finishing` too: extraction is a network call that can
		// stall, and with no way out the author's only exit is killing the process
		// — which is how a wrapped-up interview ends up with nothing extracted.
		if (phase === 'asking' || phase === 'finishing') {
			abort.current?.abort();
			return;
		}
		onCancel(session.exchanges.length);
	});

	const status = session.status();

	// Finished exchanges are already in scrollback; only the question still
	// arriving lives in the dynamic region, and only it can outgrow the terminal.
	const width = contentWidth(columns, 2);
	// Both halves at their widest, so the footer's height is known before the
	// question that has to fit above it is sliced.
	const footer = splitRow(
		`${String(status.exchanges)} exchange${status.exchanges === 1 ? '' : 's'} · ${String(status.minimum)} for a usable pass`,
		'enough to work with — /done to wrap',
		width,
	);
	const streamingRows = wrapText(streaming, width);
	const chrome =
		// speaker label, its marginBottom, the composer's bordered row, and a row
		// of slack so the frame never exactly fills the terminal.
		1 +
		1 +
		3 +
		1 +
		(error === undefined ? 0 : rowsFor(`✖ ${error} — enter to retry`, width)) +
		footer.rows;
	// The tail, the way a terminal shows a command still printing: the newest
	// words are the ones being written. A question longer than the screen used to
	// push the composer off the bottom, and Ink answers an over-tall frame by
	// clearing the terminal and replaying every <Static> line on every token.
	const visible = streamingRows.slice(
		Math.max(0, streamingRows.length - viewportHeight(rows, chrome)),
	);

	const submit = (value: string) => {
		const trimmed = value.trim();
		setDraft('');

		if (trimmed === '') {
			return;
		}
		if (trimmed === '/done' || trimmed === '/wrap') {
			void finish();
			return;
		}
		if (trimmed === '/skip') {
			void ask();
			return;
		}
		if (session.pendingQuestion === undefined) {
			void ask();
			return;
		}

		append('a', trimmed);
		void (async () => {
			await session.recordAnswer(trimmed);
			// Persist after every exchange, not only at /done. An interview runs
			// 8–15 exchanges; losing that to a stray esc or a crash is the worst
			// failure this screen has, and the transcript is small enough that
			// writing it each turn costs nothing.
			await saveTranscript(root, session.toTranscript()).catch(() => undefined);
			await ask();
		})();
	};

	if (phase === 'finishing') {
		return (
			<Box borderStyle="round" borderColor={theme.color.border} paddingX={1}>
				<Text color={theme.color.brand}>
					<Spinner type="dots" />
				</Text>
				<Text dimColor>
					{' '}
					saving transcript and extracting corpus proposals… esc to cancel
				</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Static items={[...entries]}>
				{entry => (
					<Box key={entry.id} flexDirection="column" paddingX={1} marginBottom={1}>
						<Text color={entry.role === 'q' ? theme.color.brand : theme.color.user}>
							{entry.role === 'q' ? '◆ interviewer' : '› you'}
						</Text>
						<Text wrap="wrap">{entry.text}</Text>
					</Box>
				)}
			</Static>

			{streaming !== '' && (
				<Box flexDirection="column" paddingX={1} marginBottom={1}>
					<Text color={theme.color.brand}>◆ interviewer</Text>
					{visible.map((row, index) => (
						<Text key={`${index}`} wrap="wrap">
							{row === '' ? ' ' : row}
						</Text>
					))}
				</Box>
			)}

			{phase === 'asking' && streaming === '' && (
				<Box paddingX={1}>
					<Text color={theme.color.brand}>
						<Spinner type="dots" />
					</Text>
					<Text dimColor> thinking…</Text>
				</Box>
			)}

			{error !== undefined && (
				<Box paddingX={1}>
					<Text color={theme.color.error}>✖ {error} — enter to retry</Text>
				</Box>
			)}

			{/*
				Reuses Composer rather than a bare TextInput: Ink delivers a paste or
				piped line as one chunk with no key.return, and Composer is where that
				newline-boundary handling lives. A second input widget here would
				silently reintroduce the bug.
			*/}
			<Composer
				value={draft}
				onChange={setDraft}
				onSubmit={submit}
				disabled={phase !== 'answering'}
				placeholder="answer, or /done to wrap up"
				busyLabel="waiting for the interviewer…"
			/>

			<Box
				paddingX={1}
				flexDirection={footer.stacked ? 'column' : 'row'}
				justifyContent="space-between"
			>
				<Text dimColor>
					{status.exchanges} exchange{status.exchanges === 1 ? '' : 's'}
					{status.minimumReached ? '' : ` · ${status.minimum} for a usable pass`}
				</Text>
				{/* The spec's exit ramp: say plainly when it is fair to stop. */}
				<Text
					color={status.shouldOfferExit ? '#e0af68' : undefined}
					dimColor={!status.shouldOfferExit}
				>
					{status.shouldOfferExit
						? 'enough to work with — /done to wrap'
						: status.minimumReached
							? 'minimum reached · /done any time'
							: '/done any time · /skip to reroll'}
				</Text>
			</Box>
		</Box>
	);
}

export type {InterviewKind};
