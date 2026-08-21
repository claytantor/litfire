import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
	arcSchema,
	chapterSchema,
	momentSchema,
	placeSchema,
	situationSchema,
} from '../domain/schema.js';
import {
	calendarFor,
	CALENDAR_FORMULA_ID,
	describeDuration,
	gregorian,
	grouped,
	readWhen,
	timeSchema,
} from '../time/index.js';
import {
	INGEST_KINDS,
	SOURCE_KINDS,
	isIngestKind,
	readRaw,
	type IngestKind,
} from '../ingest/index.js';
import {planAdoption} from '../ingest/adopt.js';
import {
	agendaFor,
	askable,
	BRIEF_FOR,
	INTERVIEWABLE,
	renderAgenda,
} from '../interview/agenda.js';
import {readIngestState, statusOf} from '../ingest/state.js';
import {authoredFile, setAuthored} from '../ingest/authoring.js';
import {partitionChapters} from '../chapters/index.js';
import {renderManuscript} from '../chapters/manuscript.js';
import {
	findProvider,
	forgetKey,
	maskKey,
	PROVIDERS,
	resolveKey,
	verifyStoredKey,
	type ProviderId,
	type ResolvedKey,
} from '../llm/index.js';
import {
	AGENCY_NOTE,
	LEXICON_KEYS,
	ORIGIN_NOTE,
	VISIBILITY_NOTE,
	isLexiconKey,
	lexiconPairs,
	listProfiles,
	loadSetting,
	term,
	writeLexiconTerm,
} from '../genre/index.js';
import {findOrphanedInterviews, findResumable} from '../interview/index.js';
import {renderStatusBlock, writeStatusBlock} from '../system/status.js';
import {buildWiki, writeWiki} from '../wiki/index.js';
import {
	SERVE_SCRIPT,
	currentServe,
	startWikiServe,
	stopWikiServe,
	writeServeScript,
} from '../wiki/host.js';
import {readConfig, recordConsent} from '../vault/config.js';
import {parseDocument, stringifyDocument} from '../vault/frontmatter.js';
import {LEGACY_DIRECTORIES, VAULT, resolve} from '../vault/paths.js';
import {
	displayPath,
	inspectProject,
	projectName,
	readLastProject,
	readLiveRecent,
	resolveProjectPath,
} from '../vault/projects.js';
import {scaffoldVault} from '../vault/scaffold.js';
import {
	blank,
	columns,
	error,
	heading,
	muted,
	ok,
	text,
	warn,
	type Command,
	type CommandContext,
	type CommandResult,
	type Line,
} from './types.js';
import {
	renderChapter,
	renderChapters,
	renderLint,
	renderPacing,
	renderPrimitives,
	renderCharacter,
	renderQuestions,
	renderArc,
	renderArcs,
	renderMoment,
	renderMoments,
	renderPlace,
	renderPlaces,
	renderTime,
	renderUnreadableTime,
	renderCast,
	renderSheet,
	renderSystem,
	renderThemes,
	renderTimeline,
} from './views.js';

const needsProject = (): CommandResult => ({
	lines: [error('no vault loaded here — run /init first')],
});

/** D3: sparse integers so frontmatter stays readable in Obsidian. */
const ORDER_STEP = 10;

function nextOrder(existing: readonly number[]): number {
	const max = existing.length === 0 ? 0 : Math.max(...existing);
	return max + ORDER_STEP;
}

/** Everything `/export` must refuse to write over: these hold the only copy. */
const SOURCE_DIRECTORIES: readonly string[] = [
	VAULT.meta,
	VAULT.raw,
	VAULT.setting,
	VAULT.corpus,
	VAULT.ledger,
	// The pre-corpus/ homes, so an export cannot land on a vault that has not
	// moved yet — the one case where writing over "somewhere old" is fatal.
	...Object.keys(LEGACY_DIRECTORIES),
];

const help: Command = {
	name: 'help',
	usage: '/help',
	summary: 'list commands',
	async run(_args, _context) {
		const rows = commands.map(command => [`  ${command.usage}`, command.summary]);
		return {
			lines: [heading('commands'), ...columns(rows).map(row => text(row))],
		};
	},
};

const init: Command = {
	name: 'init',
	usage: '/init',
	summary: 'scaffold a vault here',
	async run(args, context) {
		const known = listProfiles().map(profile => profile.id);

		// Args are order-insensitive: whichever one names a profile is the idiom,
		// anything else is the target path. `/init` with neither asks.
		const chosen = args.find(arg => known.includes(arg));
		const rawPath = args.find(arg => !known.includes(arg));
		const target =
			rawPath === undefined ? context.root : resolveProjectPath(context.root, rawPath);
		const suffix = rawPath === undefined ? '' : ` ${rawPath}`;

		// §10: /init asks what kind of world this is. `base` stays first-class so
		// declining to choose is a supported path, not a fallthrough.
		if (chosen === undefined) {
			return {
				lines: [
					heading('what kind of world is this?'),
					...listProfiles().map(profile =>
						text(`  /init ${(profile.id + suffix).padEnd(24)} ${profile.name}`),
					),
					blank(),
					muted(`target: ${displayPath(target)}`),
					muted('the idiom supplies vocabulary and interview questions only —'),
					muted('it never changes how state is computed, and switching later'),
					muted('re-renders the corpus without migrating a file'),
				],
			};
		}

		const state = await inspectProject(target);
		if (state === 'not-a-directory') {
			return {lines: [error(`${displayPath(target)} is a file, not a directory`)]};
		}

		const result = await scaffoldVault(target, chosen);
		const lines = [
			heading('/init'),
			ok(`created ${result.created.length} file(s)`),
			...result.created.slice(0, 12).map(file => muted(`  + ${file}`)),
		];
		if (result.created.length > 12) {
			lines.push(muted(`  … and ${result.created.length - 12} more`));
		}
		if (result.skipped.length > 0) {
			lines.push(muted(`kept ${result.skipped.length} existing file(s)`));
		}
		lines.push(
			blank(),
			muted(`idiom: ${chosen} — change it any time in system/system.md`),
			muted('open this folder in Obsidian — the graph is already connected'),
		);

		// Scaffolding somewhere else is an implicit request to work there.
		const switched = path.resolve(target) !== path.resolve(context.root);
		if (switched) {
			lines.push(ok(`switched to ${displayPath(target)}`));
		}

		return {
			lines,
			dirty: true,
			...(switched ? {switchProject: target} : {}),
		};
	},
};

const consent: Command = {
	name: 'consent',
	usage: '/consent',
	summary: 'allow this vault’s formulas to execute',
	async run(_args, context) {
		if (!context.project) {
			return needsProject();
		}
		if (context.project.vault.formulas.length === 0) {
			return {lines: [muted('this vault defines no formulas')]};
		}

		await recordConsent(context.root, context.project.formulaHash);
		context.consentFormulas(context.project.formulaHash);
		return {
			lines: [
				ok(`formulas enabled (${context.project.formulaHash.slice(0, 12)})`),
				muted('they run in an isolate with no clock, no randomness, and no I/O'),
			],
			dirty: true,
		};
	},
};

const sheet: Command = {
	name: 'sheet',
	usage: '/sheet <character> [at]',
	summary: 'rendered state at a point in the sequence',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const characterId = args[0] ?? context.activeCharacter;
		if (!characterId) {
			return {lines: [error('usage: /sheet <character> [at]')]};
		}

		context.setActiveCharacter(characterId);
		const lines = renderSheet(context.project, characterId, args[1]);
		return {lines, paged: lines.length > 14, title: `sheet ${characterId}`};
	},
};

/**
 * Finds a situation's file by reading ids out of frontmatter rather than
 * guessing its slug, the same way the linking verbs do. Placed situations sit
 * flat in `situations/`, unplaced ones in `situations/inbox/`.
 */
async function findSituationFile(root: string, id: string): Promise<string | undefined> {
	for (const directory of [resolve(root, VAULT.situations), resolve(root, VAULT.inbox)]) {
		const entries = await readdir(directory).catch(() => [] as string[]);
		for (const entry of entries.filter(name => name.endsWith('.md'))) {
			const file = path.join(directory, entry);
			const raw = await readFile(file, 'utf8').catch(() => undefined);
			if (raw !== undefined && parseDocument(raw).data['id'] === id) {
				return file;
			}
		}
	}

	return undefined;
}

