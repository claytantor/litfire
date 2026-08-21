import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	BUILT_IN_PROFILES,
	applyLexicon,
	lexiconBriefing,
	listProfiles,
	loadSetting,
	overlayFor,
	profileSchema,
	resolveProfile,
	term,
	type Profile,
} from '../source/genre/index.js';
import {composeSystemPrompt} from '../source/interview/index.js';
import {stringifyDocument} from '../source/vault/frontmatter.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-genre-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

describe('launch profiles', () => {
	it('ships base, arcane, and technological', () => {
		expect(
			listProfiles()
				.map(p => p.id)
				.toSorted(),
		).toEqual(['arcane', 'base', 'technological']);
	});

	it('gives arcane and technological distinct vocabulary', () => {
		const arcane = resolveProfile('arcane', BUILT_IN_PROFILES);
		const tech = resolveProfile('technological', BUILT_IN_PROFILES);

		expect(term(arcane, 'resource')).toBe('mana');
		expect(term(tech, 'resource')).toBe('charge');
		expect(term(arcane, 'space')).toBe('dungeon');
		expect(term(tech, 'space')).toBe('deck');
	});

	it('base makes no substitutions but still resolves a term', () => {
		const base = resolveProfile('base', BUILT_IN_PROFILES);

		expect(base.lexicon.resource).toBeUndefined();
		expect(term(base, 'resource')).toBe('resource');
		expect(lexiconBriefing(base)).toBe('');
	});

	/** §2 is normative: a profile supplies data, never logic. */
	it('carries no executable anything', () => {
		for (const profile of listProfiles()) {
			for (const value of Object.values(profile)) {
				expect(typeof value).not.toBe('function');
			}
		}
	});
});

describe('extends resolution', () => {
	it('inherits from a parent and overrides only what it defines', () => {
		const tech = resolveProfile('technological', BUILT_IN_PROFILES);

		expect(tech.chain).toEqual(['base', 'technological']);
		expect(tech.lexicon.resource).toBe('charge');
	});

	/** §3.3: blends are the science-fantasy case, designed for at launch. */
	it('blends a list parent with later entries winning', () => {
		const available = new Map<string, Profile>(BUILT_IN_PROFILES);
		available.set(
			'science-fantasy',
			profileSchema.parse({
				id: 'science-fantasy',
				name: 'Science Fantasy',
				extends: ['arcane', 'technological'],
				lexicon: {threat: 'anomaly'},
			}),
		);

		const blend = resolveProfile('science-fantasy', available);

		// technological is applied after arcane, so it wins on shared keys...
		expect(term(blend, 'resource')).toBe('charge');
		expect(term(blend, 'space')).toBe('deck');
		// ...arcane keys it does not define survive...
		expect(term(blend, 'currency')).toBe('credits');
		// ...and the blend's own keys beat both parents.
		expect(term(blend, 'threat')).toBe('anomaly');
		expect(blend.chain).toEqual(['base', 'arcane', 'technological', 'science-fantasy']);
	});

	it('falls back to base for an unknown idiom rather than failing', () => {
		const resolved = resolveProfile('does-not-exist', BUILT_IN_PROFILES);
		expect(resolved.id).toBe('base');
	});

	it('survives a cycle instead of hanging', () => {
		const available = new Map<string, Profile>(BUILT_IN_PROFILES);
		available.set('a', profileSchema.parse({id: 'a', name: 'A', extends: 'b'}));
		available.set('b', profileSchema.parse({id: 'b', name: 'B', extends: 'a'}));

		expect(resolveProfile('a', available).chain).toContain('a');
	});
});

describe('lexicon substitution', () => {
	it('replaces placeholders with the profile term', () => {
		const arcane = resolveProfile('arcane', BUILT_IN_PROFILES);
		expect(applyLexicon('spend 40 {{resource}} in the {{space}}', arcane)).toBe(
			'spend 40 mana in the dungeon',
		);
	});

	it('renders the same stored text differently per profile', () => {
		const stored = 'spend 40 {{resource}}';
		expect(applyLexicon(stored, resolveProfile('arcane', BUILT_IN_PROFILES))).toBe(
			'spend 40 mana',
		);
		expect(applyLexicon(stored, resolveProfile('technological', BUILT_IN_PROFILES))).toBe(
			'spend 40 charge',
		);
	});

	it('leaves an unknown placeholder visible rather than blanking it', () => {
		const base = resolveProfile('base', BUILT_IN_PROFILES);
		expect(applyLexicon('a {{nonsense}} b', base)).toBe('a {{nonsense}} b');
	});
});

