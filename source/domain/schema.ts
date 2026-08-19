import {z} from 'zod';
import {toInstant} from '../time/instant.js';

/** Ids are the wikilink target and the filename stem, so keep them slug-safe. */
export const idSchema = z
	.string()
	.min(1)
	.regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are lowercase kebab-case');

/**
 * Marks a page raised by one interview but belonging to another's domain.
 *
 * A `/system` interview that establishes a faction, a place, or a turning point
 * has produced real corpus — it just landed outside the interview's own target
 * files. Rather than lose it, spillover writes a minimal page and flags it, so
 * the fact survives, the graph connects, and the next interview can see there
 * is something here that nobody has been asked about yet.
 *
 * It is deliberately not a status enum: a stub is not a lesser page, it is a
 * page whose interview has not happened. Clearing the flag is the author's, and
 * nothing in the tool treats a stub differently except the checks that say so.
 */
const stubFlag = z.boolean().default(false);

// ---------------------------------------------------------------------------
// System — author-owned game rules (§3)
// ---------------------------------------------------------------------------

export const statDefSchema = z.object({
	id: idSchema,
	name: z.string().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	default: z.number().default(0),
	/** When false (the default), a negative value raises an open question. */
	allow_negative: z.boolean().default(false),
});

export const skillDefSchema = z.object({
	id: idSchema,
	name: z.string().optional(),
	requires_skills: z.array(idSchema).default([]),
	requires_level: z.number().int().optional(),
});

/**
 * Replay walks `1..max_level` to derive a level from XP, so this number is a
 * loop bound, not a display value. It is also model-written — an extraction
 * fills `system/curves.md` — so it is capped here rather than trusted. A curve
 * claiming a million levels is not an ambitious LitRPG, it is an hours-long
 * hang the author cannot interrupt.
 */
export const MAX_LEVEL_CEILING = 10_000;

export const curvesSchema = z.object({
	/** Formula id resolving total XP required to reach a level. */
	xp_for_level: z.string().default('xp-for-level'),
	max_level: z.number().int().positive().max(MAX_LEVEL_CEILING).default(100),
});

/**
 * Id a vault's original single system loads under.
 *
 * `system/stats.md` and friends predate systems being a primitive, so they are
 * read as one system named this. A character that names no system is placed in
 * it when it is the only one, which is what keeps every vault written before
 * this change working untouched.
 */
export const DEFAULT_SYSTEM_ID = 'system';

/**
 * A *character system*: the thing that tracks and manages a character's stats.
 *
 * A vault may hold several — the Seed and the Custodian working alongside each
 * other for different purposes — but a character is under exactly one at a time.
 * That single constraint is what keeps `level`, `xp`, and `stats` flat scalars
 * rather than maps keyed by system: there is only ever one answer to "what is
 * their vitality". Moving between systems is a `port` event, never a silent edit,
 * so the moment it happens is in the ledger where the story can see it.
 */
export const systemSchema = z.object({
	id: idSchema.default(DEFAULT_SYSTEM_ID),
	name: z.string().optional(),
	stats: z.array(statDefSchema).default([]),
	skills: z.array(skillDefSchema).default([]),
	curves: curvesSchema.default({xp_for_level: 'xp-for-level', max_level: 100}),
	stub: stubFlag,
});

// ---------------------------------------------------------------------------
// Ledger events (§6.2)
// ---------------------------------------------------------------------------

const eventBase = {actor: idSchema, note: z.string().optional()};

export const ledgerEventSchema = z.discriminatedUnion('type', [
	z.object({...eventBase, type: z.literal('xp'), value: z.number()}),
	z.object({...eventBase, type: z.literal('acquire_skill'), skill: idSchema}),
	z.object({...eventBase, type: z.literal('lose_skill'), skill: idSchema}),
	z.object({
		...eventBase,
		type: z.literal('stat'),
		stat: idSchema,
		delta: z.number().optional(),
		value: z.number().optional(),
	}),
	z.object({
		...eventBase,
		type: z.literal('item_gain'),
		item: idSchema,
		qty: z.number().int().default(1),
	}),
	z.object({
		...eventBase,
		type: z.literal('item_lose'),
		item: idSchema,
		qty: z.number().int().default(1),
	}),
	z.object({...eventBase, type: z.literal('level_set'), value: z.number().int()}),
	/**
	 * Moves a character into another character system.
	 *
	 * Deliberately an event rather than a frontmatter edit: which system someone
	 * is under changes what their numbers *mean*, so the story needs to know when
	 * it changed, not merely that it did. Replay re-seeds any stat the new system
	 * declares that they lack, keeps the ones it does not declare rather than
	 * discarding the author's data, and re-derives the level from the XP they
	 * already have under the new curve.
	 */
	z.object({...eventBase, type: z.literal('port'), system: idSchema}),
	z.object({...eventBase, type: z.literal('acquire_artifact'), artifact: idSchema}),
	z.object({...eventBase, type: z.literal('lose_artifact'), artifact: idSchema}),
	/**
	 * The verb that separates an artifact from a possession. Acquiring a rifle is
	 * inventory; firing it is a scene, and the ledger should be able to say which
	 * scene, so a reader can ask what a thing has actually been *for*.
	 */
	z.object({...eventBase, type: z.literal('use_artifact'), artifact: idSchema}),
	z.object({
		...eventBase,
		type: z.literal('flag'),
		key: z.string(),
		value: z.union([z.string(), z.number(), z.boolean()]),
	}),
]);