const status: Command = {
	name: 'status',
	usage: '/status <character> [at] · /status write <character> <situation>',
	summary: 'render an in-world status block, or place one in a situation',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const {profile} = await loadSetting(context.root);
		const [head, ...rest] = args;

		if (head === 'write') {
			const [characterId, situationId] = rest;
			if (!characterId || !situationId) {
				return {lines: [error('usage: /status write <character> <situation>')]};
			}

			// The block is rendered from the snapshot *at* that situation, not from
			// current state: a status screen in an early scene showing end-of-book
			// numbers is exactly the contradiction this tool exists to catch.
			const state = context.project.replay.snapshots.get(situationId);
			if (!state) {
				return {
					lines: [
						error(`'${situationId}' has no state in the replay sequence`),
						muted(
							'an unplaced situation has no point in time — /situation <id> arc <arc> first',
						),
					],
				};
			}

			const character = state.characters[characterId];
			if (!character) {
				return {lines: [error(`no character '${characterId}' at ${situationId}`)]};
			}

			const file = await findSituationFile(context.root, situationId);
			if (file === undefined) {
				return {lines: [error(`no file for situation '${situationId}'`)]};
			}

			const block = renderStatusBlock(character, {profile});
			await writeStatusBlock(file, block, {char: characterId, at: situationId});

			return {
				lines: [
					ok(`${profile.status_template} block → ${path.relative(context.root, file)}`),
					muted('regenerate any time — only the marked span is replaced'),
				],
				dirty: true,
			};
		}

		const characterId = head ?? context.activeCharacter;
		if (!characterId) {
			return {lines: [error(`usage: ${status.usage}`)]};
		}

		const at = rest[0];
		const state =
			at === undefined
				? context.project.replay.state
				: context.project.replay.snapshots.get(at);
		if (!state) {
			return {lines: [error(`no step '${at}' in the replay sequence`)]};
		}

		const character = state.characters[characterId];
		if (!character) {
			return {lines: [error(`no character '${characterId}' in the ledger`)]};
		}

		context.setActiveCharacter(characterId);
		const block = renderStatusBlock(character, {profile});

		const lines = [
			heading(`status — ${characterId}${at === undefined ? '' : `  @ ${at}`}`),
			muted(`${profile.status_template} template, from ${profile.name}`),
			blank(),
			...block.split('\n').map(line => text(line)),
			blank(),
			muted(`/status write ${characterId} <situation> to place it`),
		];
		return {lines, paged: lines.length > 14, title: `status ${characterId}`};
	},
};

const chapter: Command = {
	name: 'chapter',
	usage: '/chapter [<id> | new <situation> [title] | move <id> <situation>]',
	summary: 'cut the sequence into chapters, and see the seams',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const [sub, ...rest] = args;

		if (sub === 'new') {
			const [startsAt, ...title] = rest;
			if (!startsAt) {
				return {lines: [error('usage: /chapter new <situation> [title]')]};
			}

			// A chapter opening on a scene that is not in the replay sequence claims
			// nothing, so it is refused here rather than shipped as an issue the
			// author has to go and read.
			const inSequence = context.project.replay.sequence.some(
				step => step.kind === 'situation' && step.id === startsAt,
			);
			if (!inSequence) {
				const exists = context.project.vault.situations.some(s => s.id === startsAt);
				return {
					lines: [
						error(`'${startsAt}' is not in the replay sequence`),
						muted(
							exists
								? 'it is unplaced — /situation <id> arc <arc> places it'
								: 'no situation by that id',
						),
					],
				};
			}

			if (context.project.vault.chapters.some(c => c.starts_at === startsAt)) {
				return {lines: [error(`a chapter already opens on ${startsAt}`)]};
			}

			const id = `ch-${String(context.project.vault.chapters.length + 1).padStart(3, '0')}`;
			const order = nextOrder(context.project.vault.chapters.map(c => c.order));
			const file = resolve(context.root, VAULT.chapters, `${id}.md`);

			await writeFile(
				file,
				stringifyDocument({
					data: chapterSchema.parse({
						id,
						order,
						starts_at: startsAt,
						...(title.length > 0 ? {title: title.join(' ')} : {}),
					}),
					body: `\nOpens on [[${startsAt}]]. Transitions between scenes live here, in\n\`litrpg:transition\` blocks — the scenes themselves are never edited.\n`,
				}),
				{encoding: 'utf8', flag: 'wx'},
			);

			return {
				lines: [
					ok(`created ${path.relative(context.root, file)} opening on ${startsAt}`),
					muted('/chapter to see what it claims'),
				],
				dirty: true,
			};
		}

		if (sub === 'move') {
			const [id, startsAt] = rest;
			if (!id || !startsAt) {
				return {lines: [error('usage: /chapter move <id> <situation>')]};
			}

			const file = resolve(context.root, VAULT.chapters, `${id}.md`);
			const raw = await readFile(file, 'utf8').catch(() => undefined);
			if (raw === undefined) {
				return {lines: [error(`no chapter file for '${id}'`)]};
			}

			const document = parseDocument(raw);
			await writeFile(
				file,
				// P6: only the cut moves. The body is the author's connective text.
				stringifyDocument({
					data: {...document.data, starts_at: startsAt},
					body: document.body,
				}),
				'utf8',
			);

			return {lines: [ok(`${id} now opens on ${startsAt}`)], dirty: true};
		}

		const lines =
			sub === undefined
				? renderChapters(context.project)
				: renderChapter(context.project, sub);
		return {lines, paged: lines.length > 14, title: 'chapters'};
	},
};

const exportManuscript: Command = {
	name: 'export',
	usage: '/export [path]',
	summary: 'assemble the chapters into a manuscript',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const {chapters, situations} = context.project.vault;
		if (chapters.length === 0) {
			return {
				lines: [
					error('no chapters to assemble'),
					muted('/chapter new <situation> [title] cuts the first one'),
				],
			};
		}

		const partition = partitionChapters(chapters, context.project.replay.sequence);

		// Bodies are read at export time rather than held in the vault cache: the
		// manuscript is the one place the whole corpus is materialised, and reading
		// it fresh keeps that from being paid for on every recompute.
		const bodies = new Map<string, string>();
		for (const directory of [VAULT.situations, VAULT.inbox]) {
			const entries = await readdir(resolve(context.root, directory)).catch(
				() => [] as string[],
			);
			for (const entry of entries.filter(name => name.endsWith('.md'))) {
				const raw = await readFile(
					path.join(resolve(context.root, directory), entry),
					'utf8',
				).catch(() => undefined);
				if (raw === undefined) {
					continue;
				}
				const {data, body} = parseDocument(raw);
				if (typeof data['id'] === 'string') {
					bodies.set(data['id'], body);
				}
			}
		}

		const chapterBodies = new Map<string, string>();
		for (const entry of chapters) {
			const raw = await readFile(
				resolve(context.root, VAULT.chapters, `${entry.id}.md`),
				'utf8',
			).catch(() => undefined);
			chapterBodies.set(entry.id, raw === undefined ? '' : parseDocument(raw).body);
		}

		// `resolveProjectPath` rather than `resolve`, so `/export ~/book.md` and an
		// absolute path behave the way an author expects instead of being joined
		// onto the vault root.
		const target = args[0] ?? VAULT.manuscript;
		const file = resolveProjectPath(context.root, target);

		// Export produces output, so it must never land on source. Without this a
		// mistyped `/export situations/sit-014.md` overwrites the scene with a
		// manuscript that contains it — and the scene is the only copy.
		const relative = path.relative(context.root, file).split(path.sep).join('/');
		const isSource =
			!relative.startsWith('..') &&
			SOURCE_DIRECTORIES.some(dir => relative === dir || relative.startsWith(`${dir}/`));
		if (isSource) {
			return {
				lines: [
					error(`refusing to export onto ${relative} — that is source, not output`),
					muted(`/export writes ${VAULT.manuscript} by default`),
				],
			};
		}

		await writeFile(
			file,
			renderManuscript({
				partition,
				situations,
				bodies,
				chapterBodies,
				title: projectName(context.root),
			}),
			'utf8',
		);

		const scenes = partition.spans.reduce(
			(total, span) => total + span.situations.length,
			0,
		);
		const orphans = partition.unclaimed.filter(step => step.kind === 'situation').length;

		return {
			lines: [
				ok(
					`assembled ${partition.spans.length} chapter(s), ${scenes} scene(s) → ${target}`,
				),
				...(orphans > 0
					? [
							text(`${orphans} scene(s) appended under "Not yet in a chapter"`, {
								color: '#e0af68',
							}),
						]
					: []),
				muted('regenerated wholesale — edit chapters/ and situations/, not this file'),
			],
		};
	},
};