describe('interview overlays', () => {
	const setting = {idiom: 'technological'} as const;

	it('appends the sf overlay to /system without removing the base brief', () => {
		const tech = resolveProfile('technological', BUILT_IN_PROFILES);
		const overlay = overlayFor('system', tech, setting, lexiconBriefing(tech));
		const prompt = composeSystemPrompt('system', '', overlay);

		// Base brief survives intact...
		expect(prompt).toContain('Do not start with mechanics. Start with meaning.');
		// ...and the overlay is added after it.
		expect(prompt).toContain('who pays for its upkeep');
		expect(prompt.indexOf('who pays for its upkeep')).toBeGreaterThan(
			prompt.indexOf('Start with meaning'),
		);
	});

	it('gives arcane a different overlay from technological', () => {
		const arcane = resolveProfile('arcane', BUILT_IN_PROFILES);
		const tech = resolveProfile('technological', BUILT_IN_PROFILES);

		const a = overlayFor('system', arcane, {idiom: 'arcane'}, '');
		const t = overlayFor('system', tech, setting, '');

		expect(a).toContain('folk version of the System');
		expect(a).not.toContain('who pays for its upkeep');
		expect(t).toContain('who pays for its upkeep');
		expect(t).not.toContain('folk version of the System');
	});

	/**
	 * §5 cross-cutting: both questions belong to every idiom, so they live in the
	 * base brief. Carrying them in the overlay meant a vault that chose no profile
	 * silently lost two questions it needed.
	 */
	it('asks the two cross-cutting questions in every idiom, profile or not', () => {
		for (const id of ['base', 'arcane', 'technological']) {
			const profile = resolveProfile(id, BUILT_IN_PROFILES);
			const prompt = composeSystemPrompt(
				'system',
				'',
				overlayFor('system', profile, {idiom: id}, ''),
			);
			expect(prompt).toContain('Who can see the numbers');
			expect(prompt).toContain('What does the System want?');
		}

		// And with no overlay at all, which is the case the old wiring missed.
		expect(composeSystemPrompt('system', '')).toContain('Who can see the numbers');
	});

	/**
	 * An overlay describes its own idiom and never the neighbouring one. Defining
	 * SF as "not magic" injects the arcane idiom into an SF vault's prompt just as
	 * surely as putting it in the base brief would — and it is worse there,
	 * because the author explicitly chose a setting and got told about a different
	 * one anyway.
	 */
	it('neither overlay defines itself by negating the other', () => {
		const surfaceFor = (id: string) => {
			const profile = resolveProfile(id, BUILT_IN_PROFILES);
			return overlayFor('system', profile, {idiom: id}, '').toLowerCase();
		};

		const foreign = (surface: string, words: readonly string[]) =>
			words.filter(word => surface.includes(word));

		expect(
			foreign(surfaceFor('technological'), ['magic', 'mana', 'spell', 'arcane']),
		).toEqual([]);
		expect(
			foreign(surfaceFor('arcane'), ['technolog', 'software', 'firmware', 'machine']),
		).toEqual([]);
	});

	it('only overlays the interview the profile targets', () => {
		const tech = resolveProfile('technological', BUILT_IN_PROFILES);
		const theme = overlayFor('theme', tech, setting, '');

		expect(theme).not.toContain('who pays for its upkeep');
		// The register still applies to every interview.
		expect(theme).toContain('Technical but not jargon-dense');
	});

	it('tells the interviewer that a built System cannot answer "it just works"', () => {
		const tech = resolveProfile('technological', BUILT_IN_PROFILES);
		const overlay = overlayFor(
			'system',
			tech,
			{idiom: 'technological', system_origin: 'technological'},
			'',
		);

		expect(overlay).toContain('is not available as an answer here');
	});

	it('respects a deliberately unexplained origin', () => {
		const base = resolveProfile('base', BUILT_IN_PROFILES);
		const overlay = overlayFor(
			'system',
			base,
			{idiom: 'base', system_origin: 'unexplained'},
			'',
		);

		expect(overlay).toContain('do not press them to explain it');
	});
});

describe('vault setting', () => {
	it('scaffolds the descriptors and idiom reference', async () => {
		await scaffoldVault(root, 'technological');

		const {setting, profile} = await loadSetting(root);
		expect(setting.idiom).toBe('technological');
		expect(profile.name).toBe('Technological / SF');
		expect(term(profile, 'resource')).toBe('charge');
	});

	it('seeds stats from the profile archetypes', async () => {
		await scaffoldVault(root, 'technological');

		const stats = await readFile(path.join(root, VAULT.systems, 'system-01.md'), 'utf8');
		expect(stats).toContain('integrity');
		expect(stats).toContain('bandwidth');
		expect(stats).not.toContain('charisma');
	});

	it('defaults to base when no idiom is chosen', async () => {
		await scaffoldVault(root);

		const {setting, profile} = await loadSetting(root);
		expect(setting.idiom).toBe('base');
		expect(profile.id).toBe('base');
	});

	it('lets a vault override win over the shipped profile', async () => {
		await scaffoldVault(root, 'technological');
		await writeFile(
			path.join(root, VAULT.idiom),
			stringifyDocument({
				data: {lexicon: {resource: 'potential'}},
				body: '\n# Override\n',
			}),
			'utf8',
		);

		const {profile, overridden} = await loadSetting(root);

		expect(overridden).toBe(true);
		// The one overridden term changes...
		expect(term(profile, 'resource')).toBe('potential');
		// ...and everything else still inherits from technological.
		expect(term(profile, 'space')).toBe('deck');
	});

	it('reports a malformed descriptor without failing the load', async () => {
		await scaffoldVault(root, 'base');
		await writeFile(
			path.join(root, VAULT.settingFile),
			stringifyDocument({data: {system_origin: 'nonsense'}, body: '\n'}),
			'utf8',
		);

		const {issues, profile} = await loadSetting(root);

		expect(issues.length).toBeGreaterThan(0);
		expect(profile.id).toBe('base');
	});

	it('loads a setting from a vault that has none', async () => {
		const {setting, profile} = await loadSetting(root);
		expect(setting.idiom).toBe('base');
		expect(profile.id).toBe('base');
	});
});
