import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Box, Static, Text, useApp, useInput, useWindowSize} from 'ink';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {findCommand} from './commands/registry.js';
import {
	error,
	muted,
	ok,
	text,
	type CommandContext,
	type Line,
	type CommandResult,
} from './commands/types.js';
import {Composer} from './components/composer.js';
import {Footer} from './components/footer.js';
import {LineView} from './components/line-view.js';
import {Pager} from './components/pager.js';
import {DiffReview} from './components/diff-review.js';
import {TextBuffer} from './components/text-buffer.js';
import {ReviewerMode} from './components/reviewer-mode.js';
import {CuratorMode} from './components/curator-mode.js';
import {InterviewScreen, type InterviewOutcome} from './components/interview-screen.js';
import {ProviderWizard} from './components/provider-wizard.js';
import type {Project} from './core/project.js';
import {ReviewerSession, type FixOutcome} from './reviewer/index.js';
import {CuratorSession, type PlanOutcome} from './curator/index.js';
import {loadSetting, overlayFor} from './genre/index.js';
import {stopWikiServe} from './wiki/host.js';
import {
	InterviewSession,
	buildGrounding,
	findForResume,
	type InterviewKind,
} from './interview/index.js';
import {loadProvider, type Provider} from './llm/index.js';
import {ReviewBatch, type Proposal} from './review/index.js';
import {buildIngest, readRaw, type SourceKind} from './ingest/index.js';
import {
	hashSource,
	honourAuthored,
	readIngestState,
	stampSource,
	statusOf,
} from './ingest/state.js';
import {runPlan} from './curator/index.js';
import {editText, resolveEditor} from './vault/editor.js';
import {
	displayPath,
	projectName,
	rememberProject,
	type Startup,
} from './vault/projects.js';
import {readConfig, saveProvider} from './vault/config.js';
import {appendLog} from './vault/log.js';
import {parseDocument, stringifyDocument} from './vault/frontmatter.js';
import {appendHistory, extendHistory, readHistory} from './vault/history.js';
import {useProject} from './hooks/use-project.js';
import {theme} from './theme.js';

type Props = {
	readonly root: string;
	readonly version: string;
	readonly watch?: boolean;
	/** How the launch directory was chosen, so the banner can say so. */
	readonly startup?: Startup;
};

type Entry = {
	readonly id: string;
	readonly lines: readonly Line[];
};

type PagerState = {
	readonly title: string;
	readonly lines: readonly Line[];
};