const wiki: Command = {
	name: 'wiki',
	usage: '/wiki [build | serve [port] [lan|<addr>] | stop]',
	summary: 'derived cross-reference of the corpus, browsable over http',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const [sub, ...rest] = args;
		const running = currentServe();

		if (sub === 'stop') {
			if (!running) {
				return {lines: [muted('no wiki server running')]};
			}
			await stopWikiServe();
			return {lines: [ok('wiki server stopped')]};
		}

		if (sub === 'build' || sub === undefined) {
			if (sub === undefined && running) {
				// Bare `/wiki` with a server up is a status question, not a rebuild.
				return {
					lines: [
						ok(`serving ${running.url}`),
						muted('/wiki build to regenerate · /wiki stop to stop'),
					],
				};
			}

			const built = buildWiki(context.project);
			const result = await writeWiki(context.root, built);
			// Surfaced here too, not only in `/lint`: a thin wiki is exactly when an
			// author goes looking, and "your interview never landed" is the answer
			// they need rather than a page count that looks fine.
			const orphans = await findOrphanedInterviews(context.root);
			// Written on build, not only on serve, so the script is there to read
			// and to run by hand whether or not litfire ever starts it.
			await writeServeScript(context.root);

			return {
				lines: [
					ok(`${built.pages.length} page(s) → ${VAULT.wiki}/`),
					...(result.removed.length > 0
						? [muted(`removed ${result.removed.length} stale page(s)`)]
						: []),
					...orphans.map(orphan =>
						text(
							`${orphan.kind}${orphan.focus === undefined ? '' : ` ${orphan.focus}`}: ${orphan.exchanges} exchange(s) saved, but ${orphan.detail} — /${orphan.kind} extract`,
							{color: '#e0af68'},
						),
					),
					muted('derived from the corpus and the ledger — never hand-edit it'),
					muted(`/wiki serve, or node ${VAULT.wiki}/${SERVE_SCRIPT} yourself`),
				],
				dirty: true,
			};
		}

		if (sub === 'serve') {
			if (running) {
				return {lines: [ok(`already serving ${running.url}`)]};
			}

			// Serving an empty directory would just show the "not built yet" page,
			// so build first rather than making the author discover the extra step.
			const built = buildWiki(context.project);
			await writeWiki(context.root, built);

			// Order-insensitive, the way `/init` treats its own two arguments:
			// whichever one is all digits is the port, anything else names an
			// interface (`lan`, `all`, or a literal address).
			const portArg = rest.find(argument => /^\d+$/.test(argument));
			const hostArg = rest.find(argument => !/^\d+$/.test(argument));

			const server = await startWikiServe(context.root, {
				port: portArg === undefined ? undefined : Number.parseInt(portArg, 10),
				host: hostArg,
			});

			// Said plainly and once. Binding every interface is a real change in who
			// can read the vault, and the author should see it stated rather than
			// have to infer it from the URL.
			const reach =
				server.host === '0.0.0.0'
					? text('reachable by anything on your network — no password, no auth', {
							color: '#e0af68',
						})
					: muted('bound to 127.0.0.1 — not reachable from your network');

			return {
				lines: [
					ok(`serving ${server.url}`),
					muted(`${built.pages.length} wiki page(s) · the corpus is browsable too`),
					reach,
					muted(`running ${VAULT.wiki}/${SERVE_SCRIPT} in a thread · /wiki stop`),
				],
				dirty: true,
			};
		}

		return {lines: [error('usage: /wiki [build | serve [port] [lan|<addr>] | stop]')]};
	},
};

const reviewer: Command = {
	name: 'reviewer',
	usage: '/reviewer',
	summary: 'chat with a literary editor about the rendered corpus',
	async run(_args, context) {
		if (!context.project) {
			return needsProject();
		}
		// Provider resolution happens where the screen opens, the same way the
		// interviews do it — the command's job is to say which mode to enter.
		return {lines: [], reviewer: true};
	},
};

/** `/primitives` — every id in the vault, grouped by kind. */
const primitives: Command = {
	name: 'primitives',
	usage: '/primitives [kind]',
	summary: 'every id in the vault, grouped by kind',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const lines = renderPrimitives(context.project, args[0]);
		return {lines, paged: lines.length > 20, title: 'primitives'};
	},
};

const curator: Command = {
	name: 'curator',
	usage: '/curator',
	summary: 'shelve the raw material into an orderly, linked, cited corpus',
	async run(_args, context) {
		if (!context.project) {
			return needsProject();
		}
		return {lines: [], curator: true};
	},
};

const pacing: Command = {
	name: 'pacing',
	usage: '/pacing',
	summary: 'planned vs actual level by arc',
	async run(_args, context) {
		if (!context.project) {
			return needsProject();
		}
		const lines = renderPacing(context.project);
		return {lines, paged: lines.length > 14, title: 'pacing'};
	},
};

const timeline: Command = {
	name: 'timeline',
	usage: '/timeline',
	summary: 'the sequence: moments, arcs, and what is unplaced',
	async run(_args, context) {
		if (!context.project) {
			return needsProject();
		}
		const lines = renderTimeline(context.project);
		return {lines, paged: lines.length > 14, title: 'timeline'};
	},
};

const themes: Command = {
	name: 'themes',
	usage: '/themes',
	summary: 'what the book argues about, and where it is carried',
	async run(_args, context) {
		if (!context.project) {
			return needsProject();
		}
		const lines = renderThemes(context.project);
		return {lines, paged: lines.length > 14, title: 'themes'};
	},
};

const lint: Command = {
	name: 'lint',
	usage: '/lint',
	summary: 'run the deterministic checks',
	async run(_args, context) {
		if (!context.project) {
			return needsProject();
		}
		const orphans = await findOrphanedInterviews(context.root);
		const lines = renderLint(context.project, orphans);
		return {lines, paged: lines.length > 14, title: 'lint'};
	},
};

/**
 * `/questions [<kind>] [<id>|resume]` — what is unresolved, and being asked it.
 *
 * Bare, it lists the open queue, as it always has. Given a kind it conducts an
 * interview about that kind, opening on exactly what the checks found — which
 * is the join this tool was missing. The queue was an agenda nobody worked and
 * the interview was a brief with no idea what this vault lacks; each was the
 * other's missing half.
 *
 * It **conducts** an interview and never prints a questionnaire. The persona is
 * imperative about it — ask one question at a time, never stack, never number a
 * list — and the name is for what the author gets, not how it arrives. A
 * numbered list that waits is a form, and being better than a form is the whole
 * claim this tool makes.
 */
const questions: Command = {
	name: 'questions',
	usage: '/questions [<kind>] [<id>] [resume|new]',
	summary: 'what is unresolved — and, given a kind, an interview about it',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const [kind, ...rest] = args;
		if (kind === undefined) {
			const lines = renderQuestions(context.project);
			return {lines, paged: lines.length > 14, title: 'questions'};
		}

		if (!isIngestKind(kind) || kind === 'interview') {
			return {
				lines: [
					error(`no kind '${kind}'`),
					muted(`try one of: ${INGEST_KINDS.join(', ')}`),
				],
			};
		}

		const brief = BRIEF_FOR[kind];
		if (brief === undefined) {
			// Reported rather than refused sideways: five of the nine primitives
			// have no brief yet, and an author who asks for one deserves to be told
			// that is why, not that they typed something wrong.
			return {
				lines: [
					warn(`no interview brief for ${kind}s yet`),
					muted(`briefs exist for: ${INTERVIEWABLE.join(', ')}`),
					muted(`/${kind} new writes one by hand in the meantime`),
				],
			};
		}

		const config = await readConfig(context.root);
		if (config.provider.id === undefined || config.provider.model === undefined) {
			return {
				lines: [
					error('no model provider configured'),
					muted('run /provider to choose one — interviews need a model'),
				],
			};
		}

		const directives = new Set(['resume', 'new']);
		let focus = rest.find(one => !directives.has(one));

		// One system is not a choice, and naming it anyway keeps every transcript
		// in the same namespace as a vault that has several. Only systems: a
		// vault with one character is not a reason to refuse to talk about
		// characters in general.
		if (kind === 'system' && focus === undefined) {
			const systems = context.project.vault.systems;
			if (systems.length === 1) {
				focus = systems[0]?.id;
			}
		}

		const start: CommandResult = {
			lines: [],
			interview: {
				kind: brief,
				...(focus === undefined ? {} : {focus}),
				...(rest.includes('resume') ? {resume: true} : {}),
			},
		};

		if (rest.includes('resume')) {
			return start;
		}

		// An unfinished interview is offered rather than silently discarded or
		// silently resumed — either would be a surprise, and one of them strands
		// work the author can see on disk. Reported rather than prompted for
		// because the answer is a choice between two things, not a yes and a no.
		const unfinished = rest.includes('new')
			? undefined
			: await findResumable(context.root, brief, focus);
		if (unfinished) {
			const label = focus === undefined ? kind : `${kind} ${focus}`;
			const when = unfinished.startedAt.slice(0, 16).replace('T', ' ');
			return {
				lines: [
					heading(`unfinished ${label} interview`),
					text(
						`  ${String(unfinished.exchanges.length)} exchange${unfinished.exchanges.length === 1 ? '' : 's'}, started ${when}`,
					),
					muted(
						`  last question: ${unfinished.exchanges.at(-1)?.question.slice(0, 90) ?? ''}`,
					),
					blank(),
					text(`  /questions ${label} resume   continue where you left off`),
					text(`  /questions ${label} new      start over (the old one is kept)`),
				],
			};
		}

		// Split, because the two halves have different destinations. A faction
		// with no goal is a decision the author has not made, and the interviewer
		// should open on it. Two files claiming one id is housekeeping: it has an
		// answer that is looked up rather than asked for, and putting it to an
		// interviewer would produce the interrogation this command exists not to
		// be. The author sees both counts either way.
		const found = agendaFor(context.project, kind);
		const agenda = askable(found);
		const housekeeping = found.length - agenda.length;
		const alsoSee =
			housekeeping === 0
				? []
				: [
						muted(
							`  ${String(housekeeping)} more ${housekeeping === 1 ? 'is' : 'are'} housekeeping — /lint has ${housekeeping === 1 ? 'it' : 'those'}`,
						),
					];

		if (agenda.length === 0) {
			// The checks are happy, so there is no agenda and no reason to have
			// been asked for. Offering rather than starting is what tells the
			// author which of two quite different sessions they are about to be in:
			// filling gaps, or going deeper into something already consistent.
			return {
				lines: [
					ok(`nothing outstanding about ${kind}s that an interview can settle.`),
					...alsoSee,
				],
				confirm: {
					question: 'begin interview anyway?',
					proceed: start,
					declined: `nothing to do — /questions lists the rest of the vault`,
				},
			};
		}

		return {
			...start,
			interview: {...start.interview!, agenda: renderAgenda(agenda)},
			lines: [
				heading(
					`${String(agenda.length)} open question${agenda.length === 1 ? '' : 's'} about ${kind}s`,
				),
				...agenda.slice(0, 6).map(one => muted(`  ${one.where} — ${one.detail}`)),
				...(agenda.length > 6 ? [muted(`  …and ${String(agenda.length - 6)} more`)] : []),
				...alsoSee,
				blank(),
				// Said because the alternative reads as a promise to work the list,
				// and it is not one: the interviewer opens here and follows whatever
				// turns out to be worth following.
				muted('the interview opens here — it will not work down the list'),
			],
		};
	},
};

