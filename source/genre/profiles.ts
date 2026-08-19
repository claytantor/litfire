import {profileSchema, type Profile, type ResolvedProfile} from './types.js';

/**
 * The launch profiles (§3.3), shipped as data.
 *
 * They live in TypeScript rather than loose markdown so the published binary is
 * self-contained — `tsup` bundles to a single file, and resolving a sibling
 * `profiles/` directory at runtime is fragile. This costs nothing in spirit:
 * a profile is still pure data with no logic, and the authorable layer is the
 * per-vault override at `system/idiom.md`, which is markdown as specified.
 */
const BUILT_IN: readonly Profile[] = [
	profileSchema.parse({
		id: 'base',
		name: 'Neutral',
		lexicon: {},
		archetypes: {
			stats: ['strength', 'agility', 'constitution', 'intellect', 'will'],
			resources: ['stamina'],
		},
		status_template: 'inline',
		register:
			'Plain and unadorned. Do not reach for a genre idiom the author has not chosen.',
	}),
	profileSchema.parse({
		id: 'arcane',
		name: 'Arcane / Fantasy',
		extends: 'base',
		lexicon: {
			resource: 'mana',
			resource_plural: 'mana',
			ability: 'spell',
			ability_group: 'school',
			artifact: 'relic',
			artifact_plural: 'relics',
			role: 'class',
			space: 'dungeon',
			threat: 'monster',
			upgrade: 'enchantment',
			currency: 'gold',
			advancement: 'level',
		},
		archetypes: {
			stats: ['strength', 'agility', 'constitution', 'intellect', 'will'],
			resources: ['mana', 'stamina'],
		},
		status_template: 'sheet',
		interview_overlay: 'arcane',
		register:
			'Concrete and physical. Magic has practitioners, traditions, and people who got it wrong. Avoid the ineffable unless the author reaches for it.',
	}),
	profileSchema.parse({
		id: 'technological',
		name: 'Technological / SF',
		extends: 'base',
		lexicon: {
			resource: 'charge',
			resource_plural: 'charge',
			ability: 'protocol',
			ability_group: 'stack',
			artifact: 'device',
			artifact_plural: 'devices',
			role: 'loadout',
			space: 'deck',
			threat: 'construct',
			upgrade: 'augment',
			currency: 'credits',
			advancement: 'iteration',
		},
		archetypes: {
			stats: ['integrity', 'processing', 'bandwidth', 'resilience', 'interface'],
			resources: ['charge', 'heat'],
		},
		status_template: 'hud',
		interview_overlay: 'sf',
		register:
			'Technical but not jargon-dense. Systems have engineers, owners, and maintenance costs. Everything has an explanation and somebody who maintains it, unless the author says otherwise.',
	}),
];

export const BUILT_IN_PROFILES: ReadonlyMap<string, Profile> = new Map(
	BUILT_IN.map(profile => [profile.id, profile]),
);

export function listProfiles(extra: ReadonlyMap<string, Profile> = new Map()): Profile[] {
	return [...new Map([...BUILT_IN_PROFILES, ...extra]).values()];
}

function parents(profile: Profile): string[] {
	if (profile.extends === undefined) {
		return [];
	}
	return typeof profile.extends === 'string' ? [profile.extends] : profile.extends;
}

/**
 * Flattens the `extends` chain, later entries winning.
 *
 * A list parent is the blend mechanism for science-fantasy: `extends:
 * [arcane, technological]` takes arcane as the base and lets technological
 * override the keys it defines. Cycles resolve to the first visit rather than
 * throwing — a malformed profile should not stop an author working.
 */
export function resolveProfile(
	id: string,
	available: ReadonlyMap<string, Profile>,
): ResolvedProfile {
	const chain: string[] = [];
	const seen = new Set<string>();

	const merged: Profile = {
		id,
		name: id,
		lexicon: {},
		archetypes: {stats: [], resources: []},
		status_template: 'inline',
	};

	const visit = (candidate: string): void => {
		if (seen.has(candidate)) {
			return;
		}
		seen.add(candidate);

		const profile = available.get(candidate);
		if (!profile) {
			return;
		}

		// Depth first: a parent's values are applied before the child's, so the
		// child wins on every key it defines.
		for (const parent of parents(profile)) {
			visit(parent);
		}

		chain.push(profile.id);
		merged.id = profile.id;
		merged.name = profile.name;
		merged.lexicon = {...merged.lexicon, ...profile.lexicon};
		merged.archetypes = {
			stats: profile.archetypes.stats.length
				? profile.archetypes.stats
				: merged.archetypes.stats,
			resources: profile.archetypes.resources.length
				? profile.archetypes.resources
				: merged.archetypes.resources,
		};
		merged.status_template = profile.status_template;
		if (profile.interview_overlay !== undefined) {
			merged.interview_overlay = profile.interview_overlay;
		}
		if (profile.register !== undefined) {
			merged.register = profile.register;
		}
	};

	visit(id);

	// An unknown idiom falls back to base rather than failing: §9 requires that
	// declining to choose stays a supported path, and a typo should behave the
	// same way.
	if (chain.length === 0) {
		const base = available.get('base');
		if (base) {
			return {...base, chain: ['base']};
		}
	}

	return {...merged, chain};
}
