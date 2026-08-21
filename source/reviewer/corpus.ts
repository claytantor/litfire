import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {Project} from '../core/project.js';
import {parseDocument} from '../vault/frontmatter.js';
import {wikiBriefingFor} from '../wiki/grounding.js';
import {resolve, VAULT} from '../vault/paths.js';
import type {CorpusEntry, CorpusMap} from './types.js';

/**
 * Full-text budget for `buildReviewerContext`, matching `DEFAULT_BUDGET` in
 * `interview/grounding.ts`. Characters, not tokens, for the same reason: a
 * safety rail that does not need to track four providers' tokenizers.
 */
const DEFAULT_BUDGET = 24_000;

/** Directories walked into the map, in kind order (§4). Not `.litrpg/`, not
 * `ledger/` (derived from the corpus, not part of it), not `raw/` (unstructured
 * intake, not yet corpus). Situations and arcs are split from their parent
 * directory because they carry their own kind. */
const CORPUS_DIRECTORIES: readonly {readonly directory: string; readonly kind: string}[] =
	[
		{directory: VAULT.setting, kind: 'system'},
		{directory: VAULT.systems, kind: 'system'},
		{directory: VAULT.moments, kind: 'moment'},
		{directory: VAULT.arcs, kind: 'arc'},
		{directory: VAULT.characters, kind: 'character'},
		{directory: VAULT.themes, kind: 'theme'},
		{directory: VAULT.places, kind: 'place'},
		{directory: VAULT.factions, kind: 'faction'},
		{directory: VAULT.artifacts, kind: 'artifact'},
		{directory: VAULT.situations, kind: 'situation'},
		{directory: VAULT.chapters, kind: 'chapter'},
		// A vault that has not moved to corpus/ yet still has a corpus, and the
		// reviewer must be able to read it or it would report an empty world.
		{directory: VAULT.legacySetting, kind: 'system'},
		{directory: 'systems', kind: 'system'},
		{directory: 'timeline/moments', kind: 'moment'},
		{directory: 'timeline/arcs', kind: 'arc'},
		{directory: 'characters', kind: 'character'},
		{directory: 'themes', kind: 'theme'},
		{directory: 'places', kind: 'place'},
		{directory: 'factions', kind: 'faction'},
		{directory: 'artifacts', kind: 'artifact'},
		{directory: 'situations', kind: 'situation'},
		{directory: 'chapters', kind: 'chapter'},
		{directory: VAULT.inbox, kind: 'situation'},
	];

/** Render order for `renderCorpusMap`'s sections. */
const KIND_ORDER: readonly string[] = [
	'system',
	'timeline',
	'moment',
	'arc',
	'character',
	'theme',
	'place',
	'artifact',
	'faction',
	'situation',
];

async function readIfPresent(file: string): Promise<string | undefined> {
	return readFile(file, 'utf8').catch(() => undefined);
}

async function listMarkdown(directory: string): Promise<string[]> {
	const entries = await readdir(directory, {withFileTypes: true}).catch(() => []);
	return entries
		.filter(entry => entry.isFile() && entry.name.endsWith('.md'))
		.map(entry => path.join(directory, entry.name))
		.toSorted();
}

function idOf(data: Record<string, unknown>): string | undefined {
	return typeof data['id'] === 'string' ? data['id'] : undefined;
}

/**
 * `title` for situations, but characters, themes, and arcs carry `name`
 * instead. Falling back keeps every kind navigable in the map — a reviewer
 * asking "who is Nyx" needs the character's name, not just her id.
 */
function titleOf(data: Record<string, unknown>): string | undefined {
	if (typeof data['title'] === 'string') {
		return data['title'];
	}
	return typeof data['name'] === 'string' ? data['name'] : undefined;
}

/**
 * Builds the whole-vault map the reviewer always sees.
 *
 * Author-facing corpus only: `.litrpg/`, `ledger/`, and `raw/` are excluded by
 * simply never being walked. `example: true` scaffolding is withheld for the
 * same reason `interview/grounding.ts` withholds it — a reviewer that cites a
 * `/init` placeholder discusses a character the author never invented.
 */
