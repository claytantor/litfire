import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {Project} from '../core/project.js';
import {parseDocument} from '../vault/frontmatter.js';
import {RAW_KINDS, resolve, VAULT} from '../vault/paths.js';
import {calendarFor} from '../time/binding.js';
import {buildCorpusMap} from '../reviewer/corpus.js';
import type {CorpusMap} from '../reviewer/types.js';

/**
 * Turning the author's own notes into typed pages.
 *
 * The interviews produce transcripts and extraction reads them. This is the
 * other way an author works: they already know their world, they write it down
 * in `raw/characters/`, `raw/moments/`, `raw/places/`, and what they want is
 * for the corpus to catch up. Before this there was no path from a page of
 * notes to a page in the vault except describing it to the curator.
 *
 * The raw file is never touched. Ingest reads it and proposes the corpus that
 * should exist beside it, which is the same contract every other write in the
 * tool has.
 */
export const INGEST_KINDS = [
	'character',
	'moment',
	'place',
	'situation',
	'system',
	'arc',
	'faction',
	'artifact',
	'skill',
	'theme',
	'chapter',
] as const;

export type IngestKind = (typeof INGEST_KINDS)[number];

type Spec = {
	/** Where the author's notes for this kind live. */
	readonly from: string;
	/** Where a proposed page goes. */
	readonly to: string;
	/** The frontmatter, so a proposal parses rather than becoming a load issue. */
	readonly fields: string;
	/**
	 * The handful of things a reader wants about this kind at a glance.
	 *
	 * These deliberately mirror what the interview brief for the same kind
	 * presses hardest on: the brief asks the question, the summary records the
	 * answer. A character's brief digs for what they want and what the System
	 * gives them no credit for, and those are exactly the two lines worth having
	 * at the top of their page.
	 */
	readonly summary: string;
};

export const INGEST: Readonly<Record<IngestKind, Spec>> = {
	character: {
		from: `${VAULT.raw}/characters`,
		to: VAULT.characters,
		fields:
			'id, name, level (int), xp, stats (map of id to number), skills (ids), ' +
			'items (map of id to count), artifacts (ids), system (id)',
		summary:
			'what they want · what they are good at · who has leverage over them · what the System gives them no credit for',
	},
	moment: {
		from: `${VAULT.raw}/moments`,
		to: VAULT.moments,
		fields:
			'id, name, at (whole seconds from the origin, may be negative and very ' +
			'large — omit it rather than guessing), events (ledger events)',
		summary: 'what changed · what became possible · what became impossible',
	},
	place: {
		from: `${VAULT.raw}/places`,
		to: VAULT.places,
		fields: 'id, name. Everything else about a place is prose in the body',
		summary: 'what it is for · who controls it · what it costs to be there',
	},
	situation: {
		from: `${VAULT.raw}/situations`,
		to: VAULT.situations,
		fields:
			'id, title, arc (id), order (int), moment (id), characters (ids), ' +
			'place (id), themes (sub-theme ids), events (ledger events). ' +
			'A situation with no arc is unplaced, which is a normal state — leave ' +
			'the field out rather than moving the file anywhere',
		summary: 'what changes by the end · what it costs someone',
	},
	system: {
		from: `${VAULT.raw}/systems`,
		to: VAULT.systems,
		fields:
			'id, name, stats (id, name, default, min, max), skills (id, name, ' +
			'requires_skills, requires_level), curves (xp_for_level, max_level)',
		summary: 'what it wants · what advancement costs · the hard limit',
	},
	arc: {
		from: `${VAULT.raw}/arcs`,
		to: VAULT.arcs,
		fields:
			'id, name, order (int), starts_after (moment id), ends_before (moment id), ' +
			'milestone (map of character id to intended level/skills/stats)',
		summary: 'what is attempted · the interesting failure · what it takes forward',
	},
	faction: {
		from: `${VAULT.raw}/factions`,
		to: VAULT.factions,
		fields: 'id, name, goal, members (character ids)',
		summary: 'what they say they want · what they do instead · their nearest rival',
	},
	artifact: {
		from: `${VAULT.raw}/artifacts`,
		to: VAULT.artifacts,
		fields:
			'id, name, kind, outcome (what it achieves — the defining field), ' +
			'requires_skills (ids), requires_level (int)',
		summary: 'what it achieves · what using it costs · who cannot use it',
	},
	skill: {
		from: `${VAULT.raw}/skills`,
		to: VAULT.skills,
		fields:
			'id, name, system (id of the system that grants it — omit it when the ' +
			'vault has one system, or when every system grants it), ' +
			'requires_skills (ids), requires_level (int)',
		summary: 'what it lets someone do · what it costs to use · who cannot learn it',
	},
	theme: {
		from: `${VAULT.raw}/themes`,
		to: VAULT.themes,
		fields: 'id, name, subthemes (id, name, description, tension)',
		summary: 'the argument · the two poles it lives between',
	},
	chapter: {
		from: `${VAULT.raw}/chapters`,
		to: VAULT.chapters,
		fields:
			'id, title, order (int), starts_at (situation id). A chapter is a cut ' +
			'in the replay sequence — it names where it begins and nothing else. ' +
			'Which situations fall inside it is derived from the next cut, never ' +
			'stored, so never list members',
		summary: 'what the reader knows by the end · what question is left open',
	},
};

