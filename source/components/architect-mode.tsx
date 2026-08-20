import {useCallback, useRef, useState} from 'react';
import {ArchitectSession, runPlan, type PlanOutcome} from '../architect/index.js';
import {buildReviewerContext} from '../reviewer/corpus.js';
import type {ConversationTurn} from '../conversation/types.js';
import type {Project} from '../core/project.js';
import type {Provider} from '../llm/index.js';
import {buildRawContext, renderRawContext} from '../architect/raw.js';
import {streamPainter} from '../hooks/use-stream-paint.js';
import {ConversationScreen} from './conversation-screen.js';

type Props = {
	readonly root: string;
	readonly project: Project;
	readonly provider: Provider;
	readonly session: ArchitectSession;
	readonly register: string;
	readonly rows: number;
	readonly columns: number;
	readonly onPlanned: (outcome: PlanOutcome) => void;
	readonly onExit: () => void;
};

/** `plan <instruction>` runs the structural pass; anything else is a question. */
const PLAN = /^plan\s+(.+)$/is;

/**
 * Binds the architect to the shared conversation screen.
 *
 * The split mirrors `/reviewer`: talking is free and changes nothing, and a write
 * only ever happens behind an explicit verb. Here that verb is `plan`, and what
 * it produces goes to the same review gate as every other proposal in the tool —
 * the architect may restructure a world, but not without the author reading each
 * diff first.
 */
export function ArchitectMode({rows, columns, ...options}: Props) {
	const {root, project, provider, session, register, onPlanned, onExit} = options;
	const [turns, setTurns] = useState<readonly ConversationTurn[]>(session.turns);
	const [streaming, setStreaming] = useState<string | undefined>(undefined);
	const [status, setStatus] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const abort = useRef<AbortController | undefined>(undefined);

	const submit = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (trimmed === '' || busy) {
				return;
			}

			const controller = new AbortController();
			abort.current = controller;
			setBusy(true);

			void (async () => {
				/**
				 * Runs the structural pass and hands its proposals to the gate.
				 *
				 * The conversation goes in with the grounding. Without it the pass
				 * re-derived everything cold from one sentence — an architect that
				 * had just computed five timestamps would watch them worked out
				 * again from scratch, and nothing guaranteed the second answer
				 * matched the first.
				 */
				const plan = async (instruction: string) => {
					setStatus('planning the corpus…');
					const [corpus, raw] = await Promise.all([
						buildReviewerContext(root, project, instruction),
						buildRawContext(root, instruction),
					]);
					const context = [
						'# The corpus',
						'',
						corpus,
						'',
						'# The raw material',
						'',
						renderRawContext(raw),
						...(session.turns.length === 0
							? []
							: [
									'',
									'# The conversation so far',
									'',
									'This is what was worked out with the author. Numbers, names and',
									'decisions reached here are what the instruction refers to — use them',
									'rather than deriving them again.',
									'',
									session.turns
										.map(turn => `**${turn.role}:** ${turn.text}`)
										.join('\n\n'),
								]),
					].join('\n');

					const outcome = await runPlan(
						provider,
						root,
						instruction,
						context,
						register,
						controller.signal,
					);
					session.note(
						outcome.error === undefined
							? `Proposed ${String(outcome.proposals.length)} file(s).${outcome.notes.length === 0 ? '' : `\n\n${outcome.notes.map(note => `- ${note}`).join('\n')}`}`
							: `Plan failed: ${outcome.error}`,
					);
					setTurns(session.turns);
					onPlanned(outcome);
				};

				const planned = PLAN.exec(trimmed);
				try {
					if (planned?.[1] !== undefined) {
						await plan(planned[1]);
						return;
					}

					setStatus('reading the vault…');
					const paint = streamPainter(setStreaming);
					for await (const delta of session.ask(trimmed, controller.signal)) {
						paint.push(delta);
					}
					paint.flush();
					setTurns(session.turns);

					// The architect may decide the next step itself. The gate is what
					// makes a change safe, not the keystrokes that reached it, so
					// asking the author to retype a conclusion they had just been
					// given was friction protecting nothing.
					if (session.pendingPlan !== undefined) {
						await plan(session.pendingPlan);
					}
				} catch (caught) {
					session.recordFailure(
						trimmed,
						caught instanceof Error ? caught.message : String(caught),
					);
					setTurns(session.turns);
				} finally {
					setStreaming(undefined);
					setStatus(undefined);
					setBusy(false);
					abort.current = undefined;
				}
			})();
		},
		[busy, onPlanned, project, provider, register, root, session],
	);

	const cancel = useCallback(() => {
		if (busy) {
			abort.current?.abort();
			return;
		}
		onExit();
	}, [busy, onExit]);

	return (
		<ConversationScreen
			turns={turns}
			streaming={streaming}
			status={status}
			busy={busy}
			rows={rows}
			columns={columns}
			onSubmit={submit}
			onCancel={cancel}
			speaker="architect"
		/>
	);
}
