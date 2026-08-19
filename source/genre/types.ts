import {z} from 'zod';

/**
 * Setting descriptors (§3.1). Deliberately not a genre enum — they describe the
 * design space more usefully than a binary would, and the interview branches on
 * them.
 */
export const systemOriginSchema = z.enum([
	'divine',
	'arcane',
	'technological',
	'simulated',
	'emergent',
	'unexplained',
]);

export const systemVisibilitySchema = z.enum([
	'character',
	'universal',
	'privileged',
	'reader-only',
]);

export const systemAgencySchema = z.enum(['agent', 'bureaucracy', 'physics', 'unknown']);

export type SystemOrigin = z.infer<typeof systemOriginSchema>;
export type SystemVisibility = z.infer<typeof systemVisibilitySchema>;
export type SystemAgency = z.infer<typeof systemAgencySchema>;

/**
 * The lexicon is presentation and prompting only (§4). Canonical keys are what
 * live on disk; these are the display terms resolved at render time, which is
 * what lets a profile change re-render the whole corpus without migrating a
 * single file.
 */
export const lexiconSchema = z.object({
	resource: z.string().optional(),
	resource_plural: z.string().optional(),
	ability: z.string().optional(),
	ability_group: z.string().optional(),
	/** What this idiom calls a thing a character uses: relic, device, tool. */
	artifact: z.string().optional(),
	artifact_plural: z.string().optional(),
	role: z.string().optional(),
	space: z.string().optional(),
	threat: z.string().optional(),
	upgrade: z.string().optional(),
	currency: z.string().optional(),
	advancement: z.string().optional(),
});

export type Lexicon = z.infer<typeof lexiconSchema>;

export const archetypesSchema = z.object({
	stats: z.array(z.string()).default([]),
	resources: z.array(z.string()).default([]),
});

/**
 * A setting profile. Supplies vocabulary, overlays, templates, and archetypes —
 * and no logic. §2 is normative: if a proposed feature would change how state
 * is computed, it is an engine feature, not a profile feature.
 */
export const profileSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	/**
	 * A single parent, or a list for blends with later entries winning (§3.3).
	 * Science-fantasy is a large share of the market, so the blend path is
	 * designed at launch rather than retrofitted.
	 */
	extends: z.union([z.string(), z.array(z.string())]).optional(),
	lexicon: lexiconSchema.default({}),
	archetypes: archetypesSchema.default({stats: [], resources: []}),
	status_template: z.enum(['sheet', 'hud', 'inline']).default('inline'),
	interview_overlay: z.string().optional(),
	/** Tone guidance appended to interview prompts. */
	register: z.string().optional(),
});

export type Profile = z.infer<typeof profileSchema>;

/** A profile with its `extends` chain already flattened. */
export type ResolvedProfile = Profile & {
	/** Ids applied, base first, in the order they were merged. */
	readonly chain: readonly string[];
};

export const settingSchema = z.object({
	system_origin: systemOriginSchema.optional(),
	system_visibility: systemVisibilitySchema.optional(),
	system_agency: systemAgencySchema.optional(),
	/** Profile id; `base` when the author declined to choose. */
	idiom: z.string().default('base'),
});

export type Setting = z.infer<typeof settingSchema>;

/** Human-readable notes used by `/init` and `/idiom`. */
export const ORIGIN_NOTE: Readonly<Record<SystemOrigin, string>> = {
	divine: 'granted by something that chose to grant it',
	arcane: 'a discovered property of the world',
	technological: 'built, owned, and maintained by someone',
	simulated: 'a layer over a world that is running on something',
	emergent: 'nobody built it; it arose',
	unexplained: 'deliberately unanswered — a real choice, not a default',
};

export const VISIBILITY_NOTE: Readonly<Record<SystemVisibility, string>> = {
	character: 'the character sees their own sheet',
	universal: 'everyone sees everything',
	privileged: 'only some people see the numbers',
	'reader-only': 'the reader sees the sheet; the character does not',
};

export const AGENCY_NOTE: Readonly<Record<SystemAgency, string>> = {
	agent: 'it wants things and can be surprised',
	bureaucracy: 'it follows its own rules, indifferently',
	physics: 'it is a law, not a mind',
	unknown: 'nobody in the story knows',
};