/**
 * Every ingest kind has a folder, and every folder has a kind.
 *
 * `paths.ts` declares the directories so `scaffold.ts` can create them without
 * importing this module; this asserts the two agree, at load, rather than
 * letting a kind quietly have nowhere to read from.
 */
const declared = new Set(RAW_KINDS.map(kind => `${VAULT.raw}/${kind}`));
for (const [kind, spec] of Object.entries(INGEST)) {
	if (!declared.has(spec.from)) {
		throw new Error(
			`ingest kind '${kind}' reads ${spec.from}, which /init does not create`,
		);
	}
}

/**
 * Interviews are a source, not a primitive.
 *
 * A note in `raw/characters/` is about one character. A transcript is about
 * whatever the author happened to say — a system interview establishes a
 * system, and names three characters and a turning point on the way. So it has
 * no single destination, and the pass is given every kind and told to file what
 * it finds where it belongs.
 *
 * That is the only difference. Provenance, hashing and the review gate work
 * exactly as they do for a note, which is what let the per-kind `extract`
 * commands fold into this one.
 */
export const INTERVIEWS = `${VAULT.raw}/interviews`;

export type SourceKind = IngestKind | 'interview';

export const SOURCE_KINDS: readonly SourceKind[] = [...INGEST_KINDS, 'interview'];

export function isIngestKind(value: string): value is SourceKind {
	return (SOURCE_KINDS as readonly string[]).includes(value);
}

/** Where a source kind reads from. */
export function sourceDirectory(kind: SourceKind): string {
	return kind === 'interview' ? INTERVIEWS : INGEST[kind].from;
}

/** Where its pages may land. A transcript may write to any of them. */
export function targetsOf(kind: SourceKind): readonly IngestKind[] {
	return kind === 'interview' ? INGEST_KINDS : [kind];
}

/**
 * A frontmatter value, as the YAML scalar the author wrote.
 *
 * `JSON.stringify` did this job, and JSON has no bigint. A moment's `at` is
 * parsed as one so deep time survives the round trip, so the first raw note to
 * carry `at:` made this throw `Do not know how to serialize a BigInt` — which
 * the scaffold's own seeded moments would have triggered on the next
 * `/ingest moment`. Whole seconds are written as their digits, which is what
 * the note said and what YAML reads back.
 *
 * The replacer covers a bigint nested inside an object or array. That renders
 * as a quoted string rather than a number, which is a small loss of fidelity in
 * a prompt and much better than failing to build one.
 */
function asYaml(value: unknown): string {
	return typeof value === 'bigint'
		? value.toString()
		: JSON.stringify(value, (_key, nested: unknown) =>
				typeof nested === 'bigint' ? nested.toString() : nested,
			);
}

export type RawDocument = {
	/** Vault-relative, so a proposal can cite where a fact came from. */
	readonly path: string;
	/** The whole file. What the hash is taken over. */
	readonly contents: string;
	/**
	 * The author's own structured assertions, if they wrote any.
	 *
	 * A note may carry frontmatter — `moment:`, `cast:`, `place:` — and when it
	 * does, those are decisions rather than inferences. The author already did
	 * this informally, as `Moment:` and `Cast:` lines at the top of their prose;
	 * making it YAML costs nothing and makes it machine-readable.
	 */
	readonly data: Readonly<Record<string, unknown>>;
	/** The prose, without the frontmatter. */
	readonly body: string;
};

/**
 * The notes to ingest: one file, or everything in the directory.
 *
 * `focus` matches a filename stem. It is matched loosely because an author
 * naming a document reaches for the thing it is about — `/ingest character
 * sebastian-weber` should find `sebastian-weber.md`, and so should
 * `sebastian`.
 */
