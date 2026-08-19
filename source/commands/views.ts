import {findSeams, partitionChapters, type Seam} from '../chapters/index.js';
import type {Project} from '../core/project.js';
import type {OrphanedInterview} from '../interview/index.js';
import type {LedgerState} from '../ledger/replay.js';
import {
	compareInstants,
	describeDuration,
	grouped,
	MAX_INSTANT,
	type Instant,
} from '../time/instant.js';
import type {Calendar} from '../time/calendar.js';
import {
	allStates,
	castOf,
	momentByStep,
	type CharacterStateView,
} from '../ledger/state.js';
import {
	blank,
	columns,
	error,
	heading,
	muted,
	ok,
	text,
	warn,
	type Line,
} from './types.js';

/** "1 stat" / "3 stats" — the same shape the wiki uses, kept local to avoid a
 * dependency from the command layer on the wiki builder. */
function plural(count: number, word: string, suffix = 's'): string {
	return `${String(count)} ${word}${count === 1 ? '' : suffix}`;
}

/** Character sheet at a point in the sequence (§10 `/sheet`). */
export function renderSheet(
	project: Project,
	characterId: string,
	at: string | undefined,
): Line[] {
	const state: LedgerState | undefined =
		at === undefined ? project.replay.state : project.replay.snapshots.get(at);

	if (at !== undefined && state === undefined) {
		return [error(`no step '${at}' in the replay sequence`)];
	}

	const character = state?.characters[characterId];
	if (!character) {
		return [error(`no character '${characterId}' in the ledger`)];
	}

	const lines: Line[] = [
		heading(`${characterId}${at ? `  @ ${at}` : ''}`),
		text(`level ${character.level}    xp ${character.xp}`),
		blank(),
	];

	const stats = Object.entries(character.stats).toSorted(([a], [b]) =>
		a.localeCompare(b),
	);
	if (stats.length > 0) {
		lines.push(muted('stats'));
		for (const row of columns(stats.map(([id, value]) => [`  ${id}`, String(value)]))) {
			lines.push(text(row));
		}
		lines.push(blank());
	}

	lines.push(
		muted('skills'),
		character.skills.length > 0
			? text(`  ${character.skills.join(', ')}`)
			: muted('  (none)'),
	);

	const items = Object.entries(character.items).filter(([, qty]) => qty > 0);
	if (items.length > 0) {
		lines.push(blank(), muted('items'));
		for (const [id, qty] of items) {
			lines.push(text(`  ${id} ×${qty}`));
		}
	}

	if (project.formulasSkipped) {
		lines.push(
			blank(),
			muted('formulas not evaluated — run /consent to enable the curve'),
		);
	}

	return lines;
}

/**
 * Every primitive in the vault that has an id, grouped by kind.
 *
 * The id is the column that matters: it is the filename stem, the wikilink
 * target, and what every cross-reference in frontmatter names. Wanting to see
 * them all at once is wanting to know what you are allowed to point at.
 *
 * `places` arrives separately because it is the one kind with no schema — free
 * prose in a directory, never loaded into `Project` — so the caller reads the
 * directory and passes what it found.
 */