export async function buildCorpusMap(root: string, project: Project): Promise<CorpusMap> {
	const entries: CorpusEntry[] = [];
	let examplesSkipped = 0;

	for (const {directory, kind} of CORPUS_DIRECTORIES) {
		for (const file of await listMarkdown(resolve(root, directory))) {
			const raw = await readIfPresent(file);
			if (raw === undefined) {
				continue;
			}

			const {data} = parseDocument(raw);

			if (data['example'] === true) {
				examplesSkipped += 1;
				continue;
			}

			entries.push({
				path: path.relative(root, file),
				kind,
				id: idOf(data),
				title: titleOf(data),
				chars: raw.length,
				frontmatter: data,
			});
		}
	}

	return {
		entries,
		// Mirrors `/questions`' own filter (commands/views.ts renderQuestions):
		// the reviewer discusses what is still unresolved, not the full history.
		openQuestions: project.questions
			.filter(question => question.status === 'open')
			.map(question => {
				const actor = question.actor === undefined ? '' : ` (${question.actor})`;
				return `${question.id} [${question.kind}] ${question.where}${actor}: ${question.detail}`;
			}),
		examplesSkipped,
	};
}

function pushField(parts: string[], label: string, value: unknown): void {
	if (value === undefined) {
		return;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return;
		}
		parts.push(`${label}=${value.join(',')}`);
		return;
	}
	parts.push(`${label}=${String(value)}`);
}

/**
 * The frontmatter fields that actually help navigation, kept to one line per
 * file (this ships every turn — see `renderCorpusMap`). Everything else in
 * frontmatter is available in `## Full text` once the file is selected.
 */
function navigationFields(entry: CorpusEntry): string {
	const fm = entry.frontmatter;
	const parts: string[] = [];

	switch (entry.kind) {
		case 'situation': {
			pushField(parts, 'arc', fm['arc']);
			pushField(parts, 'order', fm['order']);
			pushField(parts, 'characters', fm['characters']);
			pushField(parts, 'themes', fm['themes']);
			break;
		}
		case 'character': {
			pushField(parts, 'level', fm['level']);
			break;
		}
		case 'arc': {
			pushField(parts, 'order', fm['order']);
			break;
		}
		default: {
			break;
		}
	}

	return parts.join(' ');
}

function renderEntryLine(entry: CorpusEntry): string {
	const segments = [entry.path];
	if (entry.id !== undefined) {
		segments.push(entry.id);
	}
	if (entry.title !== undefined) {
		segments.push(`"${entry.title}"`);
	}
	const fields = navigationFields(entry);
	if (fields !== '') {
		segments.push(fields);
	}
	return `- ${segments.join(' ')}`;
}

/** Same caution `interview/grounding.ts` emits for the same reason: dropping it
 * would let a scaffold name reach the reviewer, which is the failure the
 * `example: true` filter exists to prevent. */
function scaffoldCaution(examplesSkipped: number): string {
	return [
		'## Not established',
		'',
		`This vault contains ${examplesSkipped} scaffold placeholder file(s) written`,
		'by `/init`, and they have been withheld from you deliberately. No',
		'character, place, event, or theme in them was invented by this author.',
		'Do not use any name or title from them, and do not refer to them.',
		'Until the author names their protagonist, say "your protagonist".',
	].join('\n');
}

/**
 * Compact markdown map, grouped by kind: one line per file. Ships on every
 * reviewer turn, so it must never grow with a file's size — full text is what
 * `selectRelevant`/`buildReviewerContext` are for.
 */
export function renderCorpusMap(map: CorpusMap): string {
	const byKind = new Map<string, CorpusEntry[]>();
	for (const entry of map.entries) {
		const list = byKind.get(entry.kind);
		if (list) {
			list.push(entry);
		} else {
			byKind.set(entry.kind, [entry]);
		}
	}

	const sections: string[] = ['## Corpus map'];

	for (const kind of KIND_ORDER) {
		const entries = byKind.get(kind);
		if (entries === undefined || entries.length === 0) {
			continue;
		}
		sections.push('', `### ${kind} (${entries.length})`, ...entries.map(renderEntryLine));
	}

	sections.push(
		'',
		'## Open questions',
		'',
		map.openQuestions.length === 0
			? '_No open questions._'
			: map.openQuestions.join('\n'),
	);

	if (map.examplesSkipped > 0) {
		sections.push('', scaffoldCaution(map.examplesSkipped));
	}

	return sections.join('\n');
}

/** Common English function words. Deliberately short: an unfiltered stopword
 * just becomes a harmless extra token, while over-filtering can strip a word
 * the author actually meant as a keyword. */
const STOPWORDS = new Set([
	'the',
	'and',
	'for',
	'are',
	'but',
	'not',
	'you',
	'your',
	'all',
	'can',
	'has',
	'had',
	'was',
	'were',
	'what',
	'when',
	'where',
	'who',
	'how',
	'why',
	'with',
	'this',
	'that',
	'from',
	'have',
	'does',
	'did',
	'about',
	'into',
	'onto',
	'over',
	'under',
	'which',
	'their',
	'they',
	'them',
	'she',
	'him',
	'his',
	'her',
	'its',
	'our',
	'out',
	'off',
	'than',
	'then',
	'there',
	'here',
	'been',
	'being',
	'would',
	'could',
	'should',
	'will',
	'shall',
	'may',
	'might',
	'must',
	'one',
	'two',
	'any',
	'some',
	'more',
	'most',
	'much',
	'many',
	'each',
	'such',
	'only',
	'also',
	'just',
	'like',
	'tell',
	'know',
	'think',
	'want',
	'need',
	'make',
	'made',
	'say',
	'said',
	'let',
	'put',
	'use',
	'used',
]);