export async function readRaw(
	root: string,
	kind: SourceKind,
	focus?: string,
): Promise<{documents: RawDocument[]; directory: string}> {
	const directory = sourceDirectory(kind);
	const entries = await readdir(resolve(root, directory), {withFileTypes: true}).catch(
		() => [],
	);

	const names = entries
		.filter(
			entry =>
				entry.isFile() &&
				entry.name.endsWith('.md') &&
				// `/init` puts a README in each folder saying what belongs there.
				// It is signposting, not material, and ingesting it would propose a
				// character page about how to write character pages.
				entry.name.toLowerCase() !== 'readme.md',
		)
		.map(entry => entry.name)
		.toSorted();

	const wanted =
		focus === undefined
			? names
			: names.filter(name => {
					const stem = path.basename(name, '.md').toLowerCase();
					const asked = focus.toLowerCase();
					return stem === asked || stem.includes(asked);
				});

	const documents: RawDocument[] = [];
	for (const name of wanted) {
		const contents = await readFile(resolve(root, directory, name), 'utf8').catch(
			() => undefined,
		);
		if (contents !== undefined && contents.trim() !== '') {
			const {data, body} = parseDocument(contents);
			documents.push({path: `${directory}/${name}`, contents, data, body});
		}
	}

	return {documents, directory};
}

/**
 * What the corpus already holds for this kind, by path.
 *
 * Read from the corpus map rather than from the loaded vault, because the map
 * carries the file each page came from and the vault does not. That matters
 * exactly when it is most needed: two files declaring one id load as two
 * entries, and a list of ids and names renders them as the same row twice.
 * An agent shown that correctly reported it could see a duplicate and could not
 * act, having been given no second path to propose removing.
 */
function existing(map: CorpusMap, kind: IngestKind): string {
	const rows = map.entries.filter(entry => entry.kind === kind);

	return rows.length === 0
		? `_No ${kind} pages exist yet._`
		: rows
				.map(entry =>
					[
						`- \`${entry.path}\``,
						entry.id === undefined ? undefined : `id \`${entry.id}\``,
						entry.title === undefined ? undefined : `"${entry.title}"`,
					]
						.filter(part => part !== undefined)
						.join(' — '),
				)
				.join('\n');
}

/**
 * The instruction and context handed to the structural pass.
 *
 * Built as a plan rather than as its own agent: the pass already knows how to
 * emit whole files, refuses paths outside the vault, can open a file it needs,
 * and returns proposals to the review gate. An ingest is that job with the
 * material named for it.
 */