// ---------------------------------------------------------------------------
// Timeline (§5)
// ---------------------------------------------------------------------------

/**
 * A moment: a point on the in-world clock where the terms of the world change.
 *
 * Named for what it is rather than what it contains — "moment" described a
 * row in a list, and a moment is a thing an author interviews about, shows, and
 * extracts into on its own. Arcs anchor to them by id.
 */
/**
 * A point on the in-world clock: whole seconds from the vault's origin.
 *
 * Accepts a plain YAML integer as well as a bigint so timelines written before
 * the clock was widened keep loading, and refuses a number that is already
 * outside the exactly-representable range — see `toInstant`.
 */
export const instantSchema = z
	.custom<bigint>(value => toInstant(value) !== undefined, {
		message: `not a whole number of seconds within ±1 trillion years of the origin`,
	})
	.transform(value => toInstant(value)!);

export const momentSchema = z.object({
	id: idSchema,
	name: z.string().optional(),
	/**
	 * Absolute position on the in-world clock. Absent means undated — the event
	 * is recorded but not placed, exactly as a situation with no arc is (§5).
	 * `buildSequence` skips it and `runChecks` raises it, because a replay that
	 * guessed a position would be worse than one that says it does not know.
	 */
	at: instantSchema.optional(),
	events: z.array(ledgerEventSchema).default([]),
	stub: stubFlag,
});

export const milestoneSchema = z.object({
	level: z.number().int().optional(),
	has_skills: z.array(idSchema).default([]),
	stats: z.record(z.string(), z.number()).default({}),
});

export const arcSchema = z.object({
	id: idSchema,
	name: z.string().optional(),
	/** Absent means unplaced; it replays last, ties broken by id (D3). */
	order: z.number().int().optional(),
	starts_after: idSchema.optional(),
	ends_before: idSchema.optional(),
	/** Per-character intended power checkpoint; drives milestone drift (§5). */
	milestone: z.record(idSchema, milestoneSchema).default({}),
	stub: stubFlag,
});

// ---------------------------------------------------------------------------
// Situations (§6.1)
// ---------------------------------------------------------------------------

export const situationSchema = z.object({
	id: idSchema,
	title: z.string().optional(),
	/** Absent means unplaced — a valid permanent state (§5). */
	arc: idSchema.optional(),
	order: z.number().int().optional(),
	/**
	 * Where on the in-world clock this scene sits.
	 *
	 * Absent is the common case and not a defect: a situation inherits the last
	 * moment before it in the replay sequence, so an author who has ordered their
	 * arcs has already said when every scene happens. Writing it here pins the
	 * scene to a moment explicitly — worth doing for a flashback, or wherever
	 * narrative order and clock order disagree.
	 *
	 * It never reorders anything. Sequence comes from arc order and intra-arc
	 * order (§5); this names the clock position, which is what every character
	 * state in the scene is addressed by.
	 */
	moment: idSchema.optional(),
	characters: z.array(idSchema).default([]),
	place: idSchema.optional(),
	themes: z.array(idSchema).default([]),
	events: z.array(ledgerEventSchema).default([]),
	stub: stubFlag,
});

// ---------------------------------------------------------------------------
// Themes (§8) and characters
// ---------------------------------------------------------------------------

export const subthemeSchema = z.object({
	id: idSchema,
	name: z.string().optional(),
	description: z.string().optional(),
	tension: z.array(z.string()).default([]),
});

export const themeSchema = z.object({
	id: idSchema,
	name: z.string().optional(),
	subthemes: z.array(subthemeSchema).default([]),
	stub: stubFlag,
});