function tokenize(question: string): string[] {
	const words = question
		.toLowerCase()
		// Hyphens are kept: ids like `sit-901` must survive as one token for the
		// exact-match check below.
		.split(/[^a-z0-9-]+/)
		.filter(word => word.length >= 3 && !STOPWORDS.has(word));
	return [...new Set(words)];
}

function stringLeaves(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(stringLeaves);
	}
	if (value !== null && typeof value === 'object') {
		return Object.values(value as Record<string, unknown>).flatMap(stringLeaves);
	}
	return [];
}

/** Large enough that no pile-up of partial keyword hits can outrank a name the
 * author actually typed. */
const EXACT_MATCH_BONUS = 1000;

function scoreEntry(
	entry: CorpusEntry,
	tokens: readonly string[],
	questionLower: string,
): number {
	let score = 0;

	const idLower = entry.id?.toLowerCase();
	const titleLower = entry.title?.toLowerCase();

	if (idLower !== undefined && tokens.includes(idLower)) {
		score += EXACT_MATCH_BONUS;
	}
	if (
		titleLower !== undefined &&
		titleLower !== '' &&
		questionLower.includes(titleLower)
	) {
		score += EXACT_MATCH_BONUS;
	}

	const haystack = [entry.path, entry.id, entry.title, ...stringLeaves(entry.frontmatter)]
		.filter((value): value is string => typeof value === 'string')
		.map(value => value.toLowerCase());

	for (const token of tokens) {
		if (haystack.some(field => field.includes(token))) {
			score += 1;
		}
	}

	return score;
}

/**
 * Deterministic corpus selection for one author question — no model call, no
 * randomness, so the same question always pulls the same files. Zero keyword
 * overlap returns nothing rather than an arbitrary "first N": guessing which
 * scenes to hand the reviewer when nothing actually matched would let it answer
 * confidently about the wrong ones.
 */
export function selectRelevant(
	map: CorpusMap,
	question: string,
	budget: number,
): readonly string[] {
	const tokens = tokenize(question);
	if (tokens.length === 0) {
		return [];
	}

	const questionLower = question.toLowerCase();

	const scored = map.entries
		.map(entry => ({entry, score: scoreEntry(entry, tokens, questionLower)}))
		.filter(({score}) => score > 0)
		.toSorted((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));

	// Skip an entry that will not fit and keep going, rather than stopping at the
	// first one — the same rule grounding.ts applies. Stopping would mean a single
	// oversized scene at the top of the ranking starves the whole selection, and
	// the author's question comes back answered from the map alone.
	const selected: string[] = [];
	let used = 0;
	for (const {entry} of scored) {
		if (used + entry.chars > budget) {
			continue;
		}
		selected.push(entry.path);
		used += entry.chars;
	}

	return selected;
}

/**
 * Composes the string injected into the reviewer's prompt: the map (always
 * present — it is never charged against `budget`, the same way grounding.ts
 * always reserves room for its caution) plus the full text of whatever
 * `selectRelevant` picked.
 */
export async function buildReviewerContext(
	root: string,
	project: Project,
	question: string,
	options: {readonly budget?: number} = {},
): Promise<string> {
	const map = await buildCorpusMap(root, project);
	const sections = [renderCorpusMap(map)];

	const budget = options.budget ?? DEFAULT_BUDGET;
	const paths = selectRelevant(map, question, budget);

	const fullText = (
		await Promise.all(
			paths.map(async relativePath => {
				const raw = await readIfPresent(resolve(root, relativePath));
				return raw === undefined ? undefined : `### ${relativePath}\n\n${raw.trim()}`;
			}),
		)
	).filter((block): block is string => block !== undefined);

	// The reviewer answers questions about consistency, so the computed
	// cross-reference is often the actual answer — who was in the room, when a
	// skill was acquired — and the prose only corroborates it.
	const briefing = wikiBriefingFor(project, {focus: question.toLowerCase().split(/\W+/)});
	if (briefing !== '') {
		sections.push(briefing);
	}

	if (fullText.length > 0) {
		sections.push(['## Full text', '', fullText.join('\n\n')].join('\n'));
	}

	return sections.join('\n\n');
}
