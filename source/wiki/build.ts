import {existsSync, readdirSync, readFileSync} from 'node:fs';
import type {Project} from '../core/project.js';
import type {
	Arc,
	Character,
	Artifact,
	Faction,
	Moment,
	LedgerEvent,
	Situation,
	SystemDef,
	Theme,
} from '../domain/schema.js';
import {
	AGENCY_NOTE,
	ORIGIN_NOTE,
	settingSchema,
	VISIBILITY_NOTE,
	type Setting,
} from '../genre/types.js';
import type {Step} from '../ledger/replay.js';
import {castOf, momentByStep} from '../ledger/state.js';
import {compareInstants, grouped} from '../time/instant.js';
import {calendarFor} from '../time/binding.js';
import type {Calendar} from '../time/calendar.js';
import {parseDocument} from '../vault/frontmatter.js';
import {resolve, VAULT} from '../vault/paths.js';
import type {Wiki, WikiKind, WikiPage} from './types.js';

/**
 * Same text as `ledger/projections.ts` and `vault/scaffold.ts` — every derived
 * file in the vault carries this banner so a page regenerated wholesale is
 * never mistaken for the author's own writing (P6).
 */
const BANNER =
	'> [!warning] Generated file\n> Written by litfire. Hand edits are overwritten on the next recompute.';

/** Moments have no file of their own; scaffold.ts's own seed content links
 * to one the same way: `[[moments|we-001]]`. */

const KIND_ORDER: readonly Exclude<WikiKind, 'index'>[] = [
	'system',
	'character',
	'place',
	'faction',
	'moment',
	'artifact',
	'skill',
	'item',
	'arc',
	'situation',
	'theme',
];

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

function plural(count: number, word: string, suffix = 's'): string {
	return `${count} ${word}${count === 1 ? '' : suffix}`;
}

/** Both kinds of step have their own page now, so both link directly. */
function stepLink(step: Step): string {
	return `[[${step.id}]]`;
}

type StepContext = {
	readonly sequence: readonly Step[];
	readonly sequenceIndex: ReadonlyMap<string, number>;
	readonly eventsByStep: ReadonlyMap<string, readonly LedgerEvent[]>;
	/**
	 * How this vault reads its clock. Every page that shows a position goes
	 * through it, so binding a calendar changes the whole wiki at once rather
	 * than page by page.
	 */
	readonly calendar: Calendar;
};

/**
 * Rebuilds the id→events lookup `ledger/replay.ts` uses internally. It is not
 * exported from there, and every page here needs to walk the same sequence
 * correlating steps to the raw events that produced them.
 */
function buildStepContext(project: Project): StepContext {
	const sequence = project.replay.sequence;
	const {calendar} = calendarFor(project.vault.time, {
		formatted: project.calendarText,
	});
	const sequenceIndex = new Map(sequence.map((step, index) => [step.id, index]));
	const eventsByStep = new Map<string, readonly LedgerEvent[]>([
		...project.vault.moments.map(event => [event.id, event.events] as const),
		...project.vault.situations.map(
			situation => [situation.id, situation.events] as const,
		),
	]);
	return {sequence, sequenceIndex, eventsByStep, calendar};
}

/** Situations that never made it into the sequence (unplaced) sort last,
 * mirroring `buildSequence`'s own tie-break convention (D3). */
