import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {Project} from '../core/project.js';
import {parseDocument} from '../vault/frontmatter.js';
import {RAW_KINDS, resolve, VAULT} from '../vault/paths.js';
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
	'theme',
] as const;

export type IngestKind = (typeof INGEST_KINDS)[number];

type Spec = {
	/** Where the author's notes for this kind live. */
	readonly from: string;
	/** Where a proposed page goes. */
	readonly to: string;
	/** The frontmatter, so a proposal parses rather than becoming a load issue. */
	readonly fields: string;
};

export const INGEST: Readonly<Record<IngestKind, Spec>> = {
	character: {
		from: `${VAULT.raw}/characters`,
		to: VAULT.characters,
		fields:
			'id, name, level (int), xp, stats (map of id to number), skills (ids), ' +
			'items (map of id to count), artifacts (ids), system (id)',
	},
	moment: {
		from: `${VAULT.raw}/moments`,
		to: VAULT.moments,
		fields:
			'id, name, at (whole seconds from the origin, may be negative and very ' +
			'large — omit it rather than guessing), events (ledger events)',
	},
	place: {
		from: `${VAULT.raw}/places`,
		to: VAULT.places,
		fields: 'id, name. Everything else about a place is prose in the body',
	},
	situation: {
		from: `${VAULT.raw}/situations`,
		to: VAULT.situations,
		fields:
			'id, title, arc (id), order (int), moment (id), characters (ids), ' +
			'place (id), themes (sub-theme ids), events (ledger events). ' +
			'A situation with no arc is unplaced, which is a normal state — leave ' +
			'the field out rather than moving the file anywhere',
	},
	system: {
		from: `${VAULT.raw}/systems`,
		to: VAULT.systems,
		fields:
			'id, name, stats (id, name, default, min, max), skills (id, name, ' +
			'requires_skills, requires_level), curves (xp_for_level, max_level)',
	},
	arc: {
		from: `${VAULT.raw}/arcs`,
		to: VAULT.arcs,
		fields:
			'id, name, order (int), starts_after (moment id), ends_before (moment id), ' +
			'milestone (map of character id to intended level/skills/stats)',
	},
	faction: {
		from: `${VAULT.raw}/factions`,
		to: VAULT.factions,
		fields: 'id, name, goal, members (character ids)',
	},
	artifact: {
		from: `${VAULT.raw}/artifacts`,
		to: VAULT.artifacts,
		fields:
			'id, name, kind, outcome (what it achieves — the defining field), ' +
			'requires_skills (ids), requires_level (int)',
	},
	theme: {
		from: `${VAULT.raw}/themes`,
		to: VAULT.themes,
		fields: 'id, name, subthemes (id, name, description, tension)',
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
