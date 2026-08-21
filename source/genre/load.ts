import {readFile} from 'node:fs/promises';
import {parseDocument} from '../vault/frontmatter.js';
import {resolve, VAULT} from '../vault/paths.js';
import {applyLexicon, lexiconBriefing} from './lexicon.js';
import {BUILT_IN_PROFILES, resolveProfile} from './profiles.js';
import {
	profileSchema,
	settingSchema,
	type Profile,
	type ResolvedProfile,
	type Setting,
} from './types.js';

export type SettingContext = {
	readonly setting: Setting;
	readonly profile: ResolvedProfile;
	/** Vocabulary block for prompt assembly; empty for `base`. */
	readonly briefing: string;
	/** True when the vault supplied its own `system/idiom.md`. */
	readonly overridden: boolean;
	readonly issues: readonly string[];
};

async function readIfPresent(file: string): Promise<string | undefined> {
	return readFile(file, 'utf8').catch(() => undefined);
}

/**
 * Loads the vault's setting: descriptors from `system/system.md`, plus the
 * resolved profile.
 *
 * A vault may override the shipped profile at `system/idiom.md` — author edits
 * win, the profile is a default layer (§3.2). The override is merged as if it
 * were a child profile, so it need only state the keys it changes.
 */
export async function loadSetting(root: string): Promise<SettingContext> {
	const issues: string[] = [];

	// Both homes: `setting/` is where it lives now, `system/system.md` is where
	// every vault written before the layout change still has it.
	const settingRaw =
		(await readIfPresent(resolve(root, VAULT.settingFile))) ??
		(await readIfPresent(resolve(root, VAULT.legacySettingFile)));
	let setting: Setting = settingSchema.parse({});
	if (settingRaw !== undefined) {
		const parsed = settingSchema.safeParse(parseDocument(settingRaw).data);
		if (parsed.success) {
			setting = parsed.data;
		} else {
			issues.push(
				`${VAULT.settingFile}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
			);
		}
	}

	const available = new Map<string, Profile>(BUILT_IN_PROFILES);
	let overridden = false;

	const idiomRaw =
		(await readIfPresent(resolve(root, VAULT.idiom))) ??
		(await readIfPresent(resolve(root, VAULT.legacyIdiom)));
	if (idiomRaw !== undefined) {
		const {data} = parseDocument(idiomRaw);
		// `/init` ships this file with every key commented out, so its mere
		// existence is not an override — only a key that actually declares
		// something counts. Otherwise a scaffolded vault would resolve to a
		// phantom `<idiom>-local` profile it never asked for.
		const declares = ['lexicon', 'archetypes', 'register', 'status_template', 'id'].some(
			key => data[key] !== undefined,
		);
		if (!declares) {
			const profile = resolveProfile(setting.idiom, available);
			return {
				setting,
				profile,
				briefing: lexiconBriefing(profile),
				overridden: false,
				issues,
			};
		}

		// An override that names no id customises the vault's selected idiom;
		// one that names an id defines a new profile the vault can select.
		const candidate = {
			extends: setting.idiom,
			...data,
			id: typeof data['id'] === 'string' ? data['id'] : `${setting.idiom}-local`,
			name: typeof data['name'] === 'string' ? data['name'] : 'Vault override',
		};
		const parsed = profileSchema.safeParse(candidate);
		if (parsed.success) {
			available.set(parsed.data.id, parsed.data);
			overridden = true;
			setting = {...setting, idiom: parsed.data.id};
		} else {
			issues.push(`${VAULT.idiom}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
		}
	}

	const profile = resolveProfile(setting.idiom, available);
	if (profile.chain.length === 0) {
		issues.push(`unknown idiom '${setting.idiom}' — falling back to base`);
	}

	return {
		setting,
		profile,
		briefing: lexiconBriefing(profile),
		overridden,
		issues,
	};
}

export {applyLexicon};
