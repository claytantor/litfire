import {mkdir, writeFile} from 'node:fs/promises';
import {BUILT_IN_PROFILES, resolveProfile} from '../genre/profiles.js';
import type {ResolvedProfile} from '../genre/types.js';
import {INGEST, type IngestKind} from '../ingest/index.js';
import {hashSource, HASH_FIELD, SOURCE_FIELD} from '../ingest/state.js';
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
/**
 * A seed the author owns, written to both layers at once.
 *
 * `raw/<kind>/<id>.md` is the record; the corpus page is what the tool derives
 * from it, carrying the note's path and hash. A fresh vault is therefore
 * already adopted: `/ingest` reports every seed as unchanged, and the first
 * command to edit one has nothing to migrate.
 *
 * Seeding *both* rather than only raw is deliberate. A vault whose corpus stayed
 * empty until an ingest ran would need a configured model provider before it
 * rendered anything at all, and `/init` has to produce a vault that opens in
 * Obsidian with a connected graph (DoD 1). The pair is written the same way
 * `setAuthored` writes it, so the scaffold demonstrates the loop rather than
 * standing outside it.
 */
function authored(
	files: Record<string, string>,
	kind: IngestKind,
	id: string,
	data: Record<string, unknown>,
	body: string,
): void {
	const from = `${INGEST[kind].from}/${id}.md`;
	const note = stringifyDocument({data: {id, ...data}, body});

	files[from] = note;
	files[`${INGEST[kind].to}/${id}.md`] = stringifyDocument({
		data: {id, ...data, [SOURCE_FIELD]: from, [HASH_FIELD]: hashSource(note)},
		body,
	});
}

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

	// One page, where `system/stats.md` + `skills.md` + `curves.md` used to be
	// three. Those still load, so no vault breaks — but seeding them meant every
	// new vault started in the layout the loader itself calls legacy, with a
	// third home for a stat once `raw/systems/` arrived.
	//
	// The id is not `system`: that is already the setting page's stem, and two
	// files resolving one `[[system]]` is an ambiguity Obsidian would inherit.
	// Nothing needs the name — a vault with one system resolves to it unnamed.
	authored(
		files,
		'system',
		'system-01',
		{
			example: true,
			// Seeded from the profile's archetypes — data, not logic.
			stats: profile.archetypes.stats.map(id => ({
				id,
				name: id.charAt(0).toUpperCase() + id.slice(1),
				default: 10,
				min: 0,
			})),
			skills: [{id: 'first-ability', name: 'First Ability', requires_skills: []}],
			curves: {xp_for_level: 'xp-for-level', max_level: 50},
		},
		[
			'',
			'# The System',
			'',
			'> Scaffold example. Delete `example: true` once this is really your system.',
			'',
			'Stats, skills and curves are author-owned. `xp_for_level` names a formula',
			'in [[formulas]] giving the cumulative XP required to *be* a level, and',
			'prerequisites are checked deterministically against the stats above.',
			'',
			'Governs [[protagonist]].',
			'',
		].join('\n'),
	);

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

	// A page each. This was one file at `timeline/moments` — a path `/init` had
	// already created as a directory, so the write threw EEXIST and was filed
	// under `skipped`. The seed had never once been written.
	authored(
		files,
		'moment',
		'we-001',
		{example: true, name: 'The System Arrives', at: 0},
		'\n# The System Arrives\n\nSecond zero on the in-world clock: the origin every other moment is\nmeasured from. Opens [[arc-01]].\n',
	);

	authored(
		files,
		'moment',
		'we-002',
		{example: true, name: 'The Third Floor Opens', at: 100},
		'\n# The Third Floor Opens\n\nA hundred seconds after the origin. Closes [[arc-01]].\n',
	);

	/**
	 * The opening, with nothing before it.
	 *
	 * A story's first scenes have no earlier moment to start after, and until
	 * arcs could anchor on their own scenes there was nowhere to put them: on
	 * `arc-01` they replayed after its anchor, which is wrong for anything that
	 * happens before the story proper, and on no arc at all they replayed never.
	 *
	 * Seeded empty and without `starts_after`, which is the whole point — it
	 * waits for the earliest moment its own scenes claim. An author who never
	 * writes a prologue has one unused arc; one who does has somewhere for it to
	 * go on the first day, rather than discovering the need at the point of
	 * having written the scene.
	 */
	authored(
		files,
		'arc',
		'arc-00',
		{name: 'Prologue', order: 0, example: true},
		[
			'',
			'# Prologue',
			'',
			'> Scaffold example. Delete `example: true` once this is really your arc.',
			'',
			'Whatever happens before the story proper — a first memory, an origin, a',
			'thing done long ago that the book is about the consequences of.',
			'',
			'It names no `starts_after`, because nothing precedes it. Its position',
			'comes from the earliest moment its own scenes are anchored to, so a scene',
			'set aeons back replays after those aeons rather than before them.',
			'',
			'Delete it if your book opens where it opens.',
			'',
		].join('\n'),
	);

	authored(
		files,
		'arc',
		'arc-01',
		{
			name: 'Ground Floor',
			order: 1,
			starts_after: 'we-001',
			ends_before: 'we-002',
			example: true,
			milestone: {protagonist: {level: 3, has_skills: []}},
		},
		'\n# Ground Floor\n\n> Scaffold example. Delete `example: true` once this is really your arc.\n\nSpans [[we-001]] → [[we-002]]. Characters: [[protagonist]].\n',
	);

	authored(
		files,
		'character',
		'protagonist',
		{
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
		'\n# (unnamed protagonist)\n\n> Scaffold example. Rename the file and delete `example: true` once this\n> is really your character.\n\nStarting state above is author-owned. Narrative below is LLM-maintained.\n\nAppears in [[arc-01]], under [[system-01]].\n',
	);

	authored(
		files,
		'theme',
		'commodification',
		{
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
		'# The Commodification of Existence\n\nSituations tag sub-themes only. Coverage is informational and never blocks.\n',
	);

	// The filename is the id, with nothing appended: one id, one file.
	authored(
		files,
		'situation',
		'sit-001',
		{
			title: 'The Arrival',
			arc: 'arc-01',
			order: 10,
			moment: 'we-001',
			example: true,
			characters: ['protagonist'],
			themes: ['monetized-suffering'],
			events: [
				{actor: 'protagonist', type: 'xp', value: 450, note: 'survived the first hour'},
			],
		},
		'\n> Scaffold example. Delete `example: true` once this is really your scene.\n\nProse body. The tool never edits this text.\n\nFeaturing [[protagonist]] in [[arc-01]], at [[we-001]].\n',
	);

	authored(
		files,
		'chapter',
		'ch-01',
		{title: 'Chapter One', order: 1, starts_at: 'sit-001', example: true},
		'\n# Chapter One\n\n> Scaffold example. Delete `example: true` once this is really your chapter.\n\nOpens on [[sit-001]].\n',
	);

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
		'## Setting',
		'',
		'- [[setting]]',
		'- [[idiom]]',
		'- [[system-01]]',
		'- [[formulas]]',
		'',
		'## Timeline',
		'',
		'- [[arc-00]]',
		'- [[we-001]]',
		'- [[we-002]]',
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