/**
 * `/time` — read the in-world clock, and bind it to a calendar.
 *
 * The clock itself is not configurable: every instant is whole seconds from
 * the origin, and the origin is second zero. What a binding decides is how
 * those seconds are *read* — as themselves, as Earth/Sol dates, or through a
 * calendar the author wrote as a formula.
 */
const time: Command = {
	name: 'time',
	usage: '/time [at <date> | seconds | gregorian <epoch> [zone] | custom]',
	summary: 'the in-world clock, and the calendar it is read through',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const [sub, ...rest] = args;
		const current = context.project.vault.time;

		const write = async (patch: Record<string, unknown>) => {
			const file = resolve(context.root, VAULT.time);
			const raw = await readFile(file, 'utf8').catch(() => undefined);
			const document = raw === undefined ? {data: {}, body: ''} : parseDocument(raw);
			const data = {...document.data, ...patch};
			try {
				timeSchema.parse(data);
			} catch (caught) {
				return caught instanceof Error ? caught.message.split('\n')[0]! : String(caught);
			}
			await writeFile(
				file,
				stringifyDocument({
					data,
					body:
						document.body.trim() === ''
							? '\nWhat the origin is, and why the clock starts there.\n'
							: document.body,
				}),
				'utf8',
			);
			return undefined;
		};

		if (sub === 'seconds' || sub === 'custom' || sub === 'gregorian') {
			const patch: Record<string, unknown> = {calendar: sub};

			if (sub === 'gregorian') {
				const [epoch, zone] = rest;
				if (!epoch) {
					return {
						lines: [
							error('usage: /time gregorian <epoch> [zone]'),
							muted('epoch is the real instant the origin sits at, ISO 8601'),
							muted('e.g. /time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles'),
						],
					};
				}
				// Checked here rather than on the next load: a bad epoch that only
				// surfaces as raw seconds later reads as the command having done
				// nothing at all.
				try {
					gregorian({epoch, timeZone: zone});
				} catch (caught) {
					return {
						lines: [error(caught instanceof Error ? caught.message : String(caught))],
					};
				}
				patch['epoch'] = epoch;
				if (zone !== undefined) {
					patch['timezone'] = zone;
				}
			}

			const failed = await write(patch);
			if (failed !== undefined) {
				return {lines: [error(failed)]};
			}

			return {
				lines: [
					ok(`clock read as ${sub}`),
					...(sub === 'custom'
						? [
								muted(
									`define a \`${CALENDAR_FORMULA_ID}\` formula taking seconds (BigInt)`,
								),
								muted('and returning a string — /consent lets it run'),
							]
						: []),
				],
				dirty: true,
			};
		}

		if (sub === 'origin') {
			const name = rest.join(' ');
			if (name === '') {
				return {lines: [error('usage: /time origin <what second zero is>')]};
			}
			const failed = await write({origin: name});
			return failed === undefined
				? {lines: [ok(`origin is ${name}`)], dirty: true}
				: {lines: [error(failed)]};
		}

		/**
		 * Converts between a date and the seconds a moment stores.
		 *
		 * Bidirectional on purpose, and it decides which way by looking at the
		 * input rather than asking: a bare integer is already an instant and wants
		 * reading, anything else is a date and wants converting. Both directions
		 * are the same question — "what is this, in the other notation" — and
		 * making the author remember two verbs for it would be needless.
		 */
		if (sub === 'at') {
			// Joined, because a date has spaces in it.
			const written = rest.join(' ').trim();
			if (written === '') {
				return {
					lines: [
						error('usage: /time at <date | seconds>'),
						muted('converts either way — a date to seconds, or seconds to a date'),
					],
				};
			}

			const {calendar, note} = calendarFor(current, {
				formatted: context.project.calendarText,
			});

			const instant = readWhen(written, calendar);

			if (instant === undefined) {
				return {lines: renderUnreadableTime(written, calendar, note)};
			}

			return {
				lines: [
					// Bare and unpunctuated first, because the next thing the author
					// does with it is paste it into a moment's frontmatter.
					ok(`at: ${instant.toString()}`),
					text(`reads as     ${calendar.format(instant)}`),
					text(`from origin  ${describeDuration(instant)}`),
					...(note === undefined ? [] : [muted(note)]),
				],
			};
		}

		if (sub !== undefined) {
			return {
				lines: [
					error(
						'usage: /time [at <date> | seconds | gregorian <epoch> [zone] | custom | origin <name>]',
					),
				],
			};
		}

		const {calendar, note} = calendarFor(current, {
			formatted: context.project.calendarText,
		});
		const lines = renderTime(context.project, calendar, note);
		return {lines, paged: lines.length > 14, title: 'time'};
	},
};

/**
 * `/ingest` — the author's own notes, turned into typed pages.
 *
 * The interviews go one way: ask, transcribe, extract. This is the other way an
 * author works — they already know their world, they write it into
 * `raw/characters/` and `raw/moments/`, and what they want is for the corpus to
 * catch up. There was no path from a page of notes to a page in the vault
 * except describing it to the curator.
 */
/**
 * `/ingest adopt [<kind>]` — give an authored page a note to have come from.
 *
 * The migration raw-first needs and could not previously offer. A vault written
 * before the corpus was derived has pages the author typed directly: they are
 * not a duplicate of anything in `raw/`, they are the only copy, and deleting a
 * corpus directory would take them with it. Adoption writes the note each page
 * should have had, and stamps the page to cite it.
 *
 * No model is involved. The page's own frontmatter and prose become the note,
 * unchanged — the same copy `authoredFile` makes when a single page is edited,
 * done across a whole kind at once. What it costs is one review, not one
 * request.
 *
 * Per-kind because a vault may sit half-adopted indefinitely, which is the
 * point: this is not a migration that has to be finished in one sitting.
 */
async function adopt(
	kind: string | undefined,
	context: CommandContext,
): Promise<CommandResult> {
	// Narrowed one branch at a time: `isIngestKind` also admits `interview`,
	// which is a source without a corpus directory and so cannot be adopted from.
	let only: IngestKind | undefined;
	if (kind !== undefined) {
		if (!isIngestKind(kind) || kind === 'interview') {
			return {
				lines: [
					error(`no kind '${kind}' to adopt`),
					muted(`try one of: ${INGEST_KINDS.join(', ')}`),
				],
			};
		}
		only = kind;
	}

	const kinds = only === undefined ? INGEST_KINDS : [only];
	const plan = await planAdoption(context.root, kinds);
	const scope = only === undefined ? 'this vault' : `${only}s`;

	// Reported before anything is proposed, because a page with a note already is
	// the case where adoption would destroy work rather than migrate it — and the
	// author should see that named even when there is nothing else to do.
	const notes: Line[] = plan.skipped.map(skip => warn(`  ${skip.page} — ${skip.reason}`));

	if (plan.adopting.length === 0) {
		return {
			lines: [
				plan.alreadyAdopted > 0
					? ok(
							`nothing to adopt — all ${String(plan.alreadyAdopted)} page(s) in ${scope} already cite a note`,
						)
					: muted(`nothing to adopt in ${scope}`),
				...notes,
			],
		};
	}

	const byKind = new Map<string, number>();
	for (const one of plan.adopting) {
		byKind.set(one.kind, (byKind.get(one.kind) ?? 0) + 1);
	}

	return {
		lines: [
			heading(`adopting ${String(plan.adopting.length)} page(s) from ${scope}`),
			...[...byKind].map(([name, count]) =>
				muted(`  ${String(count).padStart(3)} ${name}`),
			),
			blank(),
			muted('each page becomes a note in raw/ and is stamped to cite it —'),
			muted('after this /ingest can rebuild the corpus, so it becomes disposable'),
			...(plan.alreadyAdopted > 0
				? [muted(`${String(plan.alreadyAdopted)} page(s) already adopted, untouched`)]
				: []),
			...notes,
		],
		adopt: {
			proposals: plan.proposals,
			title: `review — adopt ${only ?? 'all'}`,
		},
	};
}

