import {readFile} from 'node:fs/promises';
import {useCallback, useRef, useState} from 'react';
import type {Project} from '../core/project.js';
import {
	buildCorpusMap,
	resolveTargets,
	runCorrectionPass,
	type ReviewerSession,
	type FixOutcome,
	type Target,
} from '../reviewer/index.js';
import type {Provider} from '../llm/index.js';
import {resolve} from '../vault/paths.js';
import {streamPainter} from './use-stream-paint.js';
import type {ConversationTurn} from '../conversation/types.js';

export type ReviewerController = {
	readonly turns: readonly ConversationTurn[];
	readonly streaming: string | undefined;
	readonly status: string | undefined;
	readonly busy: boolean;
	readonly submit: (text: string) => void;
	readonly cancel: () => void;
};

export type UseReviewerOptions = {
	readonly root: string;
	readonly project: Project;
	readonly provider: Provider;
	readonly session: ReviewerSession;
	readonly register: string;
	/** Hands corrections to the review gate; refusals and notes are for the log. */
	readonly onFixed: (outcome: FixOutcome) => void;
	/** esc while idle. */
	readonly onExit: () => void;
};

/** `fix <target>` is the one input that writes; everything else is conversation. */
const FIX = /^fix\b\s*(.*)$/i;
const AFFIRMATIVE = new Set(['y', 'yes', 'run it', 'do it']);

/**
 * Reports the pass into the conversation, refusals included.
 *
 * A guard that silently discarded half the model's output would look like it
 * found nothing. Saying what was refused is what makes the constraint visible
 * to the author rather than a mystery about why a typo went unfixed.
 */
function summarize(outcome: FixOutcome, files: number): string {
	if (outcome.error !== undefined) {
		return `The correction pass failed: ${outcome.error}. Nothing was changed.`;
	}

	const lines: string[] = [
		outcome.proposals.length === 0
			? `No corrections to offer across ${files} file(s).`
			: `${outcome.proposals.length} file(s) with corrections — sending them to review.`,
	];

	if (outcome.refusals.length > 0) {
		lines.push(
			'',
			`${outcome.refusals.length} proposal(s) refused before reaching you:`,
			...outcome.refusals.map(
				refusal =>
					`  ${refusal.path}${refusal.line === undefined ? '' : `:${refusal.line}`} — ${refusal.reason}`,
			),
		);
	}

	if (outcome.notes.length > 0) {
		lines.push('', 'Left alone on purpose:', ...outcome.notes.map(note => `  ${note}`));
	}

	return lines.join('\n');
}

export function useReviewer(options: UseReviewerOptions): ReviewerController {
	const {root, project, provider, session, register, onFixed, onExit} = options;

	const [turns, setTurns] = useState<readonly ConversationTurn[]>(session.turns);
	const [streaming, setStreaming] = useState<string | undefined>(undefined);
	const [status, setStatus] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const abort = useRef<AbortController | undefined>(undefined);

	// A whole-corpus pass is expensive enough to be worth confirming, so the spec
	// is parked here until the author says yes rather than run on first ask.
	const pending = useRef<string | undefined>(undefined);

	const say = useCallback(
		(text: string) => {
			session.note(text);
			setTurns(session.turns);
		},
		[session],
	);

	const chat = useCallback(
		async (question: string) => {
			const controller = new AbortController();
			abort.current = controller;

			// Shown before the first token arrives: the session only records a
			// completed exchange, so without this the author watches a reply stream
			// in with no sign of the question that caused it.
			setTurns([...session.turns, {role: 'author', text: question}]);
			setStreaming('');

			try {
				const paint = streamPainter(setStreaming);
				for await (const delta of session.ask(question, controller.signal)) {
					paint.push(delta);
				}
				paint.flush();
			} catch (caught) {
				session.recordFailure(
					question,
					`— ${caught instanceof Error ? caught.message : String(caught)}`,
				);
			} finally {
				// One update, so the completed turn replaces the streaming partial
				// without a frame where both are on screen.
				setStreaming(undefined);
				setTurns(session.turns);
			}
		},
		[session],
	);

	const fix = useCallback(
		async (spec: string) => {
			setStatus('reading the corpus…');
			const map = await buildCorpusMap(root, project);
			const selection = resolveTargets(map, spec);

			if (selection.paths.length === 0) {
				setStatus(undefined);
				say(`Nothing in the corpus matches "${spec}". Try an id, an arc, or a path.`);
				return;
			}

			if (selection.whole && pending.current === undefined) {
				pending.current = spec;
				setStatus(undefined);
				say(
					`That is ${selection.paths.length} file(s) — the whole corpus. It will cost a large request and can produce a long review queue. Say yes to run it.`,
				);
				return;
			}
			pending.current = undefined;

			setStatus(`proofreading ${selection.paths.length} file(s)…`);
			const targets: Target[] = [];
			for (const path of selection.paths) {
				const contents = await readFile(resolve(root, path), 'utf8').catch(
					() => undefined,
				);
				if (contents !== undefined) {
					targets.push({path, contents});
				}
			}

			const controller = new AbortController();
			abort.current = controller;
			const outcome = await runCorrectionPass(
				provider,
				targets,
				register,
				controller.signal,
			);
			setStatus(undefined);
			say(summarize(outcome, targets.length));
			onFixed(outcome);
		},
		[onFixed, project, provider, register, root, say],
	);

	const submit = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (trimmed === '' || busy) {
				return;
			}

			// Slash commands belong to the main screen, not here. Without this a
			// reflexive `/quit` is sent to the model as a question and costs a real
			// request to be told nothing.
			if (trimmed.startsWith('/')) {
				say(`\`${trimmed}\` is a command for the main screen — esc leaves the reviewer.`);
				return;
			}

			setBusy(true);
			void (async () => {
				try {
					const confirming = pending.current;
					if (confirming !== undefined && AFFIRMATIVE.has(trimmed.toLowerCase())) {
						await fix(confirming);
						return;
					}
					pending.current = undefined;

					const asFix = FIX.exec(trimmed);
					await (asFix ? fix(asFix[1] ?? '') : chat(trimmed));
				} finally {
					setBusy(false);
				}
			})();
		},
		[busy, chat, fix, say],
	);

	const cancel = useCallback(() => {
		if (busy) {
			abort.current?.abort();
			return;
		}
		onExit();
	}, [busy, onExit]);

	return {turns, streaming, status, busy, submit, cancel};
}