export const characterSchema = z.object({
	id: idSchema,
	name: z.string().optional(),
	level: z.number().int().default(1),
	xp: z.number().default(0),
	stats: z.record(z.string(), z.number()).default({}),
	skills: z.array(idSchema).default([]),
	items: z.record(z.string(), z.number()).default({}),
	/** Artifacts they start with; the ledger carries every change after that. */
	artifacts: z.array(idSchema).default([]),
	/**
	 * The character system tracking them. Optional because a vault with exactly
	 * one system has only one answer; with several, leaving it out is an open
	 * question rather than a guess.
	 */
	system: idSchema.optional(),
	stub: stubFlag,
});

// ---------------------------------------------------------------------------
// Factions
// ---------------------------------------------------------------------------

/**
 * People who act together toward a goal.
 *
 * The goal is the defining field, not the name: two people with a shared aim
 * are a faction and a crowd is not. It stays optional anyway, because the
 * alternative is a schema that rejects the page rather than one that asks — an
 * interview establishes that the Assessors exist long before it establishes what
 * they want, and losing the first fact while waiting for the second is the
 * failure this whole primitive was added to prevent. `runChecks` raises the gap.
 *
 * Members are character ids rather than prose so the graph is real: the wiki
 * back-links them, and a member with no character page is a reported broken
 * reference instead of a name that only ever existed inside one paragraph.
 */
export const factionSchema = z.object({
	id: idSchema,
	name: z.string().optional(),
	/** What they are working toward, in the author's words. */
	goal: z.string().optional(),
	/** Character ids. A member without a page is reported, never invented. */
	members: z.array(idSchema).default([]),
	stub: stubFlag,
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * Something a character uses to achieve an outcome.
 *
 * Genre-neutral by construction: under an arcane idiom this is a spell, a suit
 * of armour, a relic; under a technological one it is an M1A rifle, a mass
 * spectrometer, an iPad. The engine holds none of that vocabulary — the profile
 * lexicon supplies the word, exactly as it already does for `ability`.
 *
 * Distinct from a ledger *item*, which has no page and exists only as a running
 * count from `item_gain`/`item_lose`: five potions are an item, the rifle you
 * carry through the whole book is an artifact. The difference that matters is
 * `outcome` — an item is a quantity, an artifact is a means to an end.
 *
 * A character may use many, so ownership lives in the ledger rather than here:
 * `artifacts` on a character page is where they start, and `acquire_artifact`,
 * `lose_artifact` and `use_artifact` are what happen afterwards. That is the
 * same shape skills already have, for the same reason — the story is when.
 */
export const artifactSchema = z.object({
	id: idSchema,
	name: z.string().optional(),
	/** What it is in this world's own terms: 'spell', 'rifle', 'microscope'. */
	kind: z.string().optional(),
	/** What using it achieves. The defining field — a thing with no outcome is scenery. */
	outcome: z.string().optional(),
	/** Skills a character needs before it will work for them. */
	requires_skills: z.array(idSchema).default([]),
	requires_level: z.number().int().optional(),
	stub: stubFlag,
});

// ---------------------------------------------------------------------------
// Chapters (§6 step 6 — assembly)
// ---------------------------------------------------------------------------

/**
 * A chapter is a *cut* in the replay sequence, not a list of scenes.
 *
 * `buildSequence` already produces the canonical reading order, so a chapter
 * only has to say where it opens; it runs until the next chapter opens. That
 * makes membership derived rather than stored, which is what stops a scene
 * being claimed by two chapters or by none, and means a situation inserted
 * mid-arc lands in the right chapter without anyone editing a manifest.
 */
export const chapterSchema = z.object({
	id: idSchema,
	title: z.string().optional(),
	/** D3: sparse integers, same convention as arcs and situations. */
	order: z.number().int(),
	/** The situation this chapter opens on. */
	starts_at: idSchema,
});

export type StatDef = z.infer<typeof statDefSchema>;
export type SkillDef = z.infer<typeof skillDefSchema>;
export type Curves = z.infer<typeof curvesSchema>;
export type SystemDef = z.infer<typeof systemSchema>;
export type LedgerEvent = z.infer<typeof ledgerEventSchema>;
export type Moment = z.infer<typeof momentSchema>;
export type Milestone = z.infer<typeof milestoneSchema>;
export type Arc = z.infer<typeof arcSchema>;
export type Situation = z.infer<typeof situationSchema>;
export type Subtheme = z.infer<typeof subthemeSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type Character = z.infer<typeof characterSchema>;
export type Faction = z.infer<typeof factionSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Chapter = z.infer<typeof chapterSchema>;
