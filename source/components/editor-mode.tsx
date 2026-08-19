import type {Project} from '../core/project.js';
import type {EditorSession, FixOutcome} from '../editor/index.js';
import {useEditor} from '../hooks/use-editor.js';
import type {Provider} from '../llm/index.js';
import {EditorScreen} from './editor-screen.js';

type Props = {
	readonly root: string;
	readonly project: Project;
	readonly provider: Provider;
	readonly session: EditorSession;
	readonly register: string;
	readonly rows: number;
	readonly columns: number;
	readonly onFixed: (outcome: FixOutcome) => void;
	readonly onExit: () => void;
};

/**
 * Binds the editor controller to its screen.
 *
 * Its own component only because hooks cannot be called conditionally: App
 * mounts this when the editor is open, so `useEditor` runs unconditionally here
 * rather than behind a branch in App's body.
 */
export function EditorMode({rows, columns, ...options}: Props) {
	const controller = useEditor(options);

	return (
		<EditorScreen
			turns={controller.turns}
			streaming={controller.streaming}
			status={controller.status}
			busy={controller.busy}
			rows={rows}
			columns={columns}
			onSubmit={controller.submit}
			onCancel={controller.cancel}
		/>
	);
}
