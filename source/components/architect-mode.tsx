import {useCallback, useRef, useState} from 'react';
import {ArchitectSession, runPlan, type PlanOutcome} from '../architect/index.js';
import {buildEditorContext} from '../editor/corpus.js';
import type {EditorTurn} from '../editor/types.js';
import type {Project} from '../core/project.js';
import type {Provider} from '../llm/index.js';
import {buildRawContext, renderRawContext} from '../architect/raw.js';
import {EditorScreen} from './editor-screen.js';

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
 * The split mirrors `/editor`: talking is free and changes nothing, and a write
 * only ever happens behind an explicit verb. Here that verb is `plan`, and what
 * it produces goes to the same review gate as every other proposal in the tool —
 * the architect may restructure a world, but not without the author reading each
 * diff first.
 */
export function ArchitectMode({rows, columns, ...options}: Props) {
	const {root, project, provider, session, register, onPlanned, onExit} = options;
	const [turns, setTurns] = useState<readonly EditorTurn[]>(session.turns);
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
				const planned = PLAN.exec(trimmed);
				try {
					if (planned?.[1] !== undefined) {
						setStatus('planning the corpus…');
						// The plan sees exactly what the conversation sees, so an
						// instruction like "do that" refers to the same material the
						// author was just discussing.
						const [corpus, raw] = await Promise.all([
							buildEditorContext(root, project, planned[1]),
							buildRawContext(root, planned[1]),
						]);
						const context = [
							'# The corpus',
							'',
							corpus,
							'',
							'# The raw material',
							'',
							renderRawContext(raw),
						].join('\n');

						const outcome = await runPlan(
							provider,
							root,
							planned[1],
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
						return;
					}

					setStatus('reading the vault…');
					let reply = '';
					for await (const delta of session.ask(trimmed, controller.signal)) {
						reply += delta;
						setStreaming(reply);
					}
					setTurns(session.turns);
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
		<EditorScreen
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