export async function buildIngest(
	root: string,
	project: Project,
	kind: SourceKind,
	documents: readonly RawDocument[],
): Promise<{instruction: string; context: string}> {
	const targets = targetsOf(kind);

	// Only for the kinds that carry an `at`, and only when the bound calendar can
	// read a date as well as write one. `parse` is optional — a fictional
	// calendar that can only format is still useful — and offering a date format
	// against one of those would invite a value nothing could convert back.
	const {calendar} = calendarFor(project.vault.time);
	// `rawSeconds` has a `parse` too — it reads "86400" — so asking only whether
	// the calendar can parse would offer a date format to a vault that has no
	// dates. It has to be a calendar *and* readable.
	const clock =
		targets.includes('moment') &&
		calendar.id !== 'seconds' &&
		calendar.parse !== undefined
			? calendar.name
			: undefined;

	const where =
		kind === 'interview'
			? [
					'These are interview transcripts. One of them establishes whatever the',
					'author happened to say — a system, and three characters and a turning',
					'point on the way — so file each thing you find under the kind it',
					'belongs to:',
					'',
					...targets.map(
						target =>
							`- ${target}: \`${INGEST[target].to}/<id>.md\` — ${INGEST[target].fields}`,
					),
					'',
					'Propose a page only for something the transcript actually establishes.',
					'A name mentioned in passing is not a character page; it is a line in',
					'one, or nothing at all.',
				]
			: [
					`Write each page to \`${INGEST[kind].to}/<id>.md\` — the filename is the id,`,
					'with nothing appended. One id means one file, and a page written',
					'anywhere else or under any other name becomes a second copy nothing can',
					'reconcile.',
					'',
					`Frontmatter fields: ${INGEST[kind].fields}.`,
				];

	const instruction = [
		kind === 'interview'
			? "Read the author's interview transcripts below and file what they establish."
			: `Ingest the author's ${kind} notes below into ${kind} pages.`,
		'',
		...where,
		'',
		'One note may describe several — an ordered list of moments is a page each,',
		'not one page. One note may also describe only part of something that',
		'already exists, in which case carry the existing page forward and add to',
		'it rather than replacing what is there.',
		'',
		'Where a page already exists for something in these notes, update it: emit',
		'its whole contents with the new material folded in. Never create a second',
		'page for a thing that already has one under a different id.',
		'',
		'The existing pages are listed by path. If two of them declare the same id,',
		'only one is ever resolved and the other is dead weight — propose removing',
		'whichever is the lesser copy, by path, with "remove": true.',
		'',
		'The notes are the author’s own words. Their prose belongs in the body of',
		'the page; the frontmatter is for what the schema asks for. Do not invent a',
		'value the notes do not give — leave the field out and say so in notes, and',
		'the checks will raise it as an open question.',
		'',
		'Where a note carries frontmatter of its own, those fields are the author’s',
		'decisions and not your inferences. Carry every one of them onto the page',
		'unchanged, including ones you would have chosen differently. Fill in only',
		'what they left out. If a field they set contradicts their prose, keep the',
		'field, say so in notes, and let them settle it.',
		'',
		'Do not modify the raw notes themselves.',
		'',
		'If a note or an existing page carries a ```interface block, reproduce it',
		'byte for byte — every space, every box-drawing character, every',
		'`{placeholder}`. It is a status screen the author drew and lined up by',
		'hand, and it is the one thing in the vault where whitespace is content.',
		'Never tidy it, never re-align it, and never add or remove a placeholder:',
		'a placeholder is a claim that a stat exists, and adding one invents a',
		'stat the author did not ask for.',
		...(clock === undefined
			? []
			: [
					'',
					'## Dates',
					'',
					`This vault reads its clock as ${clock}.`,
					'',
					'So where a note states when something happened, you may write that',
					'date into `at:` exactly as the note gives it — "2036-08-15", or',
					'"2036-08-15 02:30" — instead of a number of seconds. The tool',
					'converts it, including the timezone and its daylight saving.',
					'',
					'Never do that arithmetic yourself. A number you calculated is',
					'indistinguishable from one the author chose, and it lands in a',
					'ledger that computes with it. Write the date, or write nothing.',
					'',
					'A note that does not say when something happened still gets no',
					'`at:` at all. "Long ago" and "before the war" are not dates, and an',
					'undated moment is a normal state the checks already report.',
				]),
		'',
		'## The summary block',
		'',
		'Every page you write carries one generated region, at the very top of the',
		'body, before any prose:',
		'',
		'    <!-- litrpg:summary -->',
		'    **Wants** — to be believed, and cannot say so out loud.',
		'    **Leverage** — her brother, who does not know he has any.',
		'    <!-- /litrpg:summary -->',
		'',
		'One line per point, in the form `**Label** — value`. Keep each to a single',
		'sentence. This is the at-a-glance view a reader gets before the prose, and',
		'a paragraph in it is a paragraph in the wrong place.',
		'',
		...targets.map(
			target =>
				`For a ${target}, the points worth having are: ${INGEST[target].summary}.`,
		),
		'',
		'Omit any point the notes do not answer. Do not guess one, do not soften a',
		'guess into a hedge, and do not write "unknown" — a missing line is the',
		'correct output for something the author has not decided, and the checks',
		'will raise it as an open question if it matters.',
		'',
		'The markers are exact and the region is regenerated whole on every pass,',
		'so nothing outside them is ever touched. Never put the author’s prose',
		'inside the block, and never put a heading inside it.',
	].join('\n');

	const map = await buildCorpusMap(root, project);
	const context = [
		'# pages that already exist',
		'',
		targets.map(target => `## ${target}\n\n${existing(map, target)}`).join('\n\n'),
		'',
		kind === 'interview'
			? "# The author's interview transcripts"
			: `# The author's ${kind} notes`,
		'',
		documents
			.map(document =>
				[
					`## \`${document.path}\``,
					'',
					// Split out and labelled, rather than left as a fence at the top of
					// the prose. A model shown "---\nmoment: x\n---" reads it as part of
					// the note; shown it under a heading that says these are decisions,
					// it carries them.
					...(Object.keys(document.data).length === 0
						? []
						: [
								'### What the author has already decided',
								'',
								'```yaml',
								...Object.entries(document.data).map(
									([key, value]) => `${key}: ${asYaml(value)}`,
								),
								'```',
								'',
								'### What they wrote',
								'',
							]),
					document.body.trim(),
				].join('\n'),
			)
			.join('\n\n---\n\n'),
	].join('\n');

	return {instruction, context};
}