const ingest: Command = {
	name: 'ingest',
	usage: '/ingest <kind> [<document>] · /ingest adopt [<kind>]',
	summary: 'turn notes in raw/<kind>/ into typed pages, through the review gate',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const [kind, ...rest] = args;
		if (kind === 'adopt') {
			return adopt(rest[0], context);
		}
		if (kind === undefined) {
			return {
				lines: [
					error('usage: /ingest <kind> [<document>]'),
					muted(`kinds: ${SOURCE_KINDS.join(', ')}`),
					muted('/ingest adopt gives authored pages a note in raw/'),
				],
			};
		}
		if (!isIngestKind(kind)) {
			return {
				lines: [
					error(`no kind '${kind}'`),
					muted(`try one of: ${SOURCE_KINDS.join(', ')}`),
				],
			};
		}

		const focus = rest.join(' ').trim();
		const {documents, directory} = await readRaw(
			context.root,
			kind,
			focus === '' ? undefined : focus,
		);

		// Checked here rather than after a model call: there is nothing to think
		// about, and a request that costs money should not be sent to discover an
		// empty directory.
		if (documents.length === 0) {
			return {
				lines: [
					error(
						focus === ''
							? `nothing to ingest — ${directory}/ has no markdown`
							: `no document matching '${focus}' in ${directory}/`,
					),
					muted(`write your ${kind} notes there, then /ingest ${kind}`),
				],
			};
		}

		// Sorted here so the author sees the cost before it is spent: a note the
		// corpus already reflects costs nothing, and saying which ones those are
		// is the difference between a command that looks idle and one that is.
		const state = await readIngestState(context.root, kind);
		const sorted = documents.map(document => ({
			document,
			status: statusOf(state, document.path, document.contents),
		}));
		const pending = sorted.filter(entry => entry.status !== 'unchanged');

		if (pending.length === 0) {
			return {
				lines: [
					ok(`nothing to do — all ${String(documents.length)} up to date`),
					muted(`edit a note in ${directory}/ and run this again`),
				],
			};
		}

		return {
			lines: [
				muted(
					`ingesting ${String(pending.length)} of ${String(documents.length)} from ${directory}/`,
				),
				...pending.map(entry =>
					muted(`  ${entry.status.padEnd(9)} ${entry.document.path}`),
				),
				...(sorted.length === pending.length
					? []
					: [muted(`  ${String(sorted.length - pending.length)} unchanged, skipped`)]),
			],
			ingest: {kind, ...(focus === '' ? {} : {focus})},
		};
	},
};

/**
 * `/<primitive> extract` — read my notes for this kind.
 *
 * The same job `/ingest <kind>` does, reached from the primitive it concerns.
 * An author working on moments should not have to change command to turn their
 * notes into pages, and `extract` is the word the interview kinds already use
 * for "read the source material and produce corpus".
 *
 * Delegated rather than reimplemented, so the reporting — what changed, what is
 * already up to date, what would be skipped — is the same wherever it is asked
 * for.
 */
function extractFor(
	kind: IngestKind,
	id: string | undefined,
	context: CommandContext,
): Promise<CommandResult> {
	return ingest.run(id === undefined ? [kind] : [kind, id], context);
}

const PLACE_VERBS = new Set(['show', 'edit', 'extract', 'name']);

/**
 * `/place` — somewhere a scene happens.
 *
 * Places were the one kind with no schema and no command: free prose in a
 * directory, with the wiki learning one existed only by finding a situation
 * that named it. That made a place an author had written but not yet used
 * invisible, which reads as the tool having lost it.
 */
const place: Command = {
	name: 'place',
	usage: '/place [<id>] [show|edit|extract|name <text>] · /place new [name]',
	summary: 'somewhere a scene happens: write one, name it, see what happened',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const [sub, ...rest] = args;

		if (sub === 'new') {
			const name = rest.join(' ').trim();
			if (name === '') {
				return {lines: [error('usage: /place new <name>')]};
			}

			const id =
				name
					.toLowerCase()
					.replaceAll(/[^a-z0-9]+/g, '-')
					.replace(/^-|-$/g, '') || 'place';

			const file = resolve(context.root, VAULT.places, `${id}.md`);
			const already = await readFile(file, 'utf8').then(
				() => true,
				() => false,
			);
			if (already) {
				return {
					lines: [error(`place '${id}' already has a page`), muted(`/place ${id} edit`)],
				};
			}

			await mkdir(resolve(context.root, VAULT.places), {recursive: true});
			await writeFile(
				file,
				stringifyDocument({
					data: placeSchema.parse({id, name}),
					body: '\nWhat it is like to be here, and what it makes possible.\n',
				}),
				{encoding: 'utf8', flag: 'wx'},
			);

			return {
				lines: [
					ok(`created ${path.relative(context.root, file)}`),
					muted(`/situation <id> place ${id} puts a scene here`),
				],
				openEditor: file,
				dirty: true,
			};
		}

		const verb = args.find(argument => PLACE_VERBS.has(argument));
		const positional = args.filter(argument => !PLACE_VERBS.has(argument));
		const [id] = positional;

		if (verb === 'extract') {
			return extractFor('place', id, context);
		}

		if (verb === 'edit' || verb === 'name') {
			if (!id) {
				return {
					lines: [error(`usage: /place <id> ${verb}${verb === 'name' ? ' <text>' : ''}`)],
				};
			}

			if (verb === 'edit') {
				const opened = await authoredFile(context.root, 'place', id);
				return 'error' in opened
					? {
							lines: [
								error(`no page for place '${id}'`),
								muted(`/place new ${id} writes one`),
							],
						}
					: {lines: adoptionNote(opened), openEditor: opened.file};
			}

			const name = positional.slice(1).join(' ').trim();
			if (name === '') {
				return {lines: [error('usage: /place <id> name <text>')]};
			}

			const done = await setAuthored(context.root, 'place', id, {name}, value =>
				placeSchema.parse(value),
			);
			return 'error' in done
				? {lines: [error(done.error)]}
				: {
						lines: [ok(`${id} is now “${name}”`), ...adoptionNote(done)],
						dirty: true,
					};
		}

		if (
			(verb === undefined || verb === 'show') &&
			id !== undefined &&
			positional.length === 1
		) {
			const lines = renderPlace(context.project, id);
			return {lines, paged: lines.length > 14, title: `place ${id}`};
		}

		if (args.length === 0) {
			const lines = renderPlaces(context.project);
			return {lines, paged: lines.length > 14, title: 'places'};
		}

		return {
			lines: [
				error('usage: /place <id> [show|edit|name <text>]'),
				muted('/place new <name> writes one'),
			],
		};
	},
};

/**
 * What to say when an edit brought a page into `raw/` for the first time.
 *
 * Said once, plainly, and only when it happened: adoption is not something the
 * author asked for and they should be told it did, but a line on every edit
 * forever would be noise.
 */
function adoptionNote(result: {adopted: boolean; file?: string}): Line[] {
	return result.adopted
		? [muted(`adopted into ${result.file ?? 'raw/'} — your copy lives there now`)]
		: [];
}

const MOMENT_VERBS = new Set(['show', 'edit', 'extract', 'at', 'name']);

/**
 * `/moment` — the points on the clock a story hangs on.
 *
 * Until now a moment could only arrive from a timeline interview or be
 * hand-written, which left no way to correct one: an author who mistyped a date
 * had to open the file and count zeros. Editing the time is the whole reason
 * this exists, so `at` takes either notation and reports what it read back.
 */