export function renderPrimitives(
	project: Project,
	places: readonly string[],
	focus?: string,
): Line[] {
	const {vault} = project;
	const under = (systemId: string) =>
		Object.values(project.replay.state.characters).filter(
			character => character.system === systemId,
		).length;

	const groups: readonly {
		readonly kind: string;
		readonly rows: readonly (readonly [string, string, string])[];
		/** Shown only when named by `focus` — see the `state` group. */
		readonly onDemand?: boolean;
	}[] = [
		{
			kind: 'system',
			rows: vault.systems.map(
				system =>
					[
						system.id,
						system.name ?? '',
						`${plural(system.stats.length, 'stat')} · ${plural(under(system.id), 'character')}`,
					] as const,
			),
		},
		{
			kind: 'character',
			// The *resolved* system, not the declared one. A vault with a single
			// system resolves every character into it without anyone writing it
			// down, and reporting "(no system)" beside a system claiming two
			// characters is the view disagreeing with itself.
			rows: vault.characters.map(character => {
				const resolved = project.replay.state.characters[character.id]?.system;
				const note =
					resolved === undefined
						? '(no system)'
						: character.system === undefined
							? `${resolved} (inferred)`
							: resolved;
				return [character.id, character.name ?? '', note] as const;
			}),
		},
		{
			kind: 'moment',
			rows: vault.moments
				.toSorted(
					(a, b) =>
						// Undated sorts last: a moment recorded but not placed has no
						// position, and inventing one would state the sequence wrongly.
						compareInstants(a.at ?? MAX_INSTANT, b.at ?? MAX_INSTANT) ||
						a.id.localeCompare(b.id),
				)
				.map(
					moment =>
						[
							moment.id,
							moment.name ?? '',
							moment.at === undefined ? 'undated' : `at ${grouped(moment.at)}`,
						] as const,
				),
		},
		{
			kind: 'arc',
			rows: vault.arcs.map(
				arc =>
					[
						arc.id,
						arc.name ?? '',
						arc.order === undefined ? 'unplaced' : `order ${String(arc.order)}`,
					] as const,
			),
		},
		{
			kind: 'situation',
			rows: vault.situations.map(
				situation =>
					[situation.id, situation.title ?? '', situation.arc ?? '(unplaced)'] as const,
			),
		},
		{
			kind: 'state',
			// Derived, and the only combinatorial kind here: one row per character
			// per moment. Listed on request rather than by default, because at
			// novel scale it is larger than every other kind put together and would
			// bury them.
			onDemand: true,
			rows: allStates(project.replay, vault.situations).map(
				state =>
					[
						state.id,
						`L${String(state.level)}`,
						`${state.system ?? '(no system)'} · ${plural(state.artifacts.length, 'artifact')}`,
					] as const,
			),
		},
		{
			kind: 'faction',
			rows: vault.factions.map(
				faction =>
					[
						faction.id,
						faction.name ?? '',
						faction.goal === undefined
							? 'no goal'
							: plural(faction.members.length, 'member'),
					] as const,
			),
		},
		{
			kind: 'artifact',
			rows: vault.artifacts.map(
				artifact =>
					[
						artifact.id,
						artifact.name ?? '',
						artifact.outcome === undefined ? 'no outcome' : (artifact.kind ?? 'artifact'),
					] as const,
			),
		},
		{
			kind: 'theme',
			rows: vault.themes.map(
				theme =>
					[
						theme.id,
						theme.name ?? '',
						plural(theme.subthemes.length, 'subtheme'),
					] as const,
			),
		},
		{
			kind: 'chapter',
			rows: vault.chapters.map(
				chapter =>
					[chapter.id, chapter.title ?? '', `opens at ${chapter.starts_at}`] as const,
			),
		},
		{
			kind: 'place',
			// No schema, so nothing but the stem is known without reading the file.
			rows: places.map(id => [id, '', 'free-form'] as const),
		},
	];

	const shown =
		focus === undefined
			? groups.filter(group => group.onDemand !== true)
			: groups.filter(group => group.kind === focus || `${group.kind}s` === focus);

	if (shown.length === 0) {
		return [
			heading('primitives'),
			error(`no kind '${focus ?? ''}' — try ${groups.map(g => g.kind).join(', ')}`),
		];
	}

	const total = shown.reduce((sum, group) => sum + group.rows.length, 0);
	const lines: Line[] = [
		heading('primitives'),
		muted(
			`${plural(total, 'id')} across ${plural(shown.filter(g => g.rows.length > 0).length, 'kind')}`,
		),
	];

	for (const group of shown) {
		if (group.rows.length === 0) {
			continue;
		}
		lines.push(blank(), muted(`${group.kind} (${String(group.rows.length)})`));
		for (const row of columns(
			group.rows.map(([id, name, note]) => [`  ${id}`, name, note]),
		)) {
			lines.push(text(row));
		}
	}

	if (total === 0) {
		lines.push(blank(), muted('nothing with an id yet — /system or /character to start'));
	}

	for (const group of groups) {
		if (group.onDemand === true && focus === undefined && group.rows.length > 0) {
			lines.push(
				blank(),
				muted(
					`${plural(group.rows.length, `${group.kind} id`)} not listed — /primitives ${group.kind}`,
				),
			);
		}
	}

	return lines;
}