function bySequenceThenId(ctx: StepContext) {
	return (a: Situation, b: Situation): number =>
		(ctx.sequenceIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
			(ctx.sequenceIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
		a.id.localeCompare(b.id);
}

/**
 * Reads a free-form author file synchronously. `places/` and `factions/` carry
 * no schema (there is none) and nothing in `Project` loads their bodies, so the
 * only way to fold an author's own page in is to read it directly off
 * `project.vault.root` (P1: the filesystem is the API). `buildWiki` is
 * contracted as a plain, synchronous function of `Project`, so this reads
 * synchronously rather than pulling the rest of the module onto `fs/promises`.
 */
function readAuthorBody(root: string, directory: string, id: string): string | undefined {
	for (const file of authorFiles(root, directory, id)) {
		try {
			const raw = readFileSync(file, 'utf8');
			const body = parseDocument(raw).body.trim();
			if (body !== '') {
				return body;
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

/**
 * Where a page's source might be, best guess first.
 *
 * Most kinds are `<directory>/<id>.md` and stop at the first candidate. A
 * situation is not: `/situation new` slugs the title into the filename, so
 * `sit-002` lives in `sit-002-the-ledger-room.md`, and looking only for
 * `sit-002.md` meant a scene's own prose never appeared on its own page — the
 * one page it most obviously belongs on.
 */
function authorFiles(root: string, directory: string, id: string): string[] {
	const direct = resolve(root, directory, `${id}.md`);
	if (existsSync(direct)) {
		return [direct];
	}

	try {
		return readdirSync(resolve(root, directory), {withFileTypes: true})
			.filter(entry => entry.isFile() && entry.name.endsWith('.md'))
			.map(entry => resolve(root, directory, entry.name))
			.filter(file => {
				try {
					return parseDocument(readFileSync(file, 'utf8')).data['id'] === id;
				} catch {
					return false;
				}
			});
	} catch {
		return [];
	}
}

/**
 * The author's own prose for a page, placed above the computed sections.
 *
 * The wiki used to show only what the tool worked out, which meant an interview
 * that established what the System costs and who can see it wrote real prose to
 * `system/system.md` and then appeared nowhere — the page listed stats and
 * descriptors and silently dropped the paragraphs. Computed facts are the
 * *annotation*; what the author established is the page.
 */
function authorSection(
	root: string,
	directory: string,
	id: string,
	source: string,
): string {
	const written = readAuthorBody(root, directory, id);
	return [
		`## From \`${source}\``,
		'',
		written ?? `_Nothing written in \`${source}\` yet._`,
	].join('\n');
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

type TrajectoryPoint = {
	readonly step: Step | undefined;
	readonly level: number;
	readonly xp: number;
};
type Trajectory = {
	readonly points: readonly TrajectoryPoint[];
	readonly seed: TrajectoryPoint;
	readonly latest: TrajectoryPoint;
};

/**
 * Walks `replay.snapshots` rather than re-deriving level from XP: the curve is
 * a formula, `buildWiki` is synchronous, and the snapshot already holds
 * whatever `computeProject` decided the level was at that step.
 */
function characterTrajectory(
	character: Character,
	project: Project,
	ctx: StepContext,
): Trajectory {
	const seed: TrajectoryPoint = {
		step: undefined,
		level: character.level,
		xp: character.xp,
	};
	const points: TrajectoryPoint[] = [seed];
	let latest = seed;

	for (const step of ctx.sequence) {
		const state = project.replay.snapshots.get(step.id)?.characters[character.id];
		if (!state) {
			continue;
		}
		if (state.level !== latest.level || state.xp !== latest.xp) {
			latest = {step, level: state.level, xp: state.xp};
			points.push(latest);
		}
	}

	return {points, seed, latest};
}

type SkillAcquisition = {readonly skill: string; readonly step: Step};

function characterSkillAcquisitions(
	character: Character,
	ctx: StepContext,
): SkillAcquisition[] {
	const acquisitions: SkillAcquisition[] = [];
	for (const step of ctx.sequence) {
		for (const event of ctx.eventsByStep.get(step.id) ?? []) {
			if (event.type === 'acquire_skill' && event.actor === character.id) {
				acquisitions.push({skill: event.skill, step});
			}
		}
	}
	return acquisitions;
}

function situationsFeaturing(
	characterId: string,
	project: Project,
	ctx: StepContext,
): Situation[] {
	return project.vault.situations
		.filter(situation => situation.characters.includes(characterId))
		.toSorted(bySequenceThenId(ctx));
}

function coAppearances(
	characterId: string,
	situations: readonly Situation[],
): Array<{readonly id: string; readonly count: number}> {
	const counts = new Map<string, number>();
	for (const situation of situations) {
		for (const other of situation.characters) {
			if (other === characterId) {
				continue;
			}
			counts.set(other, (counts.get(other) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([id, count]) => ({id, count}))
		.toSorted((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

function placesOf(situations: readonly Situation[]): string[] {
	return [
		...new Set(
			situations
				.map(situation => situation.place)
				.filter((p): p is string => p !== undefined),
		),
	].toSorted();
}

function buildCharacterPage(
	character: Character,
	project: Project,
	ctx: StepContext,
): WikiPage {
	const trajectory = characterTrajectory(character, project, ctx);
	const skills = characterSkillAcquisitions(character, ctx);
	const situations = situationsFeaturing(character.id, project, ctx);
	const co = coAppearances(character.id, situations);
	const places = placesOf(situations);
	const state = project.replay.state.characters[character.id];
	const items = Object.entries(state?.items ?? {})
		.filter(([, qty]) => qty > 0)
		.toSorted(([a], [b]) => a.localeCompare(b));
	const questions = project.questions.filter(
		q => q.status === 'open' && q.actor === character.id,
	);

	// The one line the agents receive as grounding: computed facts, not "Carl is
	// a character" (types.ts). Mirrors the example in the wiki spec verbatim.
	const summary = [
		`level ${trajectory.seed.level}→${trajectory.latest.level} across ${plural(situations.length, 'scene')}`,
		skills.length > 0 ? plural(skills.length, 'skill') : undefined,
		items.length > 0
			? `with ${items.map(([id, qty]) => `${id} ×${qty}`).join(', ')}`
			: undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(', ');

	const trajectoryRows = trajectory.points
		.map(
			point =>
				`| ${point.step === undefined ? 'seed' : stepLink(point.step)} | ${point.level} | ${point.xp} |`,
		)
		.join('\n');

	const body = [
		`# ${character.name ?? character.id}`,
		'',
		BANNER,
		'',
		`Currently level **${trajectory.latest.level}**, xp **${trajectory.latest.xp}**.`,
		'',
		authorSection(
			project.vault.root,
			VAULT.characters,
			character.id,
			`${VAULT.characters}/${character.id}.md`,
		),
		'',
		'## Level and XP trajectory',
		'',
		'| step | level | xp |',
		'| --- | --- | --- |',
		trajectoryRows,
		'',
		'## Skills',
		'',
		skills.length === 0
			? '_None acquired._'
			: skills.map(a => `- [[${a.skill}]] at ${stepLink(a.step)}`).join('\n'),
		'',
		'## Items held',
		'',
		items.length === 0
			? '_None._'
			: items.map(([id, qty]) => `- [[${id}]] ×${qty}`).join('\n'),
		'',
		'## Situations',
		'',
		situations.length === 0
			? '_Appears in no situation yet._'
			: situations.map(s => `- [[${s.id}]]${s.title ? ` — ${s.title}` : ''}`).join('\n'),
		'',
		'## Co-appearances',
		'',
		co.length === 0
			? '_No shared scenes._'
			: co.map(c => `- [[${c.id}]] ×${c.count}`).join('\n'),
		'',
		'## Places',
		'',
		places.length === 0 ? '_None recorded._' : places.map(p => `- [[${p}]]`).join('\n'),
		'',
		'## Open questions',
		'',
		questions.length === 0
			? '_None._'
			: questions.map(q => `- ${q.id} [${q.kind}] ${q.where}: ${q.detail}`).join('\n'),
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		path: `${VAULT.wiki}/characters/${character.id}.md`,
		kind: 'character',
		id: character.id,
		title: character.name ?? character.id,
		summary,
		body,
	};
}

// ---------------------------------------------------------------------------
// Places. Ids come from two directions and both count: the pages an author has
// written, and the ids situations name. Deriving them from situations alone
// meant a place someone had written a page about was invisible until a scene
// happened there, which reads as the wiki having lost it. Deriving them from
// the directory alone would drop a place a scene names but nobody has written
// up yet, which is the more common half of the same mistake.
// ---------------------------------------------------------------------------

function placeIds(project: Project): string[] {
	return [
		...new Set([
			...project.vault.places.map(place => place.id),
			...project.vault.situations
				.map(situation => situation.place)
				.filter((p): p is string => p !== undefined),
		]),
	].toSorted();
}

function buildPlacePage(placeId: string, project: Project, ctx: StepContext): WikiPage {
	const situations = project.vault.situations
		.filter(s => s.place === placeId)
		.toSorted(bySequenceThenId(ctx));
	const placed = situations.filter(s => ctx.sequenceIndex.has(s.id));
	const first = placed.at(0);
	const last = placed.at(-1);
	const characters = [...new Set(situations.flatMap(s => s.characters))].toSorted();
	const authorBody = readAuthorBody(project.vault.root, VAULT.places, placeId);
	const place = project.vault.places.find(candidate => candidate.id === placeId);

	const summary =
		first && last
			? `${plural(situations.length, 'situation')}, first ${first.id}, last ${last.id}`
			: `${plural(situations.length, 'situation')}, none placed in sequence yet`;

	const body = [
		`# ${place?.name ?? placeId}`,
		'',
		BANNER,
		'',
		authorBody ??
			`_No \`${VAULT.places}/${placeId}.md\` file yet — this page is derived entirely from situations that reference it._`,
		'',
		'## Situations, in sequence order',
		'',
		situations.length === 0
			? '_None._'
			: situations
					.map(
						s =>
							`- [[${s.id}]]${s.title ? ` — ${s.title}` : ''}${ctx.sequenceIndex.has(s.id) ? '' : ' _(unplaced)_'}`,
					)
					.join('\n'),
		'',
		'## Who appears here',
		'',
		characters.length === 0
			? '_Nobody yet._'
			: characters.map(c => `- [[${c}]]`).join('\n'),
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		path: `${VAULT.wiki}/places/${placeId}.md`,
		kind: 'place',
		id: placeId,
		// Named if the author wrote a page for it; a place a scene invented has
		// only its id, and showing the slug is honest about that.
		title: place?.name ?? placeId,
		summary,
		body,
	};
}

// ---------------------------------------------------------------------------
// Factions — typed, but only barely: `goal` and `members` are both optional
// because an interview establishes that a group exists long before it
// establishes what the group wants. The prose body still carries most of it.
// ---------------------------------------------------------------------------

/**
 * Membership is the one structural edge a faction has, so it is the whole
 * cross-reference. A member with no character page still renders — as a
 * wikilink that goes nowhere, which is exactly how it reads in Obsidian, and
 * `runChecks` has already raised it as a broken reference.
 */
function buildFactionPage(faction: Faction, project: Project): WikiPage {
	const authorBody = readAuthorBody(project.vault.root, VAULT.factions, faction.id);
	const known = new Set(project.vault.characters.map(character => character.id));
	const members = [...faction.members].toSorted();

	const title = faction.name ?? faction.id;
	const summary =
		faction.goal === undefined
			? `${plural(members.length, 'member')}, goal not established`
			: faction.goal;

	const body = [
		`# ${title}`,
		'',
		BANNER,
		'',
		authorBody ??
			`_No \`${VAULT.factions}/${faction.id}.md\` body yet — this page is derived entirely from frontmatter._`,
		'',
		'## Goal',
		'',
		faction.goal ??
			'_Not established. `/system` or `/character` can surface it — see open questions._',
		'',
		'## Members',
		'',
		members.length === 0
			? '_Nobody recorded._'
			: members
					.map(id => `- [[${id}]]${known.has(id) ? '' : ' _(no character page)_'}`)
					.join('\n'),
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		path: `${VAULT.wiki}/factions/${faction.id}.md`,
		kind: 'faction',
		id: faction.id,
		title,
		summary,
		body,
	};
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function allSkillIds(project: Project, ctx: StepContext): Set<string> {
	const ids = new Set(project.vault.systems.flatMap(sys => sys.skills.map(s => s.id)));
	for (const events of ctx.eventsByStep.values()) {
		for (const event of events) {
			if (event.type === 'acquire_skill' || event.type === 'lose_skill') {
				ids.add(event.skill);
			}
		}
	}
	return ids;
}

function buildSkillPage(skillId: string, project: Project, ctx: StepContext): WikiPage {
	// First system that declares it. Two systems naming the same skill is the
	// author's business; the page shows the definition that exists.
	const def = project.vault.systems
		.flatMap(sys => sys.skills)
		.find(s => s.id === skillId);
	const acquirers: Array<{readonly actor: string; readonly step: Step}> = [];
	for (const step of ctx.sequence) {
		for (const event of ctx.eventsByStep.get(step.id) ?? []) {
			if (event.type === 'acquire_skill' && event.skill === skillId) {
				acquirers.push({actor: event.actor, step});
			}
		}
	}

	const requiresSkills = def?.requires_skills ?? [];
	const requiresLevel = def?.requires_level;

	const summary = [
		`${plural(acquirers.length, 'character')} acquired it`,
		requiresSkills.length > 0 ? `requires ${requiresSkills.join(', ')}` : undefined,
		requiresLevel !== undefined ? `requires level ${requiresLevel}` : undefined,
	]
		.filter((p): p is string => p !== undefined)
		.join('; ');

	const definitionLines = [
		requiresSkills.length > 0
			? `Requires: ${requiresSkills.map(id => `[[${id}]]`).join(', ')}.`
			: 'No skill prerequisites.',
		requiresLevel !== undefined ? `Requires level **${requiresLevel}**.` : undefined,
	].filter((p): p is string => p !== undefined);

	const body = [
		`# ${def?.name ?? skillId}`,
		'',
		BANNER,
		'',
		def === undefined
			? `_Not declared in \`${VAULT.skills}\` — only seen in events._`
			: definitionLines.join('\n'),
		'',
		'## Acquired by',
		'',
		acquirers.length === 0
			? '_Nobody yet._'
			: acquirers.map(a => `- [[${a.actor}]] at ${stepLink(a.step)}`).join('\n'),
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		path: `${VAULT.wiki}/skills/${skillId}.md`,
		kind: 'skill',
		id: skillId,
		title: def?.name ?? skillId,
		summary,
		body,
	};
}

// ---------------------------------------------------------------------------
// System — the author-owned rules layer the `/system` interview produces
// (§3): stats, curves, formulas, skills, and the setting descriptors.
// Everything else in this wiki is derived from play; this is what play plays
// by, and until now it had no page at all.
// ---------------------------------------------------------------------------

/**
 * `system/system.md` carries the setting descriptors (§3.1) and is normally
 * loaded by `loadSetting` (genre/load.ts) — but that function is async and
 * `buildWiki` is contracted as a plain, synchronous function of `Project`
 * (types.ts), the same constraint `readAuthorBody` above works around for
 * `places/` and `factions/`. Falls back to an unset `Setting` on a missing or
 * malformed file rather than throwing: a vault whose `/system` interview
 * never landed still gets a page, one that says so (P4).
 */
function readSetting(root: string): Setting {
	try {
		const raw = readFileSync(resolve(root, VAULT.settingFile), 'utf8');
		const parsed = settingSchema.safeParse(parseDocument(raw).data);
		return parsed.success ? parsed.data : settingSchema.parse({});
	} catch {
		return settingSchema.parse({});
	}
}

/** An unset descriptor is reported as unset, not omitted — "not yet decided"
 * is real information to an author mid-build, the same as an empty stat list. */
function descriptorLine<Value extends string>(
	label: string,
	value: Value | undefined,
	notes: Readonly<Record<Value, string>>,
): string {
	return value === undefined
		? `- **${label}**: not yet decided`
		: `- **${label}**: ${value} — ${notes[value]}`;
}

/** One page per character system. Several systems are several pages, never a merge. */
function buildSystemPage(
	system: SystemDef,
	project: Project,
	ctx: StepContext,
): WikiPage {
	const setting = readSetting(project.vault.root);
	const {stats, skills, curves} = system;

	// A formula defined on this system's own page wins over the shared file, so
	// resolution here has to match what the runner will actually do.
	const owned = project.vault.formulas.filter(
		formula => formula.system === undefined || formula.system === system.id,
	);
	const curveResolves = owned.some(formula => formula.id === curves.xp_for_level);
	const under = Object.values(project.replay.state.characters).filter(
		character => character.system === system.id,
	);

	// The exact set `buildWiki` below builds skill pages for (declared skills
	// plus any only ever seen in an event), so a link from here never 404s.
	const skillIds = [...allSkillIds(project, ctx)].toSorted();

	const statLines =
		stats.length === 0
			? '_No stats defined — the `/system` interview has not landed yet._'
			: stats
					.toSorted((a, b) => a.id.localeCompare(b.id))
					.map(stat => {
						const bounds = [
							stat.min !== undefined ? `min ${stat.min}` : undefined,
							stat.max !== undefined ? `max ${stat.max}` : undefined,
						]
							.filter((p): p is string => p !== undefined)
							.join(', ');
						return `- **${stat.name ?? stat.id}** (\`${stat.id}\`): default **${stat.default}**${bounds === '' ? '' : ` (${bounds})`}`;
					})
					.join('\n');

	// A curve naming a formula that is not defined is worth saying out loud —
	// it means the curve cannot evaluate, and the author is the only one who
	// can reconcile the name.
	const curveLine = curveResolves
		? `- \`xp_for_level\` names \`${curves.xp_for_level}\`, which this system defines.`
		: `- \`xp_for_level\` names \`${curves.xp_for_level}\`, which neither this system nor \`${VAULT.formulas}\` defines — not defined, so this curve cannot evaluate.`;

	// Ids only — never the source (that lives in system/formulas.md, and this
	// page is not the place to duplicate executable code).
	const formulaLines =
		owned.length === 0
			? '_No formulas defined._'
			: owned
					.toSorted((a, b) => a.id.localeCompare(b.id))
					.map(
						formula =>
							`- \`${formula.id}\`${formula.id === curves.xp_for_level ? ' — referenced by the xp curve' : ''}`,
					)
					.join('\n');

	const skillLines =
		skillIds.length === 0
			? '_None declared — the `/system` interview has not named any skills yet._'
			: skillIds
					.map(id => {
						const def = skills.find(s => s.id === id);
						return `- [[${id}]]${def?.name ? ` — ${def.name}` : ''}`;
					})
					.join('\n');

	const originLine = descriptorLine('Origin', setting.system_origin, ORIGIN_NOTE);
	const visibilityLine = descriptorLine(
		'Visibility',
		setting.system_visibility,
		VISIBILITY_NOTE,
	);
	const agencyLine = descriptorLine('Agency', setting.system_agency, AGENCY_NOTE);

	// Computed facts, not "The System" (types.ts) — mirrors the spec's own
	// example verbatim, minus the markdown the summary contract forbids.
	const summary = [
		plural(stats.length, 'stat'),
		plural(skillIds.length, 'skill'),
		plural(under.length, 'character'),
		`xp curve ${curves.xp_for_level}`,
	].join(', ');

	const title = system.name ?? system.id;

	const body = [
		`# ${title}`,
		'',
		BANNER,
		'',
		'The rules layer the `/system` interview produces (§3) — everything else in',
		'this wiki is derived from play; this page is what play plays by.',
		'',
		authorSection(project.vault.root, VAULT.system, 'system', VAULT.settingFile),
		'',
		// Membership is the fact a multi-system vault most needs from this page:
		// a stat means nothing until you know whose rules are counting it.
		'## Characters under it',
		'',
		under.length === 0
			? '_Nobody._'
			: under
					.toSorted((a, b) => a.id.localeCompare(b.id))
					.map(character => `- [[${character.id}]] — L${character.level}`)
					.join('\n'),
		'',
		'## Stats',
		'',
		statLines,
		'',
		'## Curves',
		'',
		curveLine,
		`- \`max_level\`: **${curves.max_level}**.`,
		'',
		'## Formulas',
		'',
		formulaLines,
		'',
		'## Skills',
		'',
		`${plural(skillIds.length, 'skill')} in the wiki.`,
		'',
		skillLines,
		'',
		'## Setting descriptors',
		'',
		originLine,
		visibilityLine,
		agencyLine,
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		// Always `systems/<id>.md`, even when there is one. The id is the system's
		// own, so the slug reads as the thing it names and the index needs no
		// alias — and a vault that gains a second system does not have to move
		// its first one's page. `writeWiki` prunes the old `wiki/system.md`.
		path: `${VAULT.wiki}/systems/${system.id}.md`,
		kind: 'system',
		id: system.id,
		title,
		summary,
		body,
	};
}

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------

function buildMomentPage(moment: Moment, project: Project, ctx: StepContext): WikiPage {
	const title = moment.name ?? moment.id;
	const anchored = project.vault.arcs
		.filter(arc => arc.starts_after === moment.id || arc.ends_before === moment.id)
		.toSorted((a, b) => a.id.localeCompare(b.id));
	const placed = ctx.sequenceIndex.has(moment.id);

	/**
	 * The scenes that say they happen here.
	 *
	 * `situation.moment` was read in one direction only: a scene's page named
	 * its moment and the moment's page never named the scene, so linking one
	 * and rebuilding looked like nothing had happened. A link the wiki shows
	 * from one end is half a link.
	 */
	const scenes = project.vault.situations
		.filter(situation => situation.moment === moment.id)
		.toSorted(bySequenceThenId(ctx));

	const body = [
		`# ${title}`,
		'',
		BANNER,
		'',
		authorSection(
			project.vault.root,
			VAULT.moments,
			moment.id,
			`${VAULT.moments}/${moment.id}.md`,
		),
		'',
		'## Position',
		'',
		moment.at === undefined
			? '_Undated — recorded but not placed, so nothing it carries reaches the ledger._'
			: // Both, always. The number is the truth and the date is a reading of
				// it; an epoch that is out by a century looks fine on its own and
				// wrong the moment it sits beside the seconds it came from.
				`${ctx.calendar.format(moment.at)} — **${grouped(moment.at)}** from origin.`,
		'',
		'## What it changes',
		'',
		moment.events.length === 0
			? '_No ledger events._'
			: moment.events.map(event => `- \`${event.type}\` — ${event.actor}`).join('\n'),
		'',
		'## Scenes anchored here',
		'',
		scenes.length === 0
			? '_None — no situation says it happens at this moment._'
			: scenes
					.map(situation => {
						const where =
							situation.place === undefined ? '' : ` at [[${situation.place}]]`;
						const unplaced = situation.arc === undefined ? ' — unplaced' : '';
						return `- [[${situation.id}|${situation.title ?? situation.id}]]${where}${unplaced}`;
					})
					.join('\n'),
		'',
		'## Arcs anchored to it',
		'',
		anchored.length === 0
			? '_None._'
			: anchored
					.map(
						arc =>
							`- [[${arc.id}]] — ${arc.starts_after === moment.id ? 'starts after' : 'ends before'} this`,
					)
					.join('\n'),
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		path: `${VAULT.wiki}/moments/${moment.id}.md`,
		kind: 'moment',
		id: moment.id,
		...(moment.at === undefined ? {} : {sortKey: moment.at}),
		title,
		// The scene count earns its place in the index: it is what says whether a
		// moment is a turning point the story actually visits or one nothing has
		// been written at yet.
		summary: [
			moment.at === undefined ? 'undated' : `at ${grouped(moment.at)}`,
			plural(moment.events.length, 'event'),
			...(scenes.length > 0 ? [plural(scenes.length, 'scene')] : []),
			...(moment.at !== undefined && !placed ? ['unplaced'] : []),
		].join(', '),
		body,
	};
}

// ---------------------------------------------------------------------------
// Artifacts — unlike items these have a page, because a thing used to achieve
// something has a purpose worth writing down and an item is only a count.
// ---------------------------------------------------------------------------

type ArtifactUse = {
	readonly actor: string;
	readonly step: Step;
	readonly verb: 'acquired' | 'lost' | 'used';
};

function buildArtifactPage(
	artifact: Artifact,
	project: Project,
	ctx: StepContext,
): WikiPage {
	const uses: ArtifactUse[] = [];
	for (const step of ctx.sequence) {
		for (const event of ctx.eventsByStep.get(step.id) ?? []) {
			if (
				(event.type === 'acquire_artifact' ||
					event.type === 'lose_artifact' ||
					event.type === 'use_artifact') &&
				event.artifact === artifact.id
			) {
				uses.push({
					actor: event.actor,
					step,
					verb:
						event.type === 'acquire_artifact'
							? 'acquired'
							: event.type === 'lose_artifact'
								? 'lost'
								: 'used',
				});
			}
		}
	}

	const holders = Object.values(project.replay.state.characters)
		.filter(character => character.artifacts.includes(artifact.id))
		.map(character => character.id)
		.toSorted();
	const title = artifact.name ?? artifact.id;
	const used = uses.filter(use => use.verb === 'used');

	const requires = [
		...artifact.requires_skills.map(id => `[[${id}]]`),
		artifact.requires_level === undefined
			? undefined
			: `level ${artifact.requires_level}`,
	].filter((entry): entry is string => entry !== undefined);

	const body = [
		`# ${title}`,
		'',
		BANNER,
		'',
		authorSection(
			project.vault.root,
			VAULT.artifacts,
			artifact.id,
			`${VAULT.artifacts}/${artifact.id}.md`,
		),
		'',
		'## What it achieves',
		'',
		artifact.outcome ?? '_Not established — see open questions._',
		'',
		'## Requires',
		'',
		requires.length === 0 ? '_Nothing._' : requires.map(entry => `- ${entry}`).join('\n'),
		'',
		'## Carried by',
		'',
		holders.length === 0
			? '_Nobody, at the end of the sequence._'
			: holders.map(id => `- [[${id}]]`).join('\n'),
		'',
		'## In the sequence',
		'',
		uses.length === 0
			? '_Never referenced by an event._'
			: uses.map(use => `- [[${use.step.id}]] — ${use.actor} ${use.verb} it`).join('\n'),
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		path: `${VAULT.wiki}/artifacts/${artifact.id}.md`,
		kind: 'artifact',
		id: artifact.id,
		title,
		summary: `${artifact.kind ?? 'artifact'}, ${plural(uses.length, 'reference')}, ${plural(used.length, 'use')}`,
		body,
	};
}

// ---------------------------------------------------------------------------
// Items — no schema at all; every fact comes from `item_gain`/`item_lose`.
// ---------------------------------------------------------------------------

type ItemEvent = {
	readonly actor: string;
	readonly qty: number;
	readonly gained: boolean;
	readonly step: Step;
};

function allItemIds(ctx: StepContext): Set<string> {
	const ids = new Set<string>();
	for (const events of ctx.eventsByStep.values()) {
		for (const event of events) {
			if (event.type === 'item_gain' || event.type === 'item_lose') {
				ids.add(event.item);
			}
		}
	}
	return ids;
}

function buildItemPage(itemId: string, project: Project, ctx: StepContext): WikiPage {
	const events: ItemEvent[] = [];
	for (const step of ctx.sequence) {
		for (const event of ctx.eventsByStep.get(step.id) ?? []) {
			if (event.type === 'item_gain' && event.item === itemId) {
				events.push({actor: event.actor, qty: event.qty, gained: true, step});
			} else if (event.type === 'item_lose' && event.item === itemId) {
				events.push({actor: event.actor, qty: event.qty, gained: false, step});
			}
		}
	}

	const holders = Object.values(project.replay.state.characters)
		.map(state => ({id: state.id, qty: state.items[itemId] ?? 0}))
		.filter(h => h.qty > 0)
		.toSorted((a, b) => b.qty - a.qty || a.id.localeCompare(b.id));

	const gains = events.filter(e => e.gained).length;
	const losses = events.length - gains;

	const summary = [
		`held by ${plural(holders.length, 'character')}`,
		holders.length > 0 ? holders.map(h => `${h.id} ×${h.qty}`).join(', ') : undefined,
		plural(gains, 'gain'),
		plural(losses, 'loss', 'es'),
	]
		.filter((p): p is string => p !== undefined)
		.join(', ');

	const body = [
		`# ${itemId}`,
		'',
		BANNER,
		'',
		'Derived purely from `item_gain`/`item_lose` events — there is no item schema.',
		'',
		'## Currently held',
		'',
		holders.length === 0
			? '_Held by nobody._'
			: holders.map(h => `- [[${h.id}]] ×${h.qty}`).join('\n'),
		'',
		'## Gained or lost',
		'',
		events.length === 0
			? '_No events._'
			: events
					.map(
						e =>
							`- ${e.gained ? '+' : '-'}${e.qty} [[${e.actor}]] at ${stepLink(e.step)}`,
					)
					.join('\n'),
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		path: `${VAULT.wiki}/items/${itemId}.md`,
		kind: 'item',
		id: itemId,
		title: itemId,
		summary,
		body,
	};
}

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

function buildArcPage(arc: Arc, project: Project, ctx: StepContext): WikiPage {
	const arcSteps = ctx.sequence.filter(
		(step): step is Extract<Step, {kind: 'situation'}> =>
			step.kind === 'situation' && step.arc === arc.id,
	);
	const situationById = new Map(project.vault.situations.map(s => [s.id, s]));
	const lastStep = arcSteps.at(-1);
	const endState = lastStep ? project.replay.snapshots.get(lastStep.id) : undefined;

	const milestoneEntries = Object.entries(arc.milestone);
	const milestoneLines = milestoneEntries.map(([characterId, milestone]) => {
		const actual = endState?.characters[characterId];
		if (!actual) {
			return `- [[${characterId}]]: milestone set, but the arc never replayed for them`;
		}

		const parts: string[] = [];
		if (milestone.level !== undefined) {
			parts.push(
				`level ${milestone.level} vs actual ${actual.level}${milestone.level === actual.level ? '' : ' — drift'}`,
			);
		}
		if (milestone.has_skills.length > 0) {
			const missing = milestone.has_skills.filter(s => !actual.skills.includes(s));
			parts.push(
				missing.length === 0
					? `holds: ${milestone.has_skills.join(', ')}`
					: `missing: ${missing.join(', ')} — drift`,
			);
		}
		for (const [stat, expected] of Object.entries(milestone.stats)) {
			const value = actual.stats[stat] ?? 0;
			parts.push(
				`${stat} ${expected} vs actual ${value}${expected === value ? '' : ' — drift'}`,
			);
		}
		return `- [[${characterId}]]: ${parts.join('; ')}`;
	});
	const driftCount = milestoneLines.filter(line => line.includes('drift')).length;

	const worldEvent = arc.starts_after
		? project.vault.moments.find(e => e.id === arc.starts_after)
		: undefined;

	const summary = [
		plural(arcSteps.length, 'situation'),
		arc.starts_after ? `starts after ${arc.starts_after}` : 'unanchored start',
		milestoneEntries.length > 0
			? `${driftCount}/${milestoneEntries.length} milestone(s) drifted`
			: undefined,
	]
		.filter((p): p is string => p !== undefined)
		.join(', ');

	const body = [
		`# ${arc.name ?? arc.id}`,
		'',
		BANNER,
		'',
		authorSection(project.vault.root, VAULT.arcs, arc.id, `${VAULT.arcs}/${arc.id}.md`),
		'',
		arc.starts_after
			? `Starts after ${stepLink({kind: 'moment', id: arc.starts_after})}${worldEvent?.name ? ` (${worldEvent.name})` : ''}.`
			: '_No anchor — starts unconstrained._',
		'',
		'## Situations, in order',
		'',
		arcSteps.length === 0
			? '_None replayed._'
			: arcSteps
					.map(step => {
						const situation = situationById.get(step.id);
						return `- [[${step.id}]]${situation?.title ? ` — ${situation.title}` : ''}`;
					})
					.join('\n'),
		'',
		'## Milestone vs actual',
		'',
		milestoneLines.length === 0 ? '_No milestone declared._' : milestoneLines.join('\n'),
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		path: `${VAULT.wiki}/arcs/${arc.id}.md`,
		kind: 'arc',
		id: arc.id,
		// Arcs carry their own order, and it is sparse: `arc-10` sorts before
		// `arc-2` alphabetically, which is the same lie one step smaller.
		...(arc.order === undefined ? {} : {sortKey: BigInt(arc.order)}),
		title: arc.name ?? arc.id,
		summary,
		body,
	};
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

/**
 * One situation: the scene as a hub.
 *
 * Everything else in the wiki hangs off this page's links — a place exists in
 * the wiki because a situation names it, a character's appearances are the
 * situations they are cast in, and a moment's scenes are the ones anchored to
 * it. A situation that names nothing leaves the rest of the wiki empty, which
 * is why this page says plainly what is still unlinked instead of rendering a
 * tidy stub.
 */
function buildSituationPage(
	situation: Situation,
	project: Project,
	ctx: StepContext,
): WikiPage {
	const clock = momentByStep(project.replay.sequence, project.vault.situations);
	const cast = castOf(project.replay, clock, situation);
	const arc = project.vault.arcs.find(a => a.id === situation.arc);

	const placed = ctx.sequence.some(
		step => step.kind === 'situation' && step.id === situation.id,
	);

	const facts = [
		arc ? `[[${arc.id}]]` : 'unplaced',
		cast.moment === undefined ? 'no moment' : `[[${cast.moment}]]`,
		situation.place === undefined ? 'nowhere' : `[[${situation.place}]]`,
		plural(situation.characters.length, 'character'),
	].join(' · ');

	/**
	 * What is still missing, in the order it has to be done.
	 *
	 * Ordered by what blocks what, not by the order the fields appear in the
	 * schema. An arc is first because without one the scene never enters the
	 * replay sequence, so nothing else it links can reach the ledger — fixing
	 * the cast of a scene that does not replay changes nothing. Place is last
	 * because it blocks only its own wiki page.
	 *
	 * Each step names its own prerequisite when that is missing too. "No arc,
	 * run `/situation X arc <arc>`" is useless advice in a vault with no arcs,
	 * and following it produces a refusal rather than a scene.
	 */
	const steps: string[] = [];
	const own = situation.id;

	if (situation.arc === undefined) {
		steps.push(
			project.vault.arcs.length === 0
				? `**Put it on an arc.** No arcs exist yet, so \`/arc new <title>\` first, then \`/situation ${own} arc <arc>\`. Until then the scene never replays and nothing it carries reaches the ledger.`
				: `**Put it on an arc** — \`/situation ${own} arc <arc>\`. Until then the scene never replays and nothing it carries reaches the ledger.`,
		);
	} else if (
		project.vault.arcs.find(candidate => candidate.id === situation.arc)?.starts_after ===
		undefined
	) {
		// Easiest gap to miss: the scene is placed, but its arc has no clock
		// position for the scene to inherit.
		steps.push(
			`**Anchor its arc to the clock** — \`/arc ${situation.arc} after <moment>\`. The arc has no \`starts_after\`, so its scenes have nothing on the clock before them.`,
		);
	}

	if (cast.moment === undefined) {
		const dated = project.vault.moments.filter(each => each.at !== undefined);
		steps.push(
			dated.length === 0
				? `**Give it a moment.** No dated moments exist yet, so \`/moment new <name>\` then \`/moment <id> at <when>\` first, then \`/situation ${own} moment <moment>\`. Until then every character state here is unplaced.`
				: `**Give it a moment** — \`/situation ${own} moment <moment>\`. Until then every character state here is unplaced.`,
		);
	}

	if (situation.characters.length === 0) {
		steps.push(
			`**Cast it** — \`/situation ${own} cast <character>…\`. Nobody appears in it, so it has no character states at all.`,
		);
	}

	if (situation.place === undefined) {
		steps.push(
			`**Say where it happens** — \`/situation ${own} place <place>\`. Without it there is no place page for this scene to sit in.`,
		);
	}

	const gaps = steps.map((step, index) => `${String(index + 1)}. ${step}`);

	const castLines =
		cast.states.length === 0
			? situation.characters.length === 0
				? ['_Nobody is cast in this scene yet._']
				: situation.characters.map(id => `- [[${id}]] — no state at this point`)
			: cast.states.map(state => {
					const stats = Object.entries(state.stats)
						.toSorted(([a], [b]) => a.localeCompare(b))
						.map(([id, value]) => `${id} ${String(value)}`)
						.join(', ');
					const held =
						state.artifacts.length === 0
							? 'no artifacts'
							: state.artifacts.map(id => `[[${id}]]`).join(', ');
					return `- [[${state.character}]] — level ${String(state.level)}${
						stats === '' ? '' : `, ${stats}`
					} · ${held}`;
				});

	const body = [
		`# ${situation.title ?? situation.id}`,
		'',
		BANNER,
		'',
		facts,
		'',
		...(gaps.length > 0
			? ['## Not linked yet', '', '_In the order they need doing:_', '', ...gaps, '']
			: []),
		'## Cast',
		'',
		cast.moment === undefined
			? '_State is shown at this scene, once it sits on the clock._'
			: `State after this scene, at [[${cast.moment}]].`,
		'',
		...castLines,
		'',
		...(situation.themes.length > 0
			? ['## Themes', '', situation.themes.map(t => `- [[${t}]]`).join('\n'), '']
			: []),
		'## Replay',
		'',
		placed
			? `Replays in sequence${situation.order === undefined ? '' : ` at order ${String(situation.order)}`}.`
			: 'Not in the replay sequence — an unplaced situation contributes no state.',
		'',
		situation.events.length === 0
			? '_No ledger events._'
			: situation.events
					.map(event => `- \`${event.type}\` — [[${event.actor}]]`)
					.join('\n'),
		'',
		// Unplaced scenes are still in the inbox, and their prose is no less the
		// author's for not having an arc yet.
		readAuthorBody(project.vault.root, VAULT.situations, situation.id) === undefined
			? authorSection(project.vault.root, VAULT.inbox, situation.id, 'situations/inbox/')
			: authorSection(project.vault.root, VAULT.situations, situation.id, 'situations/'),
	].join('\n');

	return {
		path: `${VAULT.wiki}/situations/${situation.id}.md`,
		kind: 'situation',
		id: situation.id,
		title: situation.title ?? situation.id,
		summary: facts.replaceAll(/\[\[|\]\]/g, ''),
		...(situation.order === undefined ? {} : {sortKey: BigInt(situation.order)}),
		body,
	};
}

function buildThemePage(theme: Theme, project: Project): WikiPage {
	const pillar = project.coverage.pillars.find(p => p.id === theme.id);

	const subthemeSections = theme.subthemes.map(subtheme => {
		const coverage = pillar?.subthemes.find(s => s.id === subtheme.id);
		const situations = project.vault.situations
			.filter(s => s.themes.includes(subtheme.id))
			.toSorted((a, b) => a.id.localeCompare(b.id));
		const poles = subtheme.tension.length > 0 ? subtheme.tension.join(' ↔ ') : undefined;

		return [
			`### ${subtheme.name ?? subtheme.id}`,
			'',
			poles ? `Tension: ${poles}.` : '',
			coverage
				? `${plural(coverage.count, 'situation')}, ${coverage.sinceLastTouch} since last touch${coverage.starved ? ', starved' : ''}.`
				: '',
			'',
			situations.length === 0
				? '_No situations tagged yet._'
				: situations.map(s => `- [[${s.id}]]`).join('\n'),
		]
			.filter(line => line !== '')
			.join('\n');
	});

	const totalCount = pillar?.count ?? 0;
	const starvedCount = pillar?.subthemes.filter(s => s.starved).length ?? 0;

	const summary = `${plural(theme.subthemes.length, 'subtheme')}, ${plural(totalCount, 'situation')} tagged, ${plural(starvedCount, 'starved subtheme')}`;

	const body = [
		`# ${theme.name ?? theme.id}`,
		'',
		BANNER,
		'',
		authorSection(
			project.vault.root,
			VAULT.themes,
			theme.id,
			`${VAULT.themes}/${theme.id}.md`,
		),
		'',
		subthemeSections.join('\n\n'),
		'',
		'Back to [[index]].',
		'',
	].join('\n');

	return {
		path: `${VAULT.wiki}/themes/${theme.id}.md`,
		kind: 'theme',
		id: theme.id,
		title: theme.name ?? theme.id,
		summary,
		body,
	};
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function buildIndexPage(pages: readonly WikiPage[]): WikiPage {
	const byKind = new Map<Exclude<WikiKind, 'index'>, WikiPage[]>();
	for (const page of pages) {
		const kind = page.kind as Exclude<WikiKind, 'index'>;
		const list = byKind.get(kind);
		if (list) {
			list.push(page);
		} else {
			byKind.set(kind, [page]);
		}
	}

	const sections = KIND_ORDER.flatMap(kind => {
		// Title order is right for a cast list and wrong for a timeline: sorting
		// moments alphabetically puts the Ascension Threshold before the Substrate
		// Patch, which is not a cosmetic complaint about an index — it is the page
		// stating the sequence backwards.
		const entries = (byKind.get(kind) ?? []).toSorted((a, b) => {
			if (a.sortKey !== b.sortKey) {
				if (a.sortKey === undefined) {
					return 1;
				}
				if (b.sortKey === undefined) {
					return -1;
				}
				return compareInstants(a.sortKey, b.sortKey);
			}
			return a.title.localeCompare(b.title);
		});
		if (entries.length === 0) {
			return [];
		}
		return [
			'',
			`## ${capitalize(kind)}s (${entries.length})`,
			'',
			// The link target has to be the page id, because that is the filename a
			// wikilink resolves against — but the id is a slug, and an index that
			// shows slugs tells the author "system" about a thing they named The
			// Lathe. Obsidian's alias form gives both: real target, real name.
			...entries.map(page =>
				page.title.toLowerCase() === page.id.toLowerCase()
					? `- [[${page.id}]] — ${page.summary}`
					: `- [[${page.id}|${page.title}]] — ${page.summary}`,
			),
		];
	});

	const body = [`# Wiki index`, '', BANNER, '', ...sections, ''].join('\n');

	return {
		path: `${VAULT.wiki}/index.md`,
		kind: 'index',
		id: 'index',
		title: 'Wiki index',
		summary: `${plural(pages.length, 'page')} across ${plural(byKind.size, 'kind')}`,
		body,
	};
}

// ---------------------------------------------------------------------------

/**
 * Every page is computed: what the corpus says, cross-referenced with what the
 * ledger replayed (§4, types.ts). One recompute over the whole vault, the same
 * `computeProject` discipline `core/project.ts` already uses — a pure function
 * is easier to trust than a cache at this scale.
 */
export function buildWiki(project: Project): Wiki {
	const ctx = buildStepContext(project);

	const systems = project.vault.systems.map(each => buildSystemPage(each, project, ctx));

	const characters = project.vault.characters
		.toSorted((a, b) => a.id.localeCompare(b.id))
		.map(character => buildCharacterPage(character, project, ctx));

	const places = placeIds(project).map(id => buildPlacePage(id, project, ctx));

	const factions = project.vault.factions
		.toSorted((a, b) => a.id.localeCompare(b.id))
		.map(faction => buildFactionPage(faction, project));

	const moments = project.vault.moments
		.toSorted((a, b) => a.id.localeCompare(b.id))
		.map(moment => buildMomentPage(moment, project, ctx));

	const artifacts = project.vault.artifacts
		.toSorted((a, b) => a.id.localeCompare(b.id))
		.map(artifact => buildArtifactPage(artifact, project, ctx));

	const skills = [...allSkillIds(project, ctx)]
		.toSorted()
		.map(id => buildSkillPage(id, project, ctx));

	const items = [...allItemIds(ctx)]
		.toSorted()
		.map(id => buildItemPage(id, project, ctx));

	const arcs = project.vault.arcs
		.toSorted((a, b) => a.id.localeCompare(b.id))
		.map(arc => buildArcPage(arc, project, ctx));

	const situations = project.vault.situations
		.toSorted((a, b) => a.id.localeCompare(b.id))
		.map(situation => buildSituationPage(situation, project, ctx));

	const themes = project.vault.themes
		.toSorted((a, b) => a.id.localeCompare(b.id))
		.map(theme => buildThemePage(theme, project));

	const pages = [
		...systems,
		...characters,
		...places,
		...factions,
		...moments,
		...artifacts,
		...skills,
		...items,
		...arcs,
		...situations,
		...themes,
	];

	return {pages: [...pages, buildIndexPage(pages)]};
}
