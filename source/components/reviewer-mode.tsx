import type {Project} from '../core/project.js';
import type {ReviewerSession, FixOutcome} from '../reviewer/index.js';
import {useReviewer} from '../hooks/use-reviewer.js';
import type {Provider} from '../llm/index.js';
import {ConversationScreen} from './conversation-screen.js';

type Props = {
	readonly root: string;
	readonly project: Project;
	readonly provider: Provider;
	readonly session: ReviewerSession;
	readonly register: string;
	readonly rows: number;
	readonly columns: number;
	readonly onFixed: (outcome: FixOutcome) => void;
	readonly onExit: () => void;
};

/**
 * Binds the reviewer controller to its screen.
 *
 * Its own component only because hooks cannot be called conditionally: App
 * mounts this when the reviewer is open, so `useReviewer` runs unconditionally here
 * rather than behind a branch in App's body.
 */
export function ReviewerMode({rows, columns, ...options}: Props) {
	const controller = useReviewer(options);

	return (
		<ConversationScreen
			turns={controller.turns}
			streaming={controller.streaming}
			status={controller.status}
			busy={controller.busy}
			rows={rows}
			columns={columns}
			onSubmit={controller.submit}
			onCancel={controller.cancel}
			speaker="reviewer"
		/>
	);
}