const moment: Command = {
	name: 'moment',
	usage: '/moment [<id>] [show|edit|extract|at <when>|name <text>] · new [name]',
	summary: 'points on the in-world clock: create one, time it, describe it',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const {calendar, note} = calendarFor(context.project.vault.time, {
			formatted: context.project.calendarText,
		});
		const [sub, ...rest] = args;

		// `new` leads, because everything after it is a free-text name.
		if (sub === 'new') {
			const name = rest.join(' ').trim();
			if (name === '') {
				return {lines: [error('usage: /moment new <name>')]};
			}

			const id =
				name
					.toLowerCase()
					.replaceAll(/[^a-z0-9]+/g, '-')
					.replace(/^-|-$/g, '') || 'moment';

			if (context.project.vault.moments.some(candidate => candidate.id === id)) {
				return {
					lines: [
						error(`moment '${id}' already exists`),
						muted(`/moment ${id} to see it, or pick another name`),
					],
				};
			}

			const file = resolve(context.root, VAULT.moments, `${id}.md`);
			await mkdir(resolve(context.root, VAULT.moments), {recursive: true});
			await writeFile(
				file,
				stringifyDocument({
					// Deliberately undated. A moment an author has just thought of
					// usually has no date yet, and demanding one here would either
					// block the thought or invent a number (P5).
					data: momentSchema.parse({id, name}),
					body: '\nWhat changes here, and what becomes possible that was not.\n',
				}),
				{encoding: 'utf8', flag: 'wx'},
			);

			return {
				lines: [
					ok(`created ${path.relative(context.root, file)}`),
					muted(`/moment ${id} at <date> puts it on the clock`),
				],
				openEditor: file,
				dirty: true,
			};
		}

		const verb = args.find(argument => MOMENT_VERBS.has(argument));
		const positional = args.filter(argument => !MOMENT_VERBS.has(argument));
		const [id] = positional;

		if (verb === 'extract') {
			return extractFor('moment', id, context);
		}

		/**
		 * Sets a field on the author's copy in `raw/`, adopting the page there if
		 * this is the first edit, and carrying the change onto the derived page.
		 */
		const patch = (target: string, data: Record<string, unknown>) =>
			setAuthored(context.root, 'moment', target, data, value =>
				momentSchema.parse(value),
			);

		if (verb === 'at') {
			const target = id;
			const written = positional.slice(1).join(' ').trim();
			if (target === undefined || written === '') {
				return {
					lines: [
						error('usage: /moment <id> at <date | seconds>'),
						muted('takes either notation — /time at converts between them'),
					],
				};
			}

			const instant = readWhen(written, calendar);
			if (instant === undefined) {
				return {lines: renderUnreadableTime(written, calendar, note)};
			}

			// Writing the bigint, not a string: this is the clock, and it round-trips
			// through YAML at full precision only as an integer.
			const done = await patch(target, {at: instant});
			if ('error' in done) {
				return {lines: [error(done.error)]};
			}

			return {
				lines: [
					ok(`${target} at ${grouped(instant)}`),
					muted(
						`reads as ${calendar.format(instant)} · ${describeDuration(instant)} from origin`,
					),
					...adoptionNote(done),
				],
				dirty: true,
			};
		}

		if (verb === 'name') {
			const target = id;
			const name = positional.slice(1).join(' ').trim();
			if (target === undefined || name === '') {
				return {lines: [error('usage: /moment <id> name <text>')]};
			}
			const done = await patch(target, {name});
			return 'error' in done
				? {lines: [error(done.error)]}
				: {
						lines: [ok(`${target} is now “${name}”`), ...adoptionNote(done)],
						dirty: true,
					};
		}

		if (verb === 'edit') {
			if (!id) {
				return {lines: [error('usage: /moment <id> edit')]};
			}
			const opened = await authoredFile(context.root, 'moment', id);
			return 'error' in opened
				? {lines: [error(`${opened.error} — /moment new <name> creates one`)]}
				: {lines: adoptionNote(opened), openEditor: opened.file};
		}

		if (
			(verb === undefined || verb === 'show') &&
			id !== undefined &&
			positional.length === 1
		) {
			const lines = renderMoment(context.project, id, calendar);
			return {lines, paged: lines.length > 14, title: `moment ${id}`};
		}

		if (args.length === 0) {
			const lines = renderMoments(context.project, calendar);
			return {lines, paged: lines.length > 14, title: 'moments'};
		}

		return {
			lines: [
				error('usage: /moment <id> [show|edit|at <when>|name <text>]'),
				muted('/moment new <name> creates one'),
			],
		};
	},
};

const ARC_VERBS = new Set(['show', 'extract', 'order', 'after']);

/**
 * `/arc` — the narrative order situations are placed into.
 *
 * An arc has to exist before a situation can be placed on one, and until now
 * nothing created one: an author either hand-wrote `timeline/arcs/arc-01.md` or
 * had no arcs at all, which left the wiki with no arc pages and every situation
 * stuck in the inbox.
 */
const arc: Command = {
	name: 'arc',
	usage: '/arc [<id> [show|extract|order <n>|after <moment>]] · /arc new [title]',
	summary: 'the narrative order: create arcs, order them, anchor them',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const [sub, ...rest] = args;

		// As with `/situation new`, the verb leads because the rest is a title.
		if (sub === 'new') {
			const arcs = context.project.vault.arcs;
			const id = `arc-${String(arcs.length + 1).padStart(2, '0')}`;
			const title = rest.join(' ') || 'Untitled';
			const file = resolve(context.root, VAULT.arcs, `${id}.md`);

			await writeFile(
				file,
				stringifyDocument({
					data: arcSchema.parse({
						id,
						name: title,
						// Arcs count 1, 2, 3 — D3's sparse step is for situations *within*
						// an arc, where an insertion between two existing scenes is
						// routine. Arcs are reordered far less often and read better
						// numbered the way the scaffold numbers them.
						order:
							Math.max(
								0,
								...arcs.map(a => a.order).filter((o): o is number => o !== undefined),
							) + 1,
					}),
					body: `\nWhat this arc is about, and what failure looks like in it.\n`,
				}),
				{encoding: 'utf8', flag: 'wx'},
			);

			return {
				lines: [
					ok(`created ${path.relative(context.root, file)}`),
					muted(`/arc ${id} after <moment> anchors it on the clock`),
					muted(`/situation <id> arc ${id} places a scene on it`),
				],
				dirty: true,
			};
		}

		const verb = args.find(argument => ARC_VERBS.has(argument));
		const positional = args.filter(argument => !ARC_VERBS.has(argument));
		const [id] = positional;

		if (verb === 'extract') {
			return extractFor('arc', id, context);
		}

		if (verb === 'order') {
			const [, value] = positional;
			const order = Number(value);
			if (!id || value === undefined || !Number.isInteger(order)) {
				return {lines: [error('usage: /arc <id> order <integer>')]};
			}
			const patched = await patchArc(context.root, id, {order});
			return 'error' in patched
				? {lines: [error(patched.error)]}
				: {
						lines: [
							ok(`${id} replays at order ${String(order)}`),
							...adoptionNote(patched),
						],
						dirty: true,
					};
		}

		if (verb === 'after') {
			const [, momentId] = positional;
			if (!id || !momentId) {
				return {lines: [error('usage: /arc <id> after <moment>')]};
			}
			if (!context.project.vault.moments.some(m => m.id === momentId)) {
				return {
					lines: [
						error(`no moment '${momentId}'`),
						muted('/primitives moment lists them'),
					],
				};
			}
			const patched = await patchArc(context.root, id, {starts_after: momentId});
			return 'error' in patched
				? {lines: [error(patched.error)]}
				: {
						lines: [
							ok(`${id} starts after ${momentId}`),
							...adoptionNote(patched),
							// This is the link that lets moments interleave ahead of the
							// arc's situations, which is what gives their scenes a clock
							// position to inherit.
							muted('its situations now inherit a moment from the sequence'),
						],
						dirty: true,
					};
		}

		if (
			(verb === undefined || verb === 'show') &&
			id !== undefined &&
			positional.length === 1
		) {
			const lines = renderArc(context.project, id);
			return {lines, paged: lines.length > 14, title: `arc ${id}`};
		}

		if (args.length === 0) {
			const lines = renderArcs(context.project);
			return {lines, paged: lines.length > 14, title: 'arcs'};
		}

		return {
			lines: [
				error('usage: /arc [<id> [show|order <n>|after <moment>]]'),
				muted('/arc new [title] creates one'),
			],
		};
	},
};