/**
 * One situation as the character states standing in it (§6.1).
 *
 * The cast shares a moment and agrees on nothing else, so the stats and
 * artifacts are laid out per character rather than merged: what makes a scene
 * writable is seeing that one of them has the artifact and the other does not.
 */
export function renderCast(project: Project, situationId: string): Line[] {
	const situation = project.vault.situations.find(
		candidate => candidate.id === situationId,
	);
	if (situation === undefined) {
		return [error(`no situation '${situationId}'`)];
	}

	const clock = momentByStep(project.replay.sequence, project.vault.situations);
	const cast = castOf(project.replay, clock, situation);
	const moment = project.vault.moments.find(candidate => candidate.id === cast.moment);

	const lines: Line[] = [
		heading(`${situation.id}${situation.title ? ` — ${situation.title}` : ''}`),
	];

	if (cast.moment === undefined) {
		lines.push(
			warn('unplaced — no moment on the clock precedes this scene'),
			muted(
				situation.arc === undefined
					? '/situation <id> moment <moment> anchors it on the clock'
					: 'set moment: in its frontmatter, or date a moment before it',
			),
		);
	} else {
		const when = moment?.at === undefined ? 'undated' : `at ${String(moment.at)}`;
		lines.push(
			muted(
				`moment ${cast.moment}${moment?.name ? ` — ${moment.name}` : ''} · ${when} · ${
					cast.anchored ? 'anchored' : 'inherited'
				}`,
			),
		);
	}

	if (situation.place !== undefined) {
		lines.push(muted(`place ${situation.place}`));
	}

	if (cast.states.length === 0) {
		lines.push(blank(), muted('nobody in this scene has a state yet'));
	}

	for (const state of cast.states) {
		lines.push(blank(), text(state.id), ...stateRows(state));
	}

	if (cast.missing.length > 0) {
		lines.push(
			blank(),
			warn(`no state at this point: ${cast.missing.join(', ')}`),
			muted('they are in the cast but the ledger has not reached them'),
		);
	}

	return lines;
}

/** The body of one character state — indented, shared by every state view. */
function stateRows(state: CharacterStateView): Line[] {
	const stats = Object.entries(state.stats).toSorted(([a], [b]) => a.localeCompare(b));
	const lines: Line[] = [
		muted(
			`  ${state.system ?? '(no system)'} · level ${String(state.level)} · xp ${String(state.xp)}`,
		),
	];

	if (stats.length > 0) {
		for (const row of columns(stats.map(([id, value]) => [`  ${id}`, String(value)]))) {
			lines.push(text(row));
		}
	}

	lines.push(
		text(
			`  artifacts: ${state.artifacts.length > 0 ? state.artifacts.join(', ') : '(none)'}`,
		),
	);
	if (state.skills.length > 0) {
		lines.push(text(`  skills: ${state.skills.join(', ')}`));
	}

	return lines;
}