export function App({root: initialRoot, version, watch = true, startup}: Props) {
	const {exit} = useApp();
	// The active vault is state, not a prop: /project switches it at runtime, and
	// everything downstream (recompute, watcher, grounding, interviews) is keyed
	// on it.
	const [root, setRoot] = useState(initialRoot);
	const {columns, rows} = useWindowSize();
	const {
		project,
		status,
		error: projectError,
		recompute,
		consentFormulas,
		ensure,
	} = useProject(root, watch);

	const [entries, setEntries] = useState<readonly Entry[]>([]);
	const [draft, setDraft] = useState('');
	const [busy, setBusy] = useState(false);
	/**
	 * What the composer says while it is disabled.
	 *
	 * A model call is the longest wait in this tool and the only one with nothing
	 * to show for itself until it finishes. `/system extract all` can spend
	 * minutes on a sweep, so the label carries which transcript is in flight
	 * rather than a word that never changes.
	 */
	const [busyLabel, setBusyLabel] = useState<string | undefined>(undefined);
	const [pager, setPager] = useState<PagerState | undefined>(undefined);
	const [wizard, setWizard] = useState<'provider' | undefined>(undefined);
	const [confirm, setConfirm] = useState<CommandResult['confirm']>(undefined);
	const [interview, setInterview] = useState<
		{session: InterviewSession; provider: Provider; grounding: string} | undefined
	>(undefined);
	const [review, setReview] = useState<{batch: ReviewBatch; title: string} | undefined>(
		undefined,
	);
	/**
	 * The native prose buffer, open on one vault file.
	 *
	 * `data` is the frontmatter as read; it is written back unchanged so the
	 * buffer can only ever alter the author's own prose. `body` seeds the buffer
	 * and is not updated as they type — TextBuffer owns the text once it opens.
	 */
	const [authoring, setAuthoring] = useState<
		| {
				readonly file: string;
				readonly data: Record<string, unknown>;
				readonly body: string;
		  }
		| undefined
	>(undefined);
	const [reviewing, setReviewing] = useState<
		| {
				session: ReviewerSession;
				provider: Provider;
				register: string;
				/** Captured at open, so a mid-recompute `undefined` cannot unmount the screen. */
				project: Project;
		  }
		| undefined
	>(undefined);
	const [curating, setCurating] = useState<
		| {
				session: CuratorSession;
				provider: Provider;
				register: string;
				project: Project;
		  }
		| undefined
	>(undefined);
	const [history, setHistory] = useState<readonly string[]>([]);
	const [activeCharacter, setActiveCharacter] = useState<string | undefined>(undefined);
	const [providerLabel, setProviderLabel] = useState<string | undefined>(undefined);

	// Recent-projects list, so /project can offer somewhere to switch to.
	useEffect(() => {
		void rememberProject(root);
	}, [root]);

	// History is per vault, so switching projects swaps it rather than mixing two
	// manuscripts' commands into one list.
	useEffect(() => {
		let current = true;
		void (async () => {
			const saved = await readHistory(root);
			if (current) {
				setHistory(saved);
			}
		})();
		return () => {
			current = false;
		};
	}, [root]);

	// Reflects the selected provider in the footer; re-read after the wizard runs.
	useEffect(() => {
		void (async () => {
			const config = await readConfig(root);
			setProviderLabel(
				config.provider.id === undefined
					? undefined
					: `${config.provider.id}·${config.provider.model ?? '?'}`,
			);
		})();
	}, [root, wizard]);

	const append = useCallback((lines: readonly Line[]) => {
		setEntries(previous => [...previous, {id: `entry-${previous.length}`, lines}]);
	}, []);

	useInput(
		(input, key) => {
			// While a question is up, every key answers it and nothing else. A
			// stray character must not fall through and start editing the draft
			// behind a prompt the author has not answered.
			if (confirm) {
				const pending = confirm;
				setConfirm(undefined);
				if (input.toLowerCase() === 'y') {
					setBusy(true);
					void (async () => {
						try {
							await applyResult(pending.proceed, 'confirm');
						} catch (caught) {
							append([error(caught instanceof Error ? caught.message : String(caught))]);
						} finally {
							setBusy(false);
							setBusyLabel(undefined);
						}
					})();
					return;
				}
				// Anything else declines, `return` and `esc` included. The default is
				// no because every question asked here is about spending something —
				// a model session, a long review — that the author may not have
				// meant to spend.
				append([muted(pending.declined ?? 'not now')]);
				return;
			}

			if (key.escape && draft !== '') {
				setDraft('');
			}
		},
		{
			isActive:
				pager === undefined &&
				wizard === undefined &&
				interview === undefined &&
				review === undefined &&
				reviewing === undefined,
		},
	);

	/** Resolves the provider, grounds on the corpus, and opens the interview. */
	const startInterview = useCallback(
		async (
			kind: InterviewKind,
			focus: string | undefined,
			resume = false,
			agenda?: string,
		) => {
			const config = await readConfig(root);
			const loaded = await loadProvider(
				config.provider.id,
				config.provider.model,
				config.provider.baseUrl,
			);
			if ('error' in loaded) {
				append([error(loaded.error)]);
				return;
			}

			// The project carries the replayed ledger, which is where the wiki's
			// computed half comes from. Without it the interviewer sees the prose
			// but not what the numbers actually did.
			const resolved = await ensure();
			const grounding = await buildGrounding(root, kind, {
				focus,
				...(resolved === undefined ? {} : {project: resolved}),
			});
			// The profile appends questions and register to the base brief; it never
			// replaces a base question (multi-genre §5).
			const {setting, profile, briefing} = await loadSetting(root);
			const overlay = overlayFor(kind, profile, setting, briefing);
			// Must match what /<kind> resume promised, including its fallback to a
			// wrapped-up transcript — a stricter lookup here would print "resuming"
			// and then silently start a blank interview.
			const prior = resume
				? (await findForResume(root, kind, focus))?.transcript
				: undefined;

			append([
				muted(
					`interviewing about ${kind}${focus === undefined ? '' : ` · ${focus}`} — ${profile.name} idiom, grounded on ${grounding.length} chars of corpus`,
				),
				prior
					? ok(`resuming from ${prior.exchanges.length} saved exchange(s)`)
					: muted('answer in your own words'),
				muted('/done to wrap up · esc to pause (your answers are saved)'),
			]);
			setInterview({
				session: new InterviewSession({
					root,
					kind,
					provider: loaded.provider,
					grounding,
					overlay,
					focus,
					...(agenda === undefined ? {} : {agenda}),
					...(prior === undefined ? {} : {resumeFrom: prior}),
				}),
				provider: loaded.provider,
				grounding,
			});
		},
		[append, ensure, root],
	);

	/**
	 * Opens a vault file in the native prose buffer.
	 *
	 * Read here rather than in the command so the buffer always opens on what is
	 * on disk right now — a scene the author edited in Obsidian a moment ago is
	 * the version they mean, not whatever the last recompute cached.
	 */
	const openAuthoring = useCallback(
		async (file: string) => {
			try {
				const {data, body} = parseDocument(await readFile(file, 'utf8'));
				setAuthoring({file, data, body});
			} catch (caught) {
				append([error(caught instanceof Error ? caught.message : String(caught))]);
			}
		},
		[append],
	);

	/**
	 * Writes the buffer back, frontmatter untouched.
	 *
	 * The frontmatter is re-serialised from what was parsed at open, not carried
	 * through as text — which means a save normalises its formatting but can
	 * never change its meaning. The body is written exactly as typed (P6).
	 */
	const saveAuthoring = useCallback(
		async (file: string, data: Record<string, unknown>, body: string) => {
			try {
				await writeFile(file, stringifyDocument({data, body}), 'utf8');
				setAuthoring(undefined);
				append([ok(`wrote ${path.relative(root, file)}`)]);
				recompute();
			} catch (caught) {
				append([error(caught instanceof Error ? caught.message : String(caught))]);
			}
		},
		[append, recompute, root],
	);

	/** Opens the reviewer over the whole rendered corpus. */
	const startReviewer = useCallback(async () => {
		const resolved = await ensure();
		if (!resolved) {
			append([error('no vault loaded here — run /init first')]);
			return;
		}

		const config = await readConfig(root);
		const loaded = await loadProvider(
			config.provider.id,
			config.provider.model,
			config.provider.baseUrl,
		);
		if ('error' in loaded) {
			append([error(loaded.error)]);
			return;
		}

		const {profile} = await loadSetting(root);
		const register = profile.register ?? '';

		append([
			muted('reviewer — ask anything about the corpus'),
			muted('`fix <id|arc|everything>` proofreads; corrections are spelling and'),
			muted('grammar only, and every one still goes through review'),
			muted('esc to leave'),
		]);

		setReviewing({
			session: new ReviewerSession({
				root,
				project: resolved,
				provider: loaded.provider,
				register,
			}),
			provider: loaded.provider,
			register,
			project: resolved,
		});
	}, [append, ensure, root]);

	/** Opens the curator over the raw material and the corpus together. */
	const openCurator = useCallback(async () => {
		const resolved = await ensure();
		if (!resolved) {
			append([error('no vault loaded here — run /init first')]);
			return;
		}

		const config = await readConfig(root);
		const loaded = await loadProvider(
			config.provider.id,
			config.provider.model,
			config.provider.baseUrl,
		);
		if ('error' in loaded) {
			append([error(loaded.error)]);
			return;
		}

		const {profile} = await loadSetting(root);
		const register = profile.register ?? '';

		append([
			muted('curator — ask anything about the raw interviews and the corpus'),
			muted('`plan <what you want>` proposes the files that should exist;'),
			muted('every one goes through review, and raw/ is never written'),
			muted('esc to leave'),
		]);

		setCurating({
			session: new CuratorSession({
				root,
				project: resolved,
				provider: loaded.provider,
				register,
			}),
			provider: loaded.provider,
			register,
			project: resolved,
		});
	}, [append, ensure, root]);

	/** A plan that survived the path check goes to the gate every write uses. */
	const handlePlanned = useCallback(
		async (outcome: PlanOutcome) => {
			const summary: Line[] = [];
			for (const note of outcome.notes) {
				summary.push(muted(`~ ${note}`));
			}
			for (const refusal of outcome.refusals) {
				summary.push(error(`refused ${refusal.path}: ${refusal.reason}`));
			}
			if (outcome.error !== undefined) {
				summary.push(error(`plan failed: ${outcome.error}`));
			}
			if (outcome.proposals.length === 0) {
				// Said, rather than returning quietly. A pass that reads two notes,
				// thinks for a minute and then proposes nothing is a legitimate
				// outcome — but silence after a long wait is indistinguishable from
				// a crash, and the author has no way to tell which they got.
				summary.push(
					outcome.error === undefined && outcome.refusals.length === 0
						? muted('nothing proposed — the pass found no changes to make')
						: muted('nothing proposed'),
				);
				append(summary);
				return;
			}
			if (summary.length > 0) {
				append(summary);
			}

			// The curator alone may propose changes to `raw/` (D15). Extraction
			// and the reviewer keep the old rule, so a transcript can only be
			// rewritten by the agent the author pointed at it deliberately.
			const batch = await ReviewBatch.create(root, outcome.proposals, {allowRaw: true});
			for (const problem of batch.validatePaths()) {
				append([error(`unsafe proposal ${problem.path}: ${problem.reason}`)]);
			}
			setReview({batch, title: 'review — curator'});
		},
		[append, root],
	);

	/**
	 * Turns the author's notes into typed pages.
	 *
	 * Built on the structural pass rather than as its own agent: that pass
	 * already emits whole files, refuses paths outside the vault, can open a
	 * file it needs, and returns proposals to the review gate. An ingest is that
	 * job with the material named for it, so it lands the same way — as diffs
	 * the author accepts one at a time.
	 */
	const runIngest = useCallback(
		async (kind: SourceKind, focus: string | undefined) => {
			const resolved = await ensure();
			if (!resolved) {
				append([error('no vault loaded here — run /init first')]);
				return;
			}

			const config = await readConfig(root);
			const loaded = await loadProvider(
				config.provider.id,
				config.provider.model,
				config.provider.baseUrl,
			);
			if ('error' in loaded) {
				append([error(loaded.error)]);
				return;
			}

			const {documents} = await readRaw(root, kind, focus);
			if (documents.length === 0) {
				append([error(`nothing to ingest for ${kind}`)]);
				return;
			}

			const {profile} = await loadSetting(root);
			const state = await readIngestState(root, kind);
			const pending = documents.filter(
				document => statusOf(state, document.path, document.contents) !== 'unchanged',
			);
			if (pending.length === 0) {
				return;
			}

			setBusy(true);
			const controller = new AbortController();
			const proposals: Proposal[] = [];
			const notes: string[] = [];

			try {
				/**
				 * One note per pass, rather than all of them in one context.
				 *
				 * Provenance needs it: a page has to record which note it came from,
				 * and a single pass over four notes cannot say which of them produced
				 * what. It is also better curation — four characters in one request
				 * bleed into each other, and one at a time each gets the whole
				 * instruction.
				 *
				 * The cost of doing it this way is paid once. An unchanged note never
				 * reaches here at all.
				 */
				for (const [index, document] of pending.entries()) {
					setBusyLabel(
						`reading ${document.path} (${String(index + 1)}/${String(pending.length)})…`,
					);

					const {instruction, context} = await buildIngest(root, resolved, kind, [
						document,
					]);
					const outcome = await runPlan(
						loaded.provider,
						root,
						instruction,
						context,
						profile.register ?? '',
						controller.signal,
					);

					if (outcome.error !== undefined) {
						append([error(`${document.path}: ${outcome.error}`)]);
						continue;
					}
					for (const refusal of outcome.refusals) {
						append([error(`refused ${refusal.path}: ${refusal.reason}`)]);
					}

					// Stamped here, in code. The model cannot compute a digest, and a
					// page carrying a plausible-looking one would be trusted by every
					// later ingest.
					const hash = hashSource(document.contents);
					for (const proposal of outcome.proposals) {
						proposals.push(
							proposal.remove === true
								? proposal
								: {
										...proposal,
										// The author's own fields go back on last, so a decision
										// they made outranks anything the model chose.
										contents: stampSource(
											honourAuthored(proposal.contents, document),
											document.path,
											hash,
										),
									},
						);
					}
					notes.push(...outcome.notes.map(note => `${document.path}: ${note}`));
				}

				await appendLog(
					root,
					`/ingest ${kind}: read ${String(pending.length)} note(s), proposed ${String(proposals.length)} page(s)`,
				);
				await handlePlanned({proposals, refusals: [], notes, error: undefined});
			} catch (caught) {
				append([error(caught instanceof Error ? caught.message : String(caught))]);
			} finally {
				setBusy(false);
				setBusyLabel(undefined);
			}
		},
		[append, ensure, handlePlanned, root],
	);

	/**
	 * Adoption arrives already decided — it is a copy of what a page says, not a
	 * model's reading of it — so App only opens the gate.
	 *
	 * `allowRaw` because the point is to write into `raw/`. The curator is the
	 * only other holder of that permission, and for the same reason: both put
	 * something into the author's own record rather than deriving from it, which
	 * is exactly the write that must never happen unreviewed.
	 */
	const openAdoption = useCallback(
		async (proposals: readonly Proposal[], title: string) => {
			const batch = await ReviewBatch.create(root, [...proposals], {allowRaw: true});
			for (const problem of batch.validatePaths()) {
				append([error(`unsafe proposal ${problem.path}: ${problem.reason}`)]);
			}
			setReview({batch, title});
		},
		[append, root],
	);

	/** Corrections that survived the guard go to the same gate every write uses. */
	const handleFixed = useCallback(
		async (outcome: FixOutcome) => {
			if (outcome.proposals.length === 0) {
				return;
			}

			const batch = await ReviewBatch.create(root, outcome.proposals);
			for (const problem of batch.validatePaths()) {
				append([error(`unsafe proposal ${problem.path}: ${problem.reason}`)]);
			}
			setReview({batch, title: 'review — corrections'});
		},
		[append, root],
	);

	/** Interview finished: report, then hand any proposals to the review gate. */
	const handleInterviewDone = useCallback(
		async (outcome: InterviewOutcome, kind: InterviewKind) => {
			setInterview(undefined);

			const summary: Line[] = [
				ok(`transcript saved → ${outcome.transcriptPath.replace(root, '.')}`),
			];

			for (const field of outcome.openFields) {
				summary.push(muted(`? ${field.question}`));
			}
			for (const contradiction of outcome.contradictions) {
				summary.push(text(`! ${contradiction.detail}`, {color: '#e0af68'}));
			}
			for (const dropped of outcome.droppedStubs) {
				summary.push(muted(`~ stub ${dropped.stub.id} skipped — ${dropped.reason}`));
			}

			if (outcome.extractionError !== undefined) {
				summary.push(
					error(`extraction failed: ${outcome.extractionError}`),
					muted(
						`the transcript is saved and still open — /${kind} resume then /done re-runs it`,
					),
				);
				append(summary);
				return;
			}

			if (outcome.proposals.length === 0) {
				summary.push(muted('no corpus changes proposed'));
				append(summary);
				return;
			}

			const batch = await ReviewBatch.create(root, outcome.proposals);
			for (const problem of batch.validatePaths()) {
				summary.push(error(`unsafe proposal ${problem.path}: ${problem.reason}`));
			}
			append(summary);
			setReview({batch, title: `review — ${kind}`});
		},
		[append, root],
	);

	/**
	 * Acts on a `CommandResult`, whoever produced it.
	 *
	 * Lifted out of `handleSubmit` so a confirmed action and an unconfirmed one
	 * travel the same path: `confirm.proceed` is an ordinary result, and answering
	 * yes dispatches it here rather than through a second, parallel version of
	 * this chain that would drift from it.
	 */
	const applyResult = useCallback(
		async (result: CommandResult, name: string): Promise<void> => {
			// Asked before anything is acted on, and before `lines` are consumed by
			// a branch below — the explanation belongs above the question.
			if (result.confirm) {
				if (result.lines.length > 0) {
					append(result.lines);
				}
				setConfirm(result.confirm);
				return;
			}

			if (result.exit) {
				// The server outlives the command that started it, so quitting has
				// to close it or the port stays held by a session that is gone.
				await stopWikiServe();
				exit();
				return;
			}
			if (result.switchProject !== undefined) {
				const next = result.switchProject;
				// Anything scoped to the old vault has to go: an active
				// character, a half-finished review, an open interview, an
				// reviewer grounded on a corpus that is no longer loaded.
				setActiveCharacter(undefined);
				setPager(undefined);
				setReview(undefined);
				setInterview(undefined);
				setReviewing(undefined);
				// The wiki server serves one vault; it must not keep serving the
				// old one after a switch.
				await stopWikiServe();
				setRoot(next);
			}

			if (result.interview) {
				await startInterview(
					result.interview.kind,
					result.interview.focus,
					result.interview.resume ?? false,
					result.interview.agenda,
				);
			} else if (result.curator) {
				await openCurator();
			} else if (result.adopt) {
				append(result.lines);
				await openAdoption(result.adopt.proposals, result.adopt.title);
			} else if (result.ingest) {
				append(result.lines);
				await runIngest(result.ingest.kind, result.ingest.focus);
			} else if (result.reviewer) {
				await startReviewer();
			} else if (result.wizard) {
				setWizard(result.wizard);
			} else if (result.paged && result.lines.length > 0) {
				setPager({title: result.title ?? name, lines: result.lines});
			} else if (result.lines.length > 0) {
				append(result.lines);
			}
			if (result.dirty) {
				recompute();
			}
			if (result.openEditor !== undefined) {
				await openAuthoring(result.openEditor);
			}
		},
		[
			append,
			exit,
			openAdoption,
			openAuthoring,
			openCurator,
			recompute,
			runIngest,
			startInterview,
			startReviewer,
		],
	);

	const handleSubmit = useCallback(
		(value: string) => {
			const trimmed = value.trim();
			setDraft('');
			if (trimmed === '') {
				return;
			}

			// Recorded before dispatch, and whatever was typed — a mistyped command is
			// exactly the line worth arrowing back to and fixing.
			setHistory(current => extendHistory(current, trimmed));
			void appendHistory(root, trimmed);

			const [head = '', ...args] = trimmed.split(/\s+/);
			const name = head.startsWith('/') ? head.slice(1) : head;
			const command = findCommand(name);

			append([text(`› ${trimmed}`, {color: theme.color.brand})]);

			if (!command) {
				append([error(`unknown command '${name}' — try /help`)]);
				return;
			}

			setBusy(true);
			void (async () => {
				try {
					// Wait out the initial load so an early command does not see an
					// undefined project and wrongly report that there is no vault.
					const resolved = await ensure();
					const context: CommandContext = {
						root,
						project: resolved,
						activeCharacter,
						setActiveCharacter,
						consentFormulas,
					};

					const result = await command.run(args, context);
					await applyResult(result, name);
				} catch (caught) {
					append([error(caught instanceof Error ? caught.message : String(caught))]);
				} finally {
					setBusy(false);
					setBusyLabel(undefined);
				}
			})();
		},
		[activeCharacter, append, applyResult, consentFormulas, ensure, root],
	);

	const banner = useMemo<Line[]>(() => {
		const where: Line[] = [muted(displayPath(initialRoot))];

		// Reopening somewhere other than the launch directory has to be visible,
		// or an author edits the wrong book and only notices later.
		if (startup?.mode === 'last') {
			where.push(muted('reopened your last project · litfire . for this directory'));
		} else if (startup?.mode === 'stale') {
			where.push(
				text(`last project is gone: ${displayPath(startup.missing ?? '')}`, {
					color: '#e0af68',
				}),
				muted('opened this directory instead'),
			);
		}

		return [
			text(`litfire v${version}`, {bold: true, color: theme.color.brand}),
			muted('a LitRPG authoring tool — the filesystem is the API'),
			...where,
			muted('/help for commands · ctrl+c to quit'),
			{text: ''},
		];
	}, [version, initialRoot, startup]);

	// Banner rides in the same <Static> list as the log so it prints once, above
	// the live region, rather than floating between the log and the composer.
	const staticItems = useMemo<Entry[]>(
		() => [{id: 'banner', lines: banner}, ...entries],
		[banner, entries],
	);

	if (interview) {
		return (
			<InterviewScreen
				session={interview.session}
				provider={interview.provider}
				root={root}
				grounding={interview.grounding}
				rows={rows}
				columns={columns}
				onDone={outcome => {
					void handleInterviewDone(outcome, interview.session.kind);
				}}
				onCancel={exchanges => {
					const kind = interview.session.kind;
					setInterview(undefined);
					append(
						exchanges === 0
							? [muted('interview closed — nothing to save')]
							: [
									ok(`paused — ${exchanges} exchange${exchanges === 1 ? '' : 's'} saved`),
									muted(`/${kind} resume to pick it up where you left off`),
								],
					);
				}}
			/>
		);
	}

	if (review) {
		return (
			<DiffReview
				batch={review.batch}
				title={review.title}
				rows={rows}
				columns={columns}
				onExternalEdit={async (contents, proposalPath) => {
					const command = await resolveEditor(root);
					if (command === undefined) {
						return undefined;
					}
					return editText(command, contents, proposalPath);
				}}
				onDone={outcome => {
					setReview(undefined);
					const lines: Line[] = [];
					for (const written of outcome.written) {
						lines.push(ok(`wrote ${written}`));
					}
					// Named as what it was. A deletion reported as "wrote" is the
					// kind of log line someone trusts and should not.
					for (const removed of outcome.removed) {
						lines.push(ok(`removed ${removed}`));
					}
					for (const failure of outcome.failed) {
						lines.push(error(`${failure.path}: ${failure.reason}`));
					}
					if (
						outcome.written.length === 0 &&
						outcome.removed.length === 0 &&
						outcome.failed.length === 0
					) {
						lines.push(muted('nothing applied'));
					}
					append(lines);
					recompute();
				}}
				onCancel={() => {
					setReview(undefined);
					append([muted('review cancelled — nothing was written')]);
				}}
			/>
		);
	}

	// Above the conversations for the same reason the review gate is: a scene the
	// author is part-way through writing is the most expensive thing on screen to
	// lose, so nothing may render over the top of it.
	if (authoring) {
		return (
			<Box flexDirection="column" paddingX={1}>
				<TextBuffer
					contents={authoring.body}
					path={path.relative(root, authoring.file)}
					columns={columns}
					// The whole terminal, less the padding this Box adds.
					height={rows - 1}
					confirmDiscard
					onSave={body => {
						void saveAuthoring(authoring.file, authoring.data, body);
					}}
					onCancel={() => {
						setAuthoring(undefined);
						append([muted('closed without saving')]);
					}}
				/>
			</Box>
		);
	}

	// Deliberately after the review gate: a correction pass opens the gate over
	// the top, and clearing it drops the author back into the same conversation
	// rather than a fresh one that has forgotten what they were doing.
	if (reviewing) {
		return (
			<ReviewerMode
				root={root}
				project={project ?? reviewing.project}
				provider={reviewing.provider}
				session={reviewing.session}
				register={reviewing.register}
				rows={rows}
				columns={columns}
				onFixed={outcome => {
					void handleFixed(outcome);
				}}
				onExit={() => {
					setReviewing(undefined);
					append([muted('reviewer closed')]);
				}}
			/>
		);
	}

	if (curating) {
		return (
			<CuratorMode
				root={root}
				project={project ?? curating.project}
				provider={curating.provider}
				session={curating.session}
				register={curating.register}
				rows={rows}
				columns={columns}
				onPlanned={outcome => {
					void handlePlanned(outcome);
				}}
				onExit={() => {
					setCurating(undefined);
					append([muted('curator closed')]);
				}}
			/>
		);
	}

	if (wizard === 'provider') {
		return (
			<ProviderWizard
				rows={rows}
				columns={columns}
				onDone={result => {
					void (async () => {
						// Save before clearing the wizard: the footer re-reads config when
						// `wizard` changes, so clearing first would read a stale file.
						await saveProvider(root, {id: result.provider, model: result.model});
						setWizard(undefined);
						append([
							ok(`provider set to ${result.provider} · ${result.model}`),
							muted('key stored outside the vault; /provider status to review'),
						]);
						recompute();
					})();
				}}
				onCancel={() => {
					setWizard(undefined);
					append([muted('provider setup cancelled')]);
				}}
			/>
		);
	}

	if (pager) {
		return (
			<Pager
				title={pager.title}
				lines={pager.lines}
				rows={rows}
				columns={columns}
				onClose={() => setPager(undefined)}
			/>
		);
	}

	return (
		<Box flexDirection="column">
			<Static items={staticItems}>
				{item => (
					<Box key={item.id} flexDirection="column" paddingX={1}>
						{item.lines.map((line, index) => (
							<LineView key={`${item.id}-${index}`} line={line} />
						))}
					</Box>
				)}
			</Static>

			{projectError !== undefined && (
				<Box paddingX={1}>
					<Text color={theme.color.error}>{projectError}</Text>
				</Box>
			)}

			{confirm === undefined ? undefined : (
				<Box paddingX={1}>
					<Text color="#e0af68">{confirm.question} </Text>
					<Text dimColor>y/N</Text>
				</Box>
			)}

			<Composer
				value={draft}
				onChange={setDraft}
				onSubmit={handleSubmit}
				disabled={busy || confirm !== undefined}
				{...(busyLabel === undefined ? {} : {busyLabel})}
				history={history}
			/>

			<Footer
				project={project}
				status={status}
				activeCharacter={activeCharacter}
				columns={columns}
				providerLabel={providerLabel}
				projectLabel={projectName(root)}
			/>
		</Box>
	);
}