/** The arc counterpart: the same adopt-on-edit path every other kind takes. */
async function patchArc(
	root: string,
	id: string,
	patch: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof setAuthored>>> {
	return setAuthored(root, 'arc', id, patch, value => arcSchema.parse(value));
}

/**
 * Words that are verbs rather than an id, so the two can be told apart wherever
 * they appear. `new` is absent deliberately — it is handled before this is
 * consulted, because its remaining arguments are a free-text title.
 *
 * `arc` and `place` are separate verbs on purpose. `arc:` is where a scene sits
 * in the narrative order and `place:` is where it happens; one verb meaning both
 * is the kind of collision that makes a workflow impossible to write down.
 */
const SITUATION_VERBS = new Set([
	'show',
	'edit',
	'extract',
	'arc',
	'place',
	'moment',
	'cast',
]);

/**
 * Sets a field on a scene's authored copy.
 *
 * Every linking verb goes through here, so the author's prose is untouchable by
 * construction rather than by each verb remembering (P6) — and so the layer a
 * scene is authored in is decided in one place.
 */
async function patchSituation(
	root: string,
	id: string,
	patch: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof setAuthored>>> {
	return setAuthored(root, 'situation', id, patch, value => situationSchema.parse(value));
}

const situation: Command = {
	name: 'situation',
	usage: '/situation <id> [show|edit|extract|cast|place|moment|arc] · new [title]',
	summary: 'show a scene\u2019s cast, write it, and link it to the world',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const [sub, ...rest] = args;

		// `new` is the one verb that must come first: everything after it is a
		// free-text title, and a scene called "The Place" would otherwise lose a
		// word to the argument parser.
		if (sub === 'new') {
			const taken = new Set(context.project.vault.situations.map(each => each.id));
			// Counted past what is taken rather than from the length: a vault that
			// has had a scene removed would otherwise mint an id that already
			// exists, which is the failure this whole change is about.
			let next = context.project.vault.situations.length + 1;
			while (taken.has(`sit-${String(next).padStart(3, '0')}`)) {
				next++;
			}
			const id = `sit-${String(next).padStart(3, '0')}`;

			// The filename is the id, with nothing appended. A slug in the name
			// made two files for one scene indistinguishable to everything that
			// looks at names, and the title is in the frontmatter already.
			const file = resolve(context.root, VAULT.situations, `${id}.md`);

			await mkdir(resolve(context.root, VAULT.situations), {recursive: true});
			await writeFile(
				file,
				stringifyDocument({
					data: situationSchema.parse({id, title: rest.join(' ') || 'Untitled'}),
					body: '\nWrite the scene here. The tool never edits this text.\n',
				}),
				{encoding: 'utf8', flag: 'wx'},
			);

			// Straight into the buffer: scaffolding a scene and then being handed
			// back to a prompt is a stall at exactly the moment the author has
			// something to write.
			return {
				lines: [
					ok(`created ${path.relative(context.root, file)}`),
					muted(`then: /situation ${id} cast <character>… · place · moment · arc`),
				],
				openEditor: file,
				dirty: true,
			};
		}

		/**
		 * Everything else reads its arguments the way `/system` and `/character`
		 * do: the verb is whichever word is a verb, and the id is whichever is
		 * not. `/situation sit-001 edit` and `/situation edit sit-001` are the
		 * same command, because an author who has just read an id off
		 * `/primitives` types it first, and being told that is the wrong order
		 * teaches nothing.
		 */
		const verb = args.find(argument => SITUATION_VERBS.has(argument));
		const positional = args.filter(argument => !SITUATION_VERBS.has(argument));

		if (verb === 'extract') {
			return extractFor('situation', positional[0], context);
		}

		if (verb === 'edit') {
			const [id] = positional;
			if (!id) {
				return {lines: [error('usage: /situation <id> edit')]};
			}

			const file = await findSituationFile(context.root, id);
			if (file === undefined) {
				return {lines: [error(`no file for situation '${id}'`)]};
			}

			return {lines: [], openEditor: file};
		}

		// Anchor the scene on the clock. This is the link every character state in
		// it is addressed by: without a moment, the cast has no point in time and
		// the states read as unplaced.
		if (verb === 'moment') {
			const [id, momentId] = positional;
			if (!id || !momentId) {
				return {lines: [error('usage: /situation <id> moment <moment>')]};
			}
			if (!context.project.vault.moments.some(m => m.id === momentId)) {
				return {
					lines: [
						error(`no moment '${momentId}'`),
						muted('/primitives moment lists them · /timeline interview makes one'),
					],
				};
			}

			const patched = await patchSituation(context.root, id, {moment: momentId});
			if ('error' in patched) {
				return {lines: [error(patched.error)]};
			}
			return {
				lines: [ok(`${id} happens at ${momentId}`), ...adoptionNote(patched)],
				dirty: true,
			};
		}

		// Where it happens. Places have no schema — free prose in a directory — so
		// an unwritten one is a note, not a refusal (P4): the wiki builds a place
		// page from any id a situation names.
		if (verb === 'place') {
			const [id, placeId] = positional;
			if (!id || !placeId) {
				return {lines: [error('usage: /situation <id> place <place>')]};
			}

			const patched = await patchSituation(context.root, id, {place: placeId});
			if ('error' in patched) {
				return {lines: [error(patched.error)]};
			}

			const file = resolve(context.root, VAULT.places, `${placeId}.md`);
			const written = await readFile(file, 'utf8').then(
				() => undefined,
				() => `no places/${placeId}.md yet — the wiki will still link it`,
			);
			return {
				lines: [
					ok(`${id} happens at ${placeId}`),
					...(written ? [muted(written)] : []),
					...adoptionNote(patched),
				],
				dirty: true,
			};
		}

		// Who is in it. Additive, because a cast is assembled over several passes
		// and replacing it on every call would make each new name cost the last.
		if (verb === 'cast') {
			const [id, ...names] = positional;
			if (!id || names.length === 0) {
				return {lines: [error('usage: /situation <id> cast <character>…')]};
			}

			const found = context.project.vault.situations.find(s => s.id === id);
			if (!found) {
				return {lines: [error(`no situation '${id}'`)]};
			}

			const known = new Set(context.project.vault.characters.map(c => c.id));
			const unknown = names.filter(name => !known.has(name));
			const cast = [...new Set([...found.characters, ...names])].toSorted();

			const patched = await patchSituation(context.root, id, {characters: cast});
			if ('error' in patched) {
				return {lines: [error(patched.error)]};
			}

			return {
				lines: [
					ok(`${id} cast: ${cast.join(', ')}`),
					...adoptionNote(patched),
					// Reported, never refused: naming someone before writing their page
					// is a normal order to work in, and the checks will keep asking.
					...unknown.map(name => muted(`no character page for '${name}' yet`)),
				],
				dirty: true,
			};
		}

		if (verb === 'arc') {
			const [id, arcId] = positional;
			if (!id || !arcId) {
				return {lines: [error('usage: /situation <id> arc <arc>')]};
			}
			if (!context.project.vault.arcs.some(candidate => candidate.id === arcId)) {
				return {
					lines: [error(`no arc '${arcId}'`), muted('/arc new <title> creates one')],
				};
			}

			const found = context.project.vault.situations.find(s => s.id === id);
			if (!found) {
				return {lines: [error(`no situation '${id}'`)]};
			}

			const orders = context.project.vault.situations
				.filter(s => s.arc === arcId && s.order !== undefined)
				.map(s => s.order as number);
			const order = nextOrder(orders);

			// Placing sets `arc:` and nothing else. It used to also move the file
			// out of `situations/inbox/`, which encoded in the filesystem what the
			// frontmatter already said — and gave one scene two possible homes,
			// which is how one came to exist in both at once.
			const patched = await patchSituation(context.root, id, {arc: arcId, order});
			if ('error' in patched) {
				return {lines: [error(patched.error)]};
			}

			return {
				lines: [
					ok(`placed ${id} on ${arcId} at order ${String(order)}`),
					...adoptionNote(patched),
				],
				dirty: true,
			};
		}

		// A bare id is the reading view: who is in this scene, at what moment, and
		// what each of them has there. It is the form the author reaches for while
		// writing, so it needs no verb — but `show` is accepted, because that is
		// what the other id-namespaced commands call it.
		//
		// Exactly one positional, because `/situation what now` names no scene and
		// looking up the first word of a mistyped line reports the wrong problem.
		const [id] = positional;
		if (
			(verb === undefined || verb === 'show') &&
			id !== undefined &&
			positional.length === 1
		) {
			const lines = renderCast(context.project, id);
			return {lines, paged: lines.length > 14, title: `situation ${id}`};
		}

		return {
			lines: [
				error('usage: /situation <id> [show|edit]'),
				muted(
					'link it:  cast <character>… · place <place> · moment <moment> · arc <arc>',
				),
				muted('/situation new [title] scaffolds one and opens the buffer'),
			],
		};
	},
};

/**
 * Where a key came from, in one phrase.
 *
 * There are four sources now and the difference matters when one of them is
 * stale: "it works on my machine" is usually a literal env var quietly beating
 * the file someone thought they were editing.
 */
function describeKey(resolved: ResolvedKey): string {
	switch (resolved.source) {
		case 'env': {
			return `key from ${resolved.envVar}`;
		}
		case 'file': {
			return `key ${maskKey(resolved.key ?? '')} from ${resolved.path ?? resolved.fileEnvVar}`;
		}
		case 'stored': {
			return `key ${maskKey(resolved.key ?? '')}`;
		}
		case 'missing': {
			return 'no key';
		}
	}
}

const provider: Command = {
	name: 'provider',
	usage: '/provider [status|test|clear]',
	summary: 'choose an LLM provider, key, and model',
	async run(args, context) {
		const [sub] = args;

		if (sub === undefined) {
			// Hands off to the interactive wizard (select → key → test → model).
			return {lines: [], wizard: 'provider'};
		}

		if (sub === 'status') {
			const config = await readConfig(context.root);
			const lines = [heading('providers')];

			for (const spec of PROVIDERS) {
				const resolved = await resolveKey(spec.id);
				const selected = config.provider.id === spec.id;
				lines.push(
					text(
						`${selected ? '●' : ' '} ${spec.label.padEnd(32)} ${describeKey(resolved)}`,
						selected ? {color: '#9ece6a'} : {dim: true},
					),
				);
				// A misconfigured `…_FILE` is reported wherever it is noticed, not
				// only when something later fails because of it.
				if (resolved.problem !== undefined) {
					lines.push(warn(`  ${resolved.problem}`));
				}
			}

			lines.push(
				blank(),
				config.provider.id === undefined
					? muted('no provider selected — run /provider')
					: muted(
							`active: ${config.provider.id} · ${config.provider.model ?? '(no model)'}`,
						),
				muted('keys are stored outside the vault and never written to .litrpg/'),
			);
			return {lines};
		}

		// Re-verifies a key that is already on disk. The wizard tests on entry, but
		// nothing re-tests afterwards, so a revoked or expired key first shows up as
		// an interview dying halfway through a question.
		if (sub === 'test') {
			const config = await readConfig(context.root);
			const named = args[1];
			const id = named ?? config.provider.id;

			if (id === undefined || !PROVIDERS.some(spec => spec.id === id)) {
				return {
					lines: [
						error(
							named === undefined
								? 'no provider selected — /provider test <id>, or /provider to choose one'
								: `usage: /provider test <${PROVIDERS.map(s => s.id).join('|')}>`,
						),
					],
				};
			}

			const spec = findProvider(id as ProviderId);
			const {outcome, resolved} = await verifyStoredKey(id as ProviderId);

			const lines = [
				heading(`provider test — ${spec.label}`),
				muted(`${spec.baseUrl} · ${describeKey(resolved)}`),
			];
			if (resolved.problem !== undefined) {
				lines.push(warn(resolved.problem));
			}

			if (outcome.ok) {
				lines.push(
					ok(`key accepted — ${outcome.models.length} model(s) available`),
					...(outcome.note === undefined ? [] : [muted(outcome.note)]),
				);
			} else {
				lines.push(error(outcome.reason));
				if (outcome.hint !== undefined) {
					lines.push(muted(outcome.hint));
				}
			}
			return {lines};
		}

		if (sub === 'clear') {
			const id = args[1];
			if (!id || !PROVIDERS.some(spec => spec.id === id)) {
				return {
					lines: [
						error(`usage: /provider clear <${PROVIDERS.map(s => s.id).join('|')}>`),
					],
				};
			}
			await forgetKey(id as Parameters<typeof forgetKey>[0]);
			return {
				lines: [ok(`removed the stored key for ${findProvider(id as never).label}`)],
			};
		}

		return {lines: [error('usage: /provider [status|test [id]|clear <id>]')]};
	},
};

/**
 * `/system [<id>]` and `/character <name>` — the views, and only the views.
 *
 * These were the interviews, and their bare form now renders what is there. The
 * interview moved to `/questions <kind>`, which is one verb over every
 * primitive rather than four spellings over four of them, and which opens on
 * what the checks actually found rather than on a fixed brief.
 *
 * A view costs nothing and needs no provider, which is why it stays here rather
 * than being folded in too: an author who wants to see their system should not
 * have to configure a model to look at it.
 */
const system: Command = {
	name: 'system',
	usage: '/system [<id>]',
	summary: 'the rules a character is tracked by',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		// `renderSystem` decides all three cases itself — several systems listed,
		// one rendered in full, a named one that is not there — so this passes the
		// focus straight through rather than reporting the same thing twice.
		const lines = renderSystem(
			context.project,
			args.find(one => one !== 'show'),
		);
		return {lines, paged: lines.length > 14, title: 'system'};
	},
};

