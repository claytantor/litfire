import {useCallback, useEffect, useRef, useState} from 'react';
import {computeProject, type Project} from '../core/project.js';
import {writeProjections} from '../ledger/projections.js';

export type ProjectStatus = 'idle' | 'computing' | 'error';

export type UseProjectResult = {
	readonly project: Project | undefined;
	readonly status: ProjectStatus;
	readonly error: string | undefined;
	readonly recompute: () => void;
	readonly consentFormulas: (hash: string) => void;
	/**
	 * Resolves once the in-flight compute settles. Commands typed before the
	 * first load finishes would otherwise see `undefined` and wrongly report
	 * that there is no vault here.
	 */
	readonly ensure: () => Promise<Project | undefined>;
};

const DEBOUNCE_MS = 300;

/**
 * Owns the recompute loop. Disk is always truth (§10) — nothing here holds
 * state the vault does not, so an external Obsidian write and an in-TUI command
 * take exactly the same path.
 */
export function useProject(root: string, watch: boolean): UseProjectResult {
	const [project, setProject] = useState<Project | undefined>(undefined);
	const [status, setStatus] = useState<ProjectStatus>('idle');
	const [error, setError] = useState<string | undefined>(undefined);
	const [consented, setConsented] = useState<string | undefined>(undefined);

	const timer = useRef<NodeJS.Timeout | undefined>(undefined);
	const generation = useRef(0);
	const consentedRef = useRef<string | undefined>(undefined);
	consentedRef.current = consented;

	const run = useCallback(async (): Promise<Project | undefined> => {
		const mine = ++generation.current;
		setStatus('computing');
		try {
			const next = await computeProject(root, {
				consentedFormulaHash: consentedRef.current,
			});
			// Derived files are a projection of the replay (D2); writing them is
			// what makes the Obsidian side of the demo tick.
			await writeProjections(next).catch(() => undefined);
			if (generation.current === mine) {
				setProject(next);
				setError(undefined);
				setStatus('idle');
			}
			return next;
		} catch (caught) {
			if (generation.current === mine) {
				setError(caught instanceof Error ? caught.message : String(caught));
				setStatus('error');
			}
			return undefined;
		}
	}, [root]);

	// Tracks the current compute so `ensure()` can await it.
	const inFlight = useRef<Promise<Project | undefined> | undefined>(undefined);

	const start = useCallback((): Promise<Project | undefined> => {
		const promise = run().finally(() => {
			if (inFlight.current === promise) {
				inFlight.current = undefined;
			}
		});
		inFlight.current = promise;
		return promise;
	}, [run]);

	const latest = useRef<Project | undefined>(undefined);
	latest.current = project;

	const ensure = useCallback(
		async (): Promise<Project | undefined> => (await inFlight.current) ?? latest.current,
		[],
	);

	const recompute = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => void start(), DEBOUNCE_MS);
	}, [start]);

	const consentFormulas = useCallback(
		(hash: string) => {
			setConsented(hash);
			consentedRef.current = hash;
			void start();
		},
		[start],
	);

	useEffect(() => {
		void start();
	}, [start]);

	useEffect(() => {
		if (!watch) {
			return;
		}

		let watcher: {close: () => Promise<void>} | undefined;
		let cancelled = false;

		void (async () => {
			const {watch: chokidarWatch} = await import('chokidar');
			if (cancelled) {
				return;
			}
			// Ignore our own cache directory or every recompute would retrigger.
			watcher = chokidarWatch(root, {
				ignored: (candidate: string) => candidate.includes('.litrpg'),
				ignoreInitial: true,
			}).on('all', () => recompute());
		})();

		return () => {
			cancelled = true;
			void watcher?.close();
			clearTimeout(timer.current);
		};
	}, [root, watch, recompute]);

	return {project, status, error, recompute, consentFormulas, ensure};
}
