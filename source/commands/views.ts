import {findSeams, partitionChapters, type Seam} from '../chapters/index.js';
import type {Project} from '../core/project.js';
import type {Situation} from '../domain/schema.js';
import type {OrphanedInterview} from '../interview/index.js';
import type {LedgerState} from '../ledger/replay.js';
import {
	compareInstants,
	describeDuration,
	grouped,
	MAX_INSTANT,
	type Instant,
} from '../time/instant.js';
import type {ResolvedProfile} from '../genre/types.js';
import {formatStat} from '../system/interface.js';
import {renderStatusBlock} from '../system/status.js';
import {isTimeZone, type Calendar} from '../time/calendar.js';
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
		for (const row of columns(
			stats.map(([id, value]) => [`  ${id}`, formatStat(value)]),
		)) {
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
 * Places used to arrive separately, read off the directory by the caller,
 * because they were the one kind with no schema. They have one now, so they
 * come from the vault like everything else — and from situations too, since a
 * scene can name somewhere nobody has written up yet.
 */
export function renderPrimitives(project: Project, focus?: string): Line[] {
	const {vault} = project;
	const places = [
		...new Set([
			...vault.places.map(place => place.id),
			...vault.situations.map(s => s.place).filter((p): p is string => p !== undefined),
		]),
	].toSorted();
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
			kind: 'skill',
			rows: vault.skills.map(skill => {
				const granted = skill.system ?? '(every system)';
				return [
					skill.id,
					skill.name ?? '',
					skill.requires_skills.length > 0
						? `${granted} · after ${skill.requires_skills.join(', ')}`
						: granted,
				] as const;
			}),
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
			// Both directions, as `/place` lists them: a page with no scene and a
			// scene with no page are each half-finished, differently.
			rows: places.map(id => {
				const written = vault.places.find(candidate => candidate.id === id);
				const scenes = vault.situations.filter(s => s.place === id).length;
				return [
					id,
					written?.name ?? '',
					written === undefined ? 'no page yet' : plural(scenes, 'scene'),
				] as const;
			}),
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
/**
 * Every character in a scene, as their own system draws them.
 *
 * This is what the interface is for. `/sheet` answers "what does the ledger
 * hold about this person", which is a question about a character; this answers
 * "what would each of them see on their screen, standing here", which is a
 * question about a scene — and it is the one an author writing that scene
 * actually has.
 *
 * A character under a system that draws nothing falls back to the profile's
 * template, so a vault gets something useful before anyone has drawn anything.
 */
export function renderSituationSheet(
	project: Project,
	situationId: string,
	profile: ResolvedProfile,
): Line[] {
	const situation = project.vault.situations.find(one => one.id === situationId);
	if (situation === undefined) {
		return [error(`no situation '${situationId}'`)];
	}

	const clock = momentByStep(project.replay.sequence, project.vault.situations);
	const cast = castOf(project.replay, clock, situation);

	const lines: Line[] = [
		heading(`${situation.id}${situation.title ? ` — ${situation.title}` : ''}`),
	];

	if (cast.moment === undefined) {
		lines.push(
			warn('no moment on the clock — these are the states as the sequence left them'),
		);
	}

	if (cast.states.length === 0) {
		// The tool knows exactly why and used to say only that nobody had a
		// state, which is the least useful true sentence available: every reason
		// below is already computed and each has a different fix.
		lines.push(blank(), warn('nobody in this scene has a state to show'));

		if (situation.arc === undefined) {
			lines.push(
				muted('  this scene is on no arc, so it is in no replay at all —'),
				muted(`  /situation ${situation.id} arc <arc> places it`),
			);
		}

		const unknown = cast.missing.filter(
			name => !project.vault.characters.some(one => one.id === name),
		);
		if (unknown.length > 0) {
			lines.push(
				muted(`  no character page for ${unknown.join(', ')} —`),
				muted('  /primitives character lists the ids that exist'),
			);
		}

		if (situation.characters.length === 0) {
			lines.push(
				muted('  and nobody is cast in it —'),
				muted(`  /situation ${situation.id} cast <character> names someone`),
			);
		}

		return lines;
	}

	for (const state of cast.states) {
		const drawn = project.vault.interfaces[state.system ?? ''];
		const block = renderStatusBlock(
			{
				id: state.character,
				system: state.system,
				level: state.level,
				xp: state.xp,
				stats: {...state.stats},
				skills: [...state.skills],
				items: {...state.items},
				artifacts: [...state.artifacts],
			},
			{
				profile,
				drawn,
				displayName: state.character,
				system: project.vault.systems.find(one => one.id === state.system),
			},
		);

		lines.push(
			blank(),
			text(`${state.character}${state.system ? ` · ${state.system}` : ''}`, {
				color: '#9ece6a',
			}),
			...block.split('\n').map(line => text(line)),
		);
	}

	// Named rather than omitted: a scene casting someone the ledger has never
	// seen is a broken reference, and silence here would hide it behind a screen
	// that looks complete.
	if (cast.missing.length > 0) {
		lines.push(blank(), warn(`no state for ${cast.missing.join(', ')}`));
	}

	return lines;
}

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
		lines.push(warn('no moment — every character state here is unplaced'));
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

	// Same order the wiki page uses, and for the same reason: by what blocks
	// what. The two must agree, or the screen and the page give an author
	// different advice about the same scene.
	const todo = linkageSteps(project, situation, cast.moment);
	if (todo.length > 0) {
		lines.push(blank(), muted('not linked yet — in the order they need doing'));
		for (const [index, step] of todo.entries()) {
			lines.push(text(`  ${String(index + 1)}. ${step}`));
		}
	}

	return lines;
}

/**
 * What a scene still needs, in the order it has to be done.
 *
 * Ordered by what blocks what. An arc is first because without one the scene
 * never enters the replay sequence, so nothing else it links can reach the
 * ledger — casting a scene that does not replay changes nothing. Place is last
 * because it blocks only its own wiki page.
 *
 * Each step names its own prerequisite when that is missing too: telling an
 * author to run `/situation X arc <arc>` in a vault with no arcs sends them to
 * a refusal rather than to a scene.
 */
export function linkageSteps(
	project: Project,
	situation: Situation,
	moment: string | undefined,
): string[] {
	const steps: string[] = [];
	const id = situation.id;

	if (situation.arc === undefined) {
		steps.push(
			project.vault.arcs.length === 0
				? `/arc new <title>, then /situation ${id} arc <arc> — it never replays until then`
				: `/situation ${id} arc <arc> — it never replays until then`,
		);
	} else if (
		project.vault.arcs.find(candidate => candidate.id === situation.arc)?.starts_after ===
		undefined
	) {
		steps.push(
			`/arc ${situation.arc} after <moment> — its arc has no clock position to inherit`,
		);
	}

	if (moment === undefined) {
		steps.push(
			project.vault.moments.some(each => each.at !== undefined)
				? `/situation ${id} moment <moment> — states here are unplaced until then`
				: `/moment new <name> and /moment <id> at <when>, then /situation ${id} moment <moment>`,
		);
	}

	if (situation.characters.length === 0) {
		steps.push(`/situation ${id} cast <character>… — nobody is in it`);
	}

	if (situation.place === undefined) {
		steps.push(`/situation ${id} place <place> — nowhere for it to happen`);
	}

	return steps;
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
		for (const row of columns(
			stats.map(([id, value]) => [`  ${id}`, formatStat(value)]),
		)) {
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
				muted('    /ingest interview files it, through the same review gate'),
			);
		}
		lines.push(blank());
	}

	const byKind = new Map<string, number>();
	for (const question of project.questions) {
		byKind.set(question.kind, (byKind.get(question.kind) ?? 0) + 1);
	}

	if (project.vault.issues.length > 0) {
		lines.push(
			error(`${plural(project.vault.issues.length, 'page')} rejected and not loaded`),
		);
		for (const issue of project.vault.issues) {
			// The whole message, on its own line. This used to be
			// `message.split('\n')[0]` of zod's pretty-printed JSON, which is the
			// single character `[` — so a rejected page named itself and said
			// nothing, which reads as a diagnostic while being none.
			lines.push(
				text(`  ${issue.file}`, {color: '#e0af68'}),
				muted(`    ${issue.message}`),
			);
		}
		lines.push(
			muted('  a rejected page is in no list — no timeline entry, no wiki page'),
			blank(),
		);
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
		for (const row of columns(
			stats.map(([key, value]) => [`  ${key}`, formatStat(value)]),
		)) {
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

	// Said here rather than left to be discovered when a date is refused. An
	// author who has named their origin has already started thinking in dates,
	// and this is the screen where they find out the vault has not.
	if (time?.calendar === undefined) {
		lines.push(
			blank(),
			muted('no calendar bound — times are whole seconds'),
			muted('/time gregorian <epoch> [zone] reads them as Earth/Sol dates'),
			muted('/time custom reads them through a calendar formula you wrote'),
		);
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

/**
 * `/moment` — every moment, in clock order, with what each one holds.
 *
 * Undated moments are listed last rather than hidden. A moment recorded before
 * the author knows when it happened is the normal way a timeline gets built,
 * and a list that dropped them would make the vault look emptier than it is.
 */
export function renderMoments(project: Project, calendar: Calendar): Line[] {
	const {moments} = project.vault;

	if (moments.length === 0) {
		return [
			heading('moments'),
			muted('none yet — /moment new <name> creates one'),
			muted('or /timeline interview draws them out'),
		];
	}

	const dated = moments
		.filter((m): m is typeof m & {at: Instant} => m.at !== undefined)
		.toSorted((a, b) => compareInstants(a.at, b.at));
	const undated = moments
		.filter(m => m.at === undefined)
		.toSorted((a, b) => a.id.localeCompare(b.id));

	const anchored = (id: string) =>
		project.vault.situations.filter(s => s.moment === id).length;

	const lines: Line[] = [
		heading('moments'),
		muted(
			`${plural(moments.length, 'moment')} · ${String(dated.length)} dated · ${calendar.name}`,
		),
		blank(),
	];

	const rows = dated.map(moment => [
		`  ${moment.id}`,
		moment.name ?? '',
		calendar.format(moment.at),
		plural(moment.events.length, 'event'),
		anchored(moment.id) === 0 ? '' : plural(anchored(moment.id), 'scene'),
	]);
	for (const row of columns(rows)) {
		lines.push(text(row));
	}

	if (undated.length > 0) {
		lines.push(blank(), muted('undated — recorded, but not on the clock'));
		for (const moment of undated) {
			lines.push(muted(`  ${moment.id}  ${moment.name ?? ''}`));
		}
		lines.push(muted('/moment <id> at <date> places one'));
	}

	return lines;
}

/** One moment: where it sits, what it changes, and what hangs off it. */
export function renderMoment(
	project: Project,
	momentId: string,
	calendar: Calendar,
): Line[] {
	const moment = project.vault.moments.find(candidate => candidate.id === momentId);
	if (moment === undefined) {
		return [
			error(`no moment '${momentId}'`),
			muted('/moment lists them · /moment new <name> creates one'),
		];
	}

	const lines: Line[] = [
		heading(`${moment.id}${moment.name ? ` — ${moment.name}` : ''}`),
	];

	if (moment.at === undefined) {
		lines.push(
			warn('undated — not on the clock, so nothing it carries reaches the ledger'),
			muted(`/moment ${moment.id} at <date> places it`),
		);
	} else {
		lines.push(
			text(`at           ${grouped(moment.at)}`),
			text(`reads as     ${calendar.format(moment.at)}`),
			text(`from origin  ${describeDuration(moment.at)}`),
		);
	}

	lines.push(blank(), muted('what it changes'));
	if (moment.events.length === 0) {
		lines.push(muted('  (no ledger events)'));
	} else {
		for (const event of moment.events) {
			lines.push(text(`  ${event.type}  ${event.actor}`));
		}
	}

	// The two things that hang off a moment, so its removal is never a surprise.
	const scenes = project.vault.situations.filter(s => s.moment === moment.id);
	const arcs = project.vault.arcs.filter(a => a.starts_after === moment.id);

	if (scenes.length > 0) {
		lines.push(blank(), muted('scenes anchored here'));
		for (const scene of scenes) {
			lines.push(text(`  ${scene.id}${scene.title ? ` — ${scene.title}` : ''}`));
		}
	}

	if (arcs.length > 0) {
		lines.push(blank(), muted('arcs starting after it'));
		for (const arc of arcs) {
			lines.push(text(`  ${arc.id}${arc.name ? ` — ${arc.name}` : ''}`));
		}
	}

	return lines;
}

/**
 * Why a written time could not be read, and what to do about it.
 *
 * Shared by `/time at` and `/moment <id> at` so the two cannot diverge, and
 * split by *cause* rather than reporting one message for all three. The
 * distinction matters: "no calendar is bound" is a fact about the vault and
 * tells the author exactly what to do next, while "that is not a date I can
 * read" is a fact about the input and sends them to check their typing. Saying
 * the second when the first is true is how someone concludes the date format is
 * wrong and goes looking for the right one, which does not exist yet.
 */
export function renderUnreadableTime(
	written: string,
	calendar: Calendar,
	note?: string,
): Line[] {
	const trailer = note === undefined ? [] : [muted(note)];

	// Digits, so it was meant as an instant and is simply too far out. Checked
	// first: every branch below would otherwise call a number "a date".
	if (/^[+-]?[\d,]+$/.test(written.trim())) {
		return [
			error(`${written} is outside the supported range`),
			muted(
				`the clock reaches ±${grouped(MAX_INSTANT)} seconds — a trillion years either way`,
			),
			...trailer,
		];
	}

	// Nothing bound. The input is very likely fine; the vault has no calendar.
	if (calendar.id === 'seconds') {
		return [
			error('no calendar is bound, so a time has to be whole seconds'),
			muted(`'${written}' looks like a date — bind a calendar to write dates:`),
			text('  /time gregorian <epoch> [zone]'),
			muted('  where <epoch> is the real instant your origin sits at, ISO 8601'),
			muted('  e.g. /time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles'),
			...trailer,
		];
	}

	// A formula formats and cannot be inverted. A limit of the shape, not the input.
	if (calendar.parse === undefined) {
		return [
			error(`${calendar.name} formats dates but cannot read them back`),
			muted('a calendar formula is one-way — give whole seconds instead'),
			...trailer,
		];
	}

	// A zone the runtime does not know is the single most likely reason a
	// well-formed date is rejected, and the message above sends the author to
	// check their date format instead — which is fine.
	const last = /\s(\S+)$/.exec(written.trim())?.[1];
	const badZone =
		last !== undefined && last.includes('/') && !isTimeZone(last) ? last : undefined;

	return [
		error(`${calendar.name} cannot read '${written}'`),
		...(badZone === undefined
			? []
			: [muted(`'${badZone}' is not a time zone this system knows`)]),
		muted('try 2036-08-15 02:30:00, or give whole seconds'),
		...(calendar.inZone === undefined
			? []
			: [muted('a trailing IANA zone is read too — 2036-08-15 02:30:00 Etc/UTC')]),
		...trailer,
	];
}

/** How many moments a zone preview lists before it starts summarising. */
const ZONE_PREVIEW_LIMIT = 12;

/**
 * `/time in <zone>` — the vault's clock as another zone would read it.
 *
 * A preview and nothing else: it writes nothing, and the binding it is
 * previewing against is untouched. That is the whole point of it. Once a vault
 * is bound the way its author wants, asking "what would this look like in
 * Tokyo" should not require rebinding it to Tokyo and back, and the round trip
 * through a rebind is not even safe — it rewrites `setting/time.md` twice and
 * every date the tool prints in between.
 *
 * Only the instants are real. Nothing here is stored, and the seconds column is
 * the same in both zones by construction — which is the fact the preview exists
 * to make obvious.
 */
export function renderTimeZone(
	project: Project,
	zone: string,
	calendar: Calendar,
	note?: string,
): Line[] {
	const trailer = note === undefined ? [] : [muted(note)];

	if (!isTimeZone(zone)) {
		return [
			error(`'${zone}' is not a time zone this system knows`),
			muted('IANA names, e.g. Etc/UTC, America/Los_Angeles, Asia/Tokyo'),
			...trailer,
		];
	}

	const other = calendar.inZone?.(zone);
	if (other === undefined) {
		return [
			error(`${calendar.name} has no time zones to preview`),
			muted('zones apply to the Gregorian calendar — bind one with:'),
			text('  /time gregorian <epoch> [zone]'),
			...trailer,
		];
	}

	const dated = project.vault.moments
		.filter(moment => moment.at !== undefined)
		.toSorted((a, b) => compareInstants(a.at!, b.at!));
	const differing = dated.filter(
		moment => other.format(moment.at!) !== calendar.format(moment.at!),
	);

	// Compared by what they render, not by what they are called. `UTC` and
	// `Etc/UTC` are one zone under two spellings, so matching on the name told
	// an author their vault was not in the zone it is in — and two genuinely
	// different zones that happen to agree across everything this vault dates
	// have nothing to preview either. Both are the same answer to the only
	// question being asked: would this show me something?
	if (differing.length === 0 && other.format(0n) === calendar.format(0n)) {
		return [
			ok(`${zone} reads exactly as this vault already does`),
			text(`origin       ${calendar.format(0n)}`),
			...(dated.length === 0
				? []
				: [
						muted(`and so does every one of its ${plural(dated.length, 'dated moment')}`),
					]),
			...trailer,
		];
	}
	const shown = differing.slice(0, ZONE_PREVIEW_LIMIT);
	const same = dated.length - differing.length;

	const rows: string[][] = [
		['', 'seconds', calendar.name, other.name],
		['origin', '0', calendar.format(0n), other.format(0n)],
		...shown.map(moment => [
			moment.id,
			moment.at!.toString(),
			calendar.format(moment.at!),
			other.format(moment.at!),
		]),
	];

	return [
		ok(`preview only — this vault stays bound to ${calendar.name}`),
		blank(),
		...columns(rows).map(line => text(line)),
		blank(),
		...(same === 0
			? []
			: [
					muted(
						`${plural(same, 'other dated moment')} read the same in both — beyond this calendar, or unaffected`,
					),
				]),
		...(differing.length > shown.length
			? [
					muted(
						`${plural(differing.length - shown.length, 'more')} not listed; every one of them keeps its seconds`,
					),
				]
			: []),
		muted('nothing here is stored — the seconds column is what the vault holds'),
		...trailer,
	];
}

/**
 * `/place` — everywhere scenes happen, written or merely named.
 *
 * Both directions count. A place with a page but no scene is somewhere the
 * author has built and not yet used; a place a scene names with no page is
 * somewhere they have used and not yet built. Listing only one of those would
 * hide half the world, and they are different kinds of unfinished.
 */
export function renderPlaces(project: Project): Line[] {
	const {places, situations} = project.vault;
	const named = new Set(
		situations.map(s => s.place).filter((p): p is string => p !== undefined),
	);
	const written = new Set(places.map(place => place.id));
	const all = [...new Set([...written, ...named])].toSorted();

	if (all.length === 0) {
		return [
			heading('places'),
			muted('none yet — /place new <name> writes one'),
			muted('or /situation <id> place <place> names one from a scene'),
		];
	}

	const scenes = (id: string) => situations.filter(s => s.place === id).length;

	const lines: Line[] = [
		heading('places'),
		muted(`${plural(all.length, 'place')} · ${String(written.size)} with a page`),
		blank(),
	];

	for (const row of columns(
		all.map(id => [
			`  ${id}`,
			places.find(place => place.id === id)?.name ?? '',
			scenes(id) === 0 ? 'no scenes' : plural(scenes(id), 'scene'),
			written.has(id) ? '' : 'no page yet',
		]),
	)) {
		lines.push(text(row));
	}

	return lines;
}

/** One place: what it is called, and what has happened there. */
export function renderPlace(project: Project, placeId: string): Line[] {
	const place = project.vault.places.find(candidate => candidate.id === placeId);
	const scenes = project.vault.situations.filter(s => s.place === placeId);

	// Neither a page nor a mention: nothing in the vault knows this name.
	if (place === undefined && scenes.length === 0) {
		return [
			error(`no place '${placeId}'`),
			muted('/place lists them · /place new <name> writes one'),
		];
	}

	const lines: Line[] = [heading(`${placeId}${place?.name ? ` — ${place.name}` : ''}`)];

	if (place === undefined) {
		lines.push(
			warn('no page yet — named by scenes, but nothing describes it'),
			muted(`/place new ${placeId} writes one`),
		);
	}

	lines.push(blank(), muted('scenes here'));
	if (scenes.length === 0) {
		lines.push(
			muted('  (none)'),
			muted(`  /situation <id> place ${placeId} sets one here`),
		);
	} else {
		for (const scene of scenes) {
			lines.push(text(`  ${scene.id}${scene.title ? ` — ${scene.title}` : ''}`));
		}
	}

	const cast = [...new Set(scenes.flatMap(scene => scene.characters))].toSorted();
	if (cast.length > 0) {
		lines.push(blank(), muted('who has been here'), text(`  ${cast.join(', ')}`));
	}

	return lines;
}