/** Planned vs actual level by arc (§10 `/pacing`, DoD 8). */
export function renderPacing(project: Project): Line[] {
	const lines: Line[] = [heading('pacing — planned vs actual')];
	// Same ordering as `buildSequence`: an unordered arc replays last, so it
	// reads last here rather than being sorted by NaN.
	const arcs = project.vault.arcs.toSorted(
		(a, b) =>
			(a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
			a.id.localeCompare(b.id),
	);

	if (arcs.length === 0) {
		return [...lines, muted('no arcs defined — run /timeline')];
	}

	const rows: string[][] = [['arc', 'character', 'planned', 'actual', '']];

	for (const arc of arcs) {
		const lastStep = project.replay.sequence
			.toReversed()
			.find(step => step.kind === 'situation' && step.arc === arc.id);
		const state = lastStep ? project.replay.snapshots.get(lastStep.id) : undefined;

		const entries = Object.entries(arc.milestone);
		if (entries.length === 0) {
			rows.push([arc.id, '—', '—', '—', 'no milestone']);
			continue;
		}

		for (const [characterId, milestone] of entries) {
			const actual = state?.characters[characterId];
			const planned = milestone.level === undefined ? '—' : `L${milestone.level}`;
			const got = actual ? `L${actual.level}` : '—';
			const drift =
				milestone.level !== undefined && actual && actual.level !== milestone.level
					? actual.level < milestone.level
						? 'behind'
						: 'ahead'
					: 'on track';
			rows.push([arc.id, characterId, planned, got, drift]);
		}
	}

	for (const [index, row] of columns(rows).entries()) {
		lines.push(index === 0 ? muted(row) : text(row));
	}

	return lines;
}

/** Structural view of the timeline (§10 `/timeline` with no args). */
export function renderTimeline(project: Project): Line[] {
	const lines: Line[] = [heading('timeline')];
	const {moments, arcs, situations} = project.vault;

	if (moments.length === 0 && arcs.length === 0) {
		return [...lines, muted('nothing on the timeline yet')];
	}

	for (const step of project.replay.sequence) {
		if (step.kind === 'moment') {
			const event = moments.find(w => w.id === step.id);
			lines.push(text(`◆ ${step.id}  ${event?.name ?? ''}`, {color: '#bb9af7'}));
		} else {
			const situation = situations.find(s => s.id === step.id);
			lines.push(muted(`    ${step.id}  ${situation?.title ?? ''}`));
		}
	}

	const unplaced = situations.filter(s => s.arc === undefined);
	if (unplaced.length > 0) {
		lines.push(
			blank(),
			muted(`inbox — ${unplaced.length} unplaced (contributes nothing to the ledger)`),
		);
		for (const situation of unplaced) {
			lines.push(muted(`    ${situation.id}  ${situation.title ?? ''}`));
		}
	}

	return lines;
}

/** Leaf-level coverage with upward rollup (§8, DoD 10). */
export function renderThemes(project: Project): Line[] {
	const lines: Line[] = [heading('theme coverage')];
	const {pillars, untagged} = project.coverage;

	if (pillars.length === 0) {
		return [...lines, muted('no themes defined')];
	}

	for (const pillar of pillars) {
		lines.push(text(`${pillar.name}  (${pillar.count})`, {bold: true}));
		const rows = pillar.subthemes.map(sub => [
			`  ${sub.id}`,
			String(sub.count),
			sub.starved ? `quiet for ${sub.sinceLastTouch}` : '',
		]);
		for (const [index, row] of columns(rows).entries()) {
			const sub = pillar.subthemes[index];
			lines.push(sub?.starved ? text(row, {color: '#e0af68'}) : text(row));
		}
		lines.push(blank());
	}

	if (untagged.length > 0) {
		lines.push(error(`tagged but undefined: ${untagged.join(', ')}`));
	}

	lines.push(
		muted('coverage is informational — it never blocks and never opens a question'),
	);
	return lines;
}

/** The open question queue (§7, §10 `/questions`). */
export function renderQuestions(project: Project): Line[] {
	const open = project.questions.filter(question => question.status === 'open');
	if (open.length === 0) {
		return [ok('no open questions')];
	}

	const lines: Line[] = [heading(`open questions (${open.length})`)];
	for (const question of open) {
		lines.push(
			text(`${question.id}  ${question.kind}`, {color: '#e0af68'}),
			muted(`         ${question.detail}`),
			muted(`         at ${question.where}`),
		);
	}
	lines.push(blank(), muted('nothing here blocks writing (P4)'));
	return lines;
}

export function renderLint(
	project: Project,
	orphans: readonly OrphanedInterview[] = [],
): Line[] {
	const lines: Line[] = [heading('lint — deterministic checks')];

	// First, not last. This is the only finding here about work that is missing
	// from the corpus rather than present in it, and tall output goes to a pager
	// — at the bottom the author would never scroll to it.
	if (orphans.length > 0) {
		lines.push(heading('interviews that produced nothing'));
		for (const orphan of orphans) {
			const subject =
				orphan.focus === undefined ? orphan.kind : `${orphan.kind} ${orphan.focus}`;
			lines.push(
				text(
					`  ${subject} — ${orphan.exchanges} exchange${orphan.exchanges === 1 ? '' : 's'} saved, but ${orphan.detail}`,
					{color: '#e0af68'},
				),
				muted(
					`    /${orphan.kind}${orphan.focus === undefined ? '' : ` ${orphan.focus}`} extract to re-run extraction`,
				),
			);
		}
		lines.push(blank());
	}

	const byKind = new Map<string, number>();
	for (const question of project.questions) {
		byKind.set(question.kind, (byKind.get(question.kind) ?? 0) + 1);
	}

	if (project.vault.issues.length > 0) {
		lines.push(error(`${project.vault.issues.length} file(s) failed to parse`));
		for (const issue of project.vault.issues) {
			lines.push(muted(`  ${issue.file}: ${issue.message.split('\n')[0] ?? ''}`));
		}
		lines.push(blank());
	}

	if (byKind.size === 0) {
		lines.push(ok('no findings'));
	} else {
		for (const row of columns(
			[...byKind].map(([kind, count]) => [`  ${kind}`, String(count)]),
		)) {
			lines.push(text(row));
		}
		lines.push(blank(), muted('run /questions for detail'));
	}

	if (project.formulasSkipped) {
		lines.push(blank(), muted('formulas present but not evaluated — /consent to enable'));
	}
	lines.push(muted('deterministic checks only — the LLM lint pass is not built yet'));

	return lines;
}

/**
 * What the System currently is (§10).
 *
 * `/system` starts an interview, which left an author no way to see what that
 * interview actually produced. This is that view.
 */
export function renderSystem(project: Project, focus?: string): Line[] {
	const {systems, formulas} = project.vault;

	// Several systems are listed rather than merged: a stat named in two of them
	// is two different stats, and flattening them would say otherwise.
	if (focus === undefined && systems.length > 1) {
		const lines: Line[] = [heading('systems')];
		lines.push(muted(`${systems.length} character systems`), blank());
		for (const each of systems) {
			const under = Object.values(project.replay.state.characters).filter(
				character => character.system === each.id,
			).length;
			lines.push(
				text(`  ${each.id}`, {color: '#9ece6a'}),
				muted(
					`    ${each.name ?? '(unnamed)'} · ${each.stats.length} stat(s) · ${each.skills.length} skill(s) · ${under} character(s)`,
				),
			);
		}
		lines.push(blank(), muted('/system <id> for one in full'));
		return lines;
	}

	const system =
		focus === undefined ? systems[0] : systems.find(each => each.id === focus);
	if (system === undefined) {
		return [heading('system'), error(`no system '${focus ?? ''}' in this vault`)];
	}

	const lines: Line[] = [
		heading(`system — ${system.name ?? system.id}`),
		...(system.name === undefined
			? [warn(`${system.id} has no name — add \`name:\` to its page`)]
			: []),
	];

	if (system.stats.length === 0 && system.skills.length === 0) {
		return [
			...lines,
			muted('nothing defined yet'),
			muted('/system to talk it through · /lint if you already did'),
		];
	}

	if (system.stats.length > 0) {
		lines.push(muted(`stats (${system.stats.length})`));
		const rows = system.stats.map(stat => [
			`  ${stat.id}`,
			stat.name ?? '',
			`default ${stat.default}`,
			stat.min === undefined ? '' : `min ${stat.min}`,
			stat.max === undefined ? '' : `max ${stat.max}`,
		]);
		for (const row of columns(rows)) {
			lines.push(text(row));
		}
		lines.push(blank());
	}

	if (system.skills.length > 0) {
		lines.push(muted(`skills (${system.skills.length})`));
		for (const skill of system.skills) {
			const requires =
				skill.requires_skills.length > 0
					? `  requires ${skill.requires_skills.join(', ')}`
					: '';
			lines.push(text(`  ${skill.id}${requires}`));
		}
		lines.push(blank());
	}

	const known = new Set(formulas.map(formula => formula.id));
	const curve = system.curves.xp_for_level;
	lines.push(muted('curves'));
	lines.push(
		text(`  xp_for_level  ${curve ?? '—'}`),
		text(`  max_level     ${system.curves.max_level ?? '—'}`),
	);
	// A curve naming a formula nobody defined is the quiet kind of broken: the
	// schema is satisfied and the arithmetic silently never runs.
	if (curve !== undefined && !known.has(curve)) {
		lines.push(error(`  no formula '${curve}' is defined`));
	}

	if (formulas.length > 0) {
		lines.push(blank(), muted(`formulas: ${formulas.map(f => f.id).join(', ')}`));
	}

	lines.push(
		blank(),
		muted('/idiom for the setting descriptors · /wiki for the full page'),
	);
	return lines;
}

const SEAM_NOTE: Readonly<Record<Seam['kind'], string>> = {
	chapter: 'a chapter opens here',
	arc: 'the arc changes',
	elapsed: 'time passes between them',
	place: 'the scene relocates',
	cast: 'who is present changes',
};

/**
 * Chapter structure (§6 step 6).
 *
 * Membership is computed from the replay sequence on every render rather than
 * read from a manifest, so this view and the manuscript can never disagree
 * about which scene belongs where.
 */
export function renderChapters(project: Project): Line[] {
	const {chapters, situations} = project.vault;
	const lines: Line[] = [heading('chapters')];

	if (chapters.length === 0) {
		return [
			...lines,
			muted('no chapters yet'),
			muted('/chapter new <title> at <situation> cuts the sequence into one'),
		];
	}

	const partition = partitionChapters(chapters, project.replay.sequence);
	const seams = findSeams(project.replay.sequence, situations, chapters);
	const titleOf = new Map(situations.map(s => [s.id, s.title ?? '']));

	const rows = partition.spans.map(span => [
		`  ${span.chapter.id}`,
		span.chapter.title ?? '',
		`${span.situations.length} scene${span.situations.length === 1 ? '' : 's'}`,
		span.situations.length === 0
			? ''
			: `${span.situations[0]} → ${span.situations.at(-1)}`,
	]);
	for (const row of columns(rows)) {
		lines.push(text(row));
	}

	// P4: a broken chapter set is reported, never blocking. The author can keep
	// writing with two chapters starting on the same scene.
	if (partition.issues.length > 0) {
		lines.push(blank());
		for (const issue of partition.issues) {
			lines.push(error(`${issue.chapter}: ${issue.detail}`));
		}
	}

	const unclaimed = partition.unclaimed.filter(step => step.kind === 'situation');
	if (unclaimed.length > 0) {
		lines.push(
			blank(),
			text(`${unclaimed.length} scene(s) before the first chapter opens`, {
				color: '#e0af68',
			}),
		);
		for (const step of unclaimed) {
			lines.push(muted(`    ${step.id}  ${titleOf.get(step.id) ?? ''}`));
		}
	}

	if (seams.length > 0) {
		const byKind = new Map<string, number>();
		for (const seam of seams) {
			byKind.set(seam.kind, (byKind.get(seam.kind) ?? 0) + 1);
		}
		lines.push(
			blank(),
			muted(
				`seams: ${[...byKind]
					.toSorted(([a], [b]) => a.localeCompare(b))
					.map(([kind, count]) => `${count} ${kind}`)
					.join(' · ')}`,
			),
			muted('/chapter <id> to see them in place'),
		);
	}

	return lines;
}

/** One chapter's scenes with the seams between them (§6 step 6 "reconcile"). */
export function renderChapter(project: Project, chapterId: string): Line[] {
	const {chapters, situations} = project.vault;
	const partition = partitionChapters(chapters, project.replay.sequence);
	const span = partition.spans.find(candidate => candidate.chapter.id === chapterId);

	if (!span) {
		const known = chapters.some(chapter => chapter.id === chapterId);
		return [
			error(`no chapter '${chapterId}'`),
			...(known ? [muted('it exists but claims no scenes — /chapters for why')] : []),
		];
	}

	const titleOf = new Map(situations.map(s => [s.id, s.title ?? '']));
	const seams = findSeams(project.replay.sequence, situations, chapters);
	const lines: Line[] = [
		heading(`${span.chapter.id}  ${span.chapter.title ?? ''}`),
		muted(`opens on ${span.chapter.starts_at}`),
		blank(),
	];

	for (const [index, id] of span.situations.entries()) {
		lines.push(text(`  ${id}  ${titleOf.get(id) ?? ''}`));

		// Seams are printed between the two scenes they sit between, so a gap in
		// the draft reads as a gap on the page rather than as a list elsewhere.
		const next = span.situations[index + 1];
		if (next !== undefined) {
			for (const seam of seams.filter(s => s.from === id && s.to === next)) {
				lines.push(
					text(`      ⌇ ${SEAM_NOTE[seam.kind]} — ${seam.detail}`, {color: '#e0af68'}),
				);
			}
		}
	}

	return lines;
}

/**
 * One character as the corpus holds them, next to what the ledger replayed.
 *
 * The companion to `/system show`: it answers "did my `/character` interview
 * land" without needing the character to appear in a single situation yet.
 * `/sheet` is the point-in-time view; this is the record.
 */
export function renderCharacter(project: Project, id: string): Line[] {
	const character = project.vault.characters.find(candidate => candidate.id === id);
	if (!character) {
		return [
			error(`no characters/${id}.md`),
			muted(`/character ${id} to interview for one · /lint if you already did`),
		];
	}

	const lines: Line[] = [
		heading(
			`${character.id}${character.name === undefined ? '' : `  ${character.name}`}`,
		),
		text(`level ${character.level}    xp ${character.xp}`),
	];

	const stats = Object.entries(character.stats).toSorted(([a], [b]) =>
		a.localeCompare(b),
	);
	if (stats.length > 0) {
		lines.push(blank(), muted('declared stats'));
		for (const row of columns(stats.map(([key, value]) => [`  ${key}`, String(value)]))) {
			lines.push(text(row));
		}
	}

	lines.push(
		blank(),
		muted('declared skills'),
		character.skills.length > 0
			? text(`  ${character.skills.join(', ')}`)
			: muted('  (none)'),
	);

	const appearances = project.vault.situations.filter(situation =>
		situation.characters.includes(id),
	);
	lines.push(blank());
	if (appearances.length === 0) {
		// Not an error — a character can exist long before their first scene — but
		// it is the difference between "written down" and "in the story".
		lines.push(muted('appears in no situation yet'));
	} else {
		lines.push(muted(`appears in ${appearances.length} situation(s)`));
		for (const situation of appearances.slice(0, 8)) {
			lines.push(muted(`    ${situation.id}  ${situation.title ?? ''}`));
		}
		if (appearances.length > 8) {
			lines.push(muted(`    … and ${appearances.length - 8} more`));
		}
	}

	const replayed = project.replay.state.characters[id];
	lines.push(
		blank(),
		replayed === undefined
			? muted('not in the ledger — no situation has given them an event')
			: muted(
					`ledger: level ${replayed.level}, xp ${replayed.xp} · /sheet ${id} for detail`,
				),
	);

	return lines;
}

/**
 * Every arc, in replay order — the spine situations are placed onto.
 *
 * An arc with no order sorts last rather than being hidden, the same way
 * `buildSequence` replays it last: an unordered arc is a normal in-progress
 * state, and a list that omitted it would be lying about what exists.
 */
export function renderArcs(project: Project): Line[] {
	const {arcs, situations} = project.vault;

	if (arcs.length === 0) {
		return [
			heading('arcs'),
			muted('none yet — /arc new <title> creates one'),
			muted('a situation cannot be placed until an arc exists'),
		];
	}

	const ordered = arcs.toSorted(
		(a, b) =>
			(a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
			a.id.localeCompare(b.id),
	);

	const rows = ordered.map(arc => {
		const held = situations.filter(situation => situation.arc === arc.id).length;
		return [
			`  ${arc.id}`,
			arc.name ?? '',
			arc.order === undefined ? 'unplaced' : `order ${String(arc.order)}`,
			arc.starts_after === undefined ? 'unanchored' : `after ${arc.starts_after}`,
			plural(held, 'situation'),
		];
	});

	return [
		heading('arcs'),
		muted(`${plural(arcs.length, 'arc')} · ${plural(situations.length, 'situation')}`),
		blank(),
		...columns(rows).map(row => text(row)),
	];
}

/** One arc: where it sits, what it holds, and what it intends. */
export function renderArc(project: Project, arcId: string): Line[] {
	const arc = project.vault.arcs.find(candidate => candidate.id === arcId);
	if (arc === undefined) {
		return [
			error(`no arc '${arcId}'`),
			muted('/arc lists them · /arc new <title> creates one'),
		];
	}

	const held = project.vault.situations
		.filter(situation => situation.arc === arc.id)
		.toSorted(
			(a, b) =>
				(a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
				a.id.localeCompare(b.id),
		);

	const lines: Line[] = [
		heading(`${arc.id}${arc.name ? ` — ${arc.name}` : ''}`),
		muted(
			[
				arc.order === undefined ? 'unplaced' : `order ${String(arc.order)}`,
				arc.starts_after === undefined
					? 'not anchored to the clock'
					: `starts after ${arc.starts_after}`,
			].join(' · '),
		),
	];

	// Said plainly, because an unanchored arc is why its situations report no
	// moment — and that is not obvious from looking at the situations.
	if (arc.starts_after === undefined) {
		lines.push(muted(`/arc ${arc.id} after <moment> gives its scenes a clock position`));
	}

	lines.push(blank(), muted('situations'));
	if (held.length === 0) {
		lines.push(muted('  (none)'), muted(`  /situation <id> arc ${arc.id} places one`));
	} else {
		for (const situation of held) {
			const order = situation.order === undefined ? '—' : String(situation.order);
			lines.push(
				text(
					`  ${order.padStart(3)}  ${situation.id}${situation.title ? ` — ${situation.title}` : ''}`,
				),
			);
		}
	}

	const milestones = Object.entries(arc.milestone);
	if (milestones.length > 0) {
		lines.push(blank(), muted('milestone — intended power at the end of this arc'));
		for (const [characterId, milestone] of milestones) {
			const level = milestone.level === undefined ? '—' : `L${String(milestone.level)}`;
			lines.push(text(`  ${characterId}  ${level}`));
		}
		lines.push(muted('/pacing compares this against replay'));
	}

	return lines;
}

/**
 * `/time` — how this vault reads its clock, and what that makes of the moments.
 *
 * The origin is second zero by definition; a binding only decides what second
 * zero is *called*. Showing both the raw seconds and the calendar's reading
 * side by side is what makes a wrong epoch obvious — a date that is out by a
 * century looks fine on its own and wrong the moment it sits next to the
 * number it came from.
 */
export function renderTime(project: Project, calendar: Calendar, note?: string): Line[] {
	const {time, moments} = project.vault;
	const dated = moments
		.filter((moment): moment is typeof moment & {at: Instant} => moment.at !== undefined)
		.toSorted((a, b) => compareInstants(a.at, b.at));

	const lines: Line[] = [
		heading('time'),
		text(`calendar   ${calendar.name}`),
		text(`origin     ${time?.origin ?? '(unnamed) — second zero'}`),
	];

	if (time?.calendar === 'gregorian') {
		lines.push(
			text(`epoch      ${time.epoch ?? '(none)'}`),
			text(`timezone   ${time.timezone}`),
		);
	}

	if (note !== undefined) {
		lines.push(blank(), warn(note));
	}

	lines.push(
		blank(),
		muted(`${plural(dated.length, 'dated moment')} of ${String(moments.length)}`),
	);

	if (dated.length === 0) {
		lines.push(muted('nothing on the clock yet — /timeline interview'));
		return lines;
	}

	lines.push(blank());
	const rows = dated.map(moment => [
		`  ${moment.id}`,
		grouped(moment.at),
		calendar.format(moment.at),
		describeDuration(moment.at),
	]);
	for (const row of columns([
		['  moment', 'seconds', 'reads as', 'from origin'],
		...rows,
	])) {
		lines.push(text(row));
	}

	const undated = moments.length - dated.length;
	if (undated > 0) {
		lines.push(
			blank(),
			muted(`${plural(undated, 'moment')} undated — recorded, but not on the clock`),
		);
	}

	return lines;
}