const character: Command = {
	name: 'character',
	usage: '/character <name>',
	summary: 'a character as the corpus has them',
	async run(args, context) {
		if (!context.project) {
			return needsProject();
		}

		const focus = args.find(one => one !== 'show');
		if (focus === undefined) {
			return {
				lines: [
					error('usage: /character <name>'),
					muted('/questions character <name> interviews you about one'),
				],
			};
		}

		const lines = renderCharacter(context.project, focus);
		return {lines, paged: lines.length > 14, title: 'character'};
	},
};

/**
 * `/idiom set|unset` — the authorable half of the lexicon.
 *
 * Reported as `before → after` rather than as the raw file change, because the
 * value written is not necessarily the value that renders: unsetting falls back
 * through the `extends` chain, and the author cares about the word they will
 * see, not which layer supplied it.
 */
async function editLexicon(
	root: string,
	action: 'set' | 'unset',
	rest: readonly string[],
): Promise<CommandResult> {
	const [key, ...words] = rest;

	if (key === undefined) {
		return {
			lines: [
				error(`usage: /idiom ${action} <key>${action === 'set' ? ' <term>' : ''}`),
				muted(`keys: ${LEXICON_KEYS.join(', ')}`),
			],
		};
	}
	if (!isLexiconKey(key)) {
		return {
			lines: [
				error(`'${key}' is not a lexicon key`),
				muted(`keys: ${LEXICON_KEYS.join(', ')}`),
			],
		};
	}

	// Joined rather than taken as one token: plenty of display terms are two
	// words ("spell school", "system point"), and quoting in the composer would
	// be a worse ask than accepting the rest of the line.
	const value = words.join(' ').trim();
	if (action === 'set' && value === '') {
		return {lines: [error(`usage: /idiom set ${key} <term>`)]};
	}

	const before = term((await loadSetting(root)).profile, key);
	await writeLexiconTerm(root, key, action === 'set' ? value : undefined);
	const after = await loadSetting(root);

	const lines = [
		ok(`${key}  ${before} → ${term(after.profile, key)}`),
		muted(
			action === 'set'
				? `written to ${VAULT.idiom} · display only, nothing on disk changed`
				: `cleared from ${VAULT.idiom} · now inherited from ${after.profile.chain.join(' → ') || 'base'}`,
		),
	];
	for (const issue of after.issues) {
		lines.push(error(issue));
	}

	return {lines, dirty: true};
}

const idiom: Command = {
	name: 'idiom',
	usage: '/idiom [set <key> <term> | unset <key>]',
	summary: 'show or edit the setting profile and its vocabulary',
	async run(args, context) {
		const [sub, ...rest] = args;

		if (sub === 'set' || sub === 'unset') {
			if (!context.project) {
				return needsProject();
			}
			return editLexicon(context.root, sub, rest);
		}
		if (sub !== undefined) {
			return {lines: [error('usage: /idiom [set <key> <term> | unset <key>]')]};
		}

		const {setting, profile, overridden, issues} = await loadSetting(context.root);

		const lines = [
			heading(`${profile.name}  (${profile.id})`),
			muted(`profile chain: ${profile.chain.join(' → ') || 'base'}`),
		];
		if (overridden) {
			lines.push(muted('system/idiom.md is overriding the shipped profile'));
		}
		for (const issue of issues) {
			lines.push(error(issue));
		}

		lines.push(blank(), muted('setting'));
		lines.push(
			text(
				`  origin      ${setting.system_origin ?? '—'}${
					setting.system_origin ? `  (${ORIGIN_NOTE[setting.system_origin]})` : ''
				}`,
			),
			text(
				`  visibility  ${setting.system_visibility ?? '—'}${
					setting.system_visibility
						? `  (${VISIBILITY_NOTE[setting.system_visibility]})`
						: ''
				}`,
			),
			text(
				`  agency      ${setting.system_agency ?? '—'}${
					setting.system_agency ? `  (${AGENCY_NOTE[setting.system_agency]})` : ''
				}`,
			),
		);

		// §9 risk mitigation: canonical keys stay visible so the indirection is
		// debuggable rather than mysterious.
		lines.push(blank(), muted('lexicon  (canonical → displayed)'));
		for (const pair of lexiconPairs(profile)) {
			lines.push(
				text(
					`  ${pair.key.padEnd(16)} ${pair.display}`,
					pair.explicit ? {} : {dim: true},
				),
			);
		}

		lines.push(
			blank(),
			muted('display only — canonical keys are what live on disk'),
			muted(`status template: ${profile.status_template}`),
			muted('/idiom set <key> <term> to override · /idiom unset <key> to revert'),
		);
		return {lines, paged: lines.length > 14, title: 'idiom'};
	},
};

const project: Command = {
	name: 'project',
	usage: '/project [path]',
	summary: 'switch vaults, or list recent ones',
	async run(args, context) {
		const requested = args.join(' ').trim();

		if (requested === '') {
			const recent = await readLiveRecent();
			const last = await readLastProject();
			// Marked, so it is clear which one a bare `litfire` will reopen.
			const note = (root: string, state: string) =>
				[
					state === 'empty' ? '(not a vault yet)' : '',
					last !== undefined && path.resolve(last) === path.resolve(root)
						? '(opens by default)'
						: '',
				]
					.filter(Boolean)
					.join(' ');

			const here = note(context.root, 'vault');
			const lines = [
				heading('projects'),
				text(`● ${displayPath(context.root)}${here === '' ? '' : `  ${here}`}`, {
					color: '#9ece6a',
				}),
			];

			const others = recent.filter(
				entry => path.resolve(entry.root) !== path.resolve(context.root),
			);
			for (const entry of others) {
				const suffix = note(entry.root, entry.state);
				lines.push(
					text(`  ${displayPath(entry.root)}${suffix === '' ? '' : `  ${suffix}`}`, {
						dim: true,
					}),
				);
			}
			if (others.length === 0) {
				lines.push(muted('  no other projects yet'));
			}

			lines.push(
				blank(),
				muted('/project <path> to switch · ~ and relative paths work'),
				muted('litfire reopens the default · litfire . opens the current directory'),
			);
			return {lines, paged: lines.length > 14, title: 'projects'};
		}

		const target = resolveProjectPath(context.root, requested);
		const state = await inspectProject(target);

		if (state === 'missing') {
			return {
				lines: [
					error(`${displayPath(target)} does not exist`),
					muted(`create it with /init <idiom> ${requested}`),
				],
			};
		}
		if (state === 'not-a-directory') {
			return {lines: [error(`${displayPath(target)} is a file, not a directory`)]};
		}
		if (path.resolve(target) === path.resolve(context.root)) {
			return {lines: [muted(`already in ${displayPath(target)}`)]};
		}

		const lines = [ok(`switched to ${displayPath(target)}`)];
		// Switching to an empty directory is how a new book starts, so it is
		// allowed — with a pointer at the next step rather than a refusal.
		if (state === 'empty') {
			lines.push(muted('not a vault yet — /init <idiom> to scaffold one here'));
		}

		return {lines, switchProject: target};
	},
};

const quit: Command = {
	name: 'quit',
	usage: '/quit',
	summary: 'exit',
	async run() {
		return {lines: [], exit: true};
	},
};

export const commands: readonly Command[] = [
	help,
	init,
	consent,
	sheet,
	status,
	pacing,
	chapter,
	exportManuscript,
	wiki,
	reviewer,
	curator,
	primitives,
	timeline,
	themes,
	lint,
	questions,
	arc,
	ingest,
	moment,
	place,
	time,
	situation,
	provider,
	project,
	idiom,
	system,
	character,
	quit,
];

export function findCommand(name: string): Command | undefined {
	return commands.find(command => command.name === name);
}
