import {mkdir, writeFile} from 'node:fs/promises';
import {BUILT_IN_PROFILES, resolveProfile} from '../genre/profiles.js';
import type {ResolvedProfile} from '../genre/types.js';
import {stringifyDocument} from './frontmatter.js';
import {RAW_KINDS, resolve, VAULT, VAULT_DIRECTORIES} from './paths.js';

export type ScaffoldResult = {
	readonly created: readonly string[];
	readonly skipped: readonly string[];
};

const GENERATED_BANNER =
	'> [!warning] Generated file\n> Written by litfire. Hand edits are overwritten on the next recompute.';

/**
 * Seed content is deliberately a small but *connected* world: DoD 1 requires the
 * vault to open in Obsidian with a connected graph, which an empty scaffold
 * would fail. Every page below is reachable by wikilink from `index.md`.
 */
function seedFiles(profile: ResolvedProfile): Record<string, string> {
	const files: Record<string, string> = {};

	// Setting descriptors (§3.1). Written unset except for the idiom, because
	// the author has not been asked the other three yet — the /system interview
	// surfaces them, and a guessed value would be worse than an absent one.
	files[VAULT.settingFile] = stringifyDocument({
		data: {idiom: profile.id},
		body: [
			'',
			'# Setting',
			'',
			`This world's idiom is **${profile.name}**.`,
			'',
			'Three descriptors shape how the interviews press. Leave them unset until',
			'`/system` surfaces them, or fill them in now:',
			'',
			'- `system_origin` — divine · arcane · technological · simulated · emergent · unexplained',
			'- `system_visibility` — character · universal · privileged · reader-only',
			'- `system_agency` — agent · bureaucracy · physics · unknown',
			'',
			'The idiom supplies vocabulary and interview overlays only. It never',
			'changes how state is computed. Override any term in [[idiom]].',
			'',
		].join('\n'),
	});

	// The override file ships commented-out: the shipped profile is the default
	// layer and author edits win (§3.2).
	files[VAULT.idiom] = [
		'---',
		"# Uncomment and edit to override this vault's vocabulary.",
		'# lexicon:',
		`#   resource: ${profile.lexicon.resource ?? 'resource'}`,
		`#   ability: ${profile.lexicon.ability ?? 'ability'}`,
		`#   space: ${profile.lexicon.space ?? 'area'}`,
		'---',
		'',
		'# Idiom override',
		'',
		`Inherits **${profile.name}**. Anything set here wins over the shipped`,
		'profile. Terms are display-only — they never change what is stored on disk,',
		'so changing one re-renders the corpus without migrating a file.',
		'',
	].join('\n');

	files[VAULT.config] = `${JSON.stringify(
		{
			version: 1,
			editor: '$EDITOR',
			provider: {},
			formulaHash: null,
			consentedFormulaHash: null,
		},
		null,
		2,
	)}\n`;

	files[VAULT.stats] = stringifyDocument({
		data: {
			// Seeded from the profile's archetypes — data, not logic.
			stats: profile.archetypes.stats.map(id => ({
				id,
				name: id.charAt(0).toUpperCase() + id.slice(1),
				default: 10,
				min: 0,
			})),
		},
		body: '\n# Stats\n\nAuthor-owned. The tool proposes; you dispose.\n',
	});

	files[VAULT.curves] = stringifyDocument({
		data: {xp_for_level: 'xp-for-level', max_level: 50},
		body: `# Curves\n\n\`xp_for_level\` names a formula in [[formulas]] giving the cumulative XP\nrequired to *be* a level.\n`,
	});

	files[VAULT.skills] = stringifyDocument({
		data: {
			skills: [{id: 'first-ability', name: 'First Ability', requires_skills: []}],
		},
		body: '# Skills\n\nPrerequisites are checked deterministically against [[stats]].\n',
	});

	files[VAULT.formulas] = [
		'# Formulas',
		'',
		'Sandboxed JavaScript. Pure and deterministic — no clock, no randomness, no I/O.',
		'',
		'```js id=xp-for-level',
		'(level) => level <= 10 ? 100 * level ** 2 : 150 * level ** 2;',
		'```',
		'',
		'```js id=max-hp',
		'({ constitution, level }) => 50 + constitution * 8 + level * 12;',
		'```',
		'',
	].join('\n');

	files[VAULT.moments] = stringifyDocument({
		data: {
			example: true,
			world_events: [
				{id: 'we-001', name: 'The System Arrives', at: 0},
				{id: 'we-002', name: 'The Third Floor Opens', at: 100},
			],
		},
		body: '# Moments\n\nFixed anchors on the in-world clock. Referenced by [[arc-01]].\n',
	});

	files[`${VAULT.arcs}/arc-01.md`] = stringifyDocument({
		data: {
			id: 'arc-01',
			name: 'Ground Floor',
			order: 1,
			starts_after: 'we-001',
			ends_before: 'we-002',
			example: true,
			milestone: {protagonist: {level: 3, has_skills: []}},
		},
		body: '\n# Ground Floor\n\n> Scaffold example. Delete `example: true` once this is really your arc.\n\nSpans [[moments|we-001]] → we-002. Characters: [[protagonist]].\n',
	});

	files[`${VAULT.characters}/protagonist.md`] = stringifyDocument({
		data: {
			id: 'protagonist',
			// A placeholder, deliberately not a name. An interviewer that reads a
			// seeded name treats it as the author's character and interviews them
			// about someone they never invented.
			name: '(unnamed protagonist)',
			example: true,
			level: 1,
			xp: 0,
			stats: {strength: 10, constitution: 12, charisma: 8},
			skills: [],
		},
		body: '\n# (unnamed protagonist)\n\n> Scaffold example. Rename the file and delete `example: true` once this\n> is really your character.\n\nStarting state above is author-owned. Narrative below is LLM-maintained.\n\nAppears in [[arc-01]].\n',
	});

	files[`${VAULT.themes}/commodification.md`] = stringifyDocument({
		data: {
			id: 'commodification',
			example: true,
			name: 'The Commodification of Existence',
			subthemes: [
				{
					id: 'planetary-extraction',
					name: 'Planetary Extraction',
					description: 'Living worlds reduced to raw data and exploitable assets.',
					tension: ['living world', 'extractable asset'],
				},
				{
					id: 'monetized-suffering',
					name: 'The Monetization of Suffering',
					description: 'Survival, pain, and death sold as commercial product.',
					tension: ['lived experience', 'sellable product'],
				},
			],
		},
		body: '# The Commodification of Existence\n\nSituations tag sub-themes only. Coverage is informational and never blocks.\n',
	});

	// The filename is the id, with nothing appended: one id, one file.
	files[`${VAULT.situations}/sit-001.md`] = stringifyDocument({
		data: {
			id: 'sit-001',
			title: 'The Arrival',
			arc: 'arc-01',
			order: 10,
			example: true,
			characters: ['protagonist'],
			themes: ['monetized-suffering'],
			events: [
				{actor: 'protagonist', type: 'xp', value: 450, note: 'survived the first hour'},
			],
		},
		body: '\n> Scaffold example. Delete `example: true` once this is really your scene.\n\nProse body. The tool never edits this text.\n\nFeaturing [[protagonist]] in [[arc-01]].\n',
	});

	files[`${VAULT.chapters}/ch-01.md`] = stringifyDocument({
		data: {
			id: 'ch-01',
			title: 'Chapter One',
			order: 1,
			starts_at: 'sit-001',
			example: true,
		},
		body: '\n# Chapter One\n\n> Scaffold example. Delete `example: true` once this is really your chapter.\n\nOpens on [[sit-001]].\n',
	});

	files[VAULT.index] = [
		'---',
		'# Scaffold placeholder: this index lists example pages only. The LLM',
		'# rewrites it as real corpus lands; delete the flag once it does.',
		'example: true',
		'---',
		'',
		'# Index',
		'',
		GENERATED_BANNER,
		'',
		'## System',
		'',
		'- [[system]]',
		'- [[idiom]]',
		'- [[stats]]',
		'- [[curves]]',
		'- [[skills]]',
		'- [[formulas]]',
		'',
		'## Timeline',
		'',
		'- [[moments]]',
		'- [[arc-01]]',
		'',
		'## Characters',
		'',
		'- [[protagonist]]',
		'',
		'## Themes',
		'',
		'- [[commodification]]',
		'',
		'## Situations',
		'',
		'- [[sit-001]]',
		'',
		'## Chapters',
		'',
		'- [[ch-01]]',
		'',
		'## Derived',
		'',
		'- [[state]]',
		'- [[open-questions]]',
		'',
	].join('\n');

	files[VAULT.log] = '# Log\n\nChronological record of what the tool did. Newest last.\n';

	files[VAULT.state] = stringifyDocument({
		data: {generated: true},
		body: `# Ledger state\n\n${GENERATED_BANNER}\n\nRun \`/lint\` or edit a situation to compute. Back to [[index]].\n`,
	});

	files[VAULT.openQuestions] = stringifyDocument({
		data: {generated: true},
		body: `# Open questions\n\n${GENERATED_BANNER}\n\nNothing recorded yet. Back to [[index]].\n`,
	});

	files[`${VAULT.raw}/README.md`] = [
		'# Raw',
		'',
		'What you write. One folder per primitive — put a note about a character in',
		'`characters/`, a note about a place in `places/`, and so on.',
		'',
		'Notes are freeform: headings, bullets, a wall of prose. There is no format',
		'to learn. Name the file after the thing it describes, because the filename',
		'is the id the corpus page will carry.',
		'',
		'`/ingest <kind>` reads these and proposes the typed pages. Every proposal',
		'reaches you as a diff you accept. The tool does not edit this folder —',
		'only `/curator` may, and only when the error is in the record itself.',
		'',
		...RAW_KINDS.map(kind => `- \`${kind}/\``),
		'',
	].join('\n');

	// A README per folder, so an empty vault says what belongs where rather
	// than presenting nine directories with no explanation.
	for (const kind of RAW_KINDS) {
		files[`${VAULT.raw}/${kind}/README.md`] = [
			`# raw/${kind}`,
			'',
			`Your notes about ${kind}. One file per thing, named for it:`,
			`\`${VAULT.raw}/${kind}/<id>.md\` becomes that primitive's id.`,
			'',
			'Freeform. Write what you know.',
			'',
		].join('\n');
	}

	return files;
}

/** Never overwrites: an existing file is reported as skipped. */
export async function scaffoldVault(
	root: string,
	idiom = 'base',
): Promise<ScaffoldResult> {
	const profile = resolveProfile(idiom, BUILT_IN_PROFILES);
	const created: string[] = [];
	const skipped: string[] = [];

	for (const directory of VAULT_DIRECTORIES) {
		await mkdir(resolve(root, directory), {recursive: true});
	}

	for (const [relative, contents] of Object.entries(seedFiles(profile))) {
		const target = resolve(root, relative);
		await mkdir(resolve(root, relative, '..'), {recursive: true});
		try {
			await writeFile(target, contents, {encoding: 'utf8', flag: 'wx'});
			created.push(relative);
		} catch (caught) {
			if ((caught as NodeJS.ErrnoException).code === 'EEXIST') {
				skipped.push(relative);
			} else {
				throw caught;
			}
		}
	}

	return {created, skipped};
}
