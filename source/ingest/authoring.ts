import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseDocument, stringifyDocument} from '../vault/frontmatter.js';
import {resolve} from '../vault/paths.js';
import {INGEST, type IngestKind} from './index.js';
import {hashSource, HASH_FIELD, SOURCE_FIELD} from './state.js';

/** Where the author's copy of a primitive lives. */
export function authoringPath(kind: IngestKind, id: string): string {
	return `${INGEST[kind].from}/${id}.md`;
}

/** Where the derived page lives. */
export function corpusPath(kind: IngestKind, id: string): string {
	return `${INGEST[kind].to}/${id}.md`;
}

export type Authored = {
	/** The raw note that was written, vault-relative. */
	readonly file: string;
	/** True when this edit is what brought the note into being. */
	readonly adopted: boolean;
	/** True when the derived page was brought along with it. */
	readonly synced: boolean;
};

/**
 * Sets a field on the author's copy, adopting the page into `raw/` if it is not
 * there yet, and carrying the change onto the derived page.
 *
 * ## Adopt on edit
 *
 * A vault written before raw-first has pages in the corpus and nothing in
 * `raw/`. Rather than a migration the author has to schedule, a page moves the
 * first time they edit it: the corpus page is copied to `raw/`, and the edit
 * lands there. Migration happens by using the tool, on the pages that are
 * actually being worked on, and a vault can sit half-moved forever.
 *
 * ## Why the derived page is updated too, without a model
 *
 * Setting `at:` on a moment is not an inference. The author said the number;
 * carrying it to the page is a copy, and `/ingest` would do nothing cleverer.
 * Requiring a model call to make a typed edit visible would make the tool worse
 * at the thing it is for.
 *
 * So the page is updated in code and re-stamped with the note's new hash — the
 * corpus now reflects the note exactly, and the next `/ingest` correctly skips
 * it. This is not a second writer: it is the same write, done by the cheaper of
 * two mechanisms, and the raw note remains the source of truth. Prose changes
 * still need a pass, because those genuinely need reading.
 */
export async function setAuthored(
	root: string,
	kind: IngestKind,
	id: string,
	patch: Readonly<Record<string, unknown>>,
	validate: (data: unknown) => void,
): Promise<Authored | {error: string}> {
	const rawRelative = authoringPath(kind, id);
	const rawFile = resolve(root, rawRelative);
	const pageFile = resolve(root, corpusPath(kind, id));

	const existingRaw = await readFile(rawFile, 'utf8').catch(() => undefined);
	const existingPage = await readFile(pageFile, 'utf8').catch(() => undefined);

	if (existingRaw === undefined && existingPage === undefined) {
		return {error: `no ${kind} '${id}'`};
	}

	// Adopting copies the page whole — frontmatter and prose — so the note is a
	// complete record rather than a stub that would lose the body on re-ingest.
	const adopted = existingRaw === undefined;
	const seed = parseDocument(existingRaw ?? existingPage ?? '');
	const carried = {...seed.data};
	delete carried[SOURCE_FIELD];
	delete carried[HASH_FIELD];

	const merged = {...carried, id, ...patch};
	try {
		validate(merged);
	} catch (caught) {
		return {
			error:
				caught instanceof Error
					? (caught.message.split('\n')[0] ?? 'invalid')
					: String(caught),
		};
	}

	const contents = stringifyDocument({data: merged, body: seed.body});
	await mkdir(path.dirname(rawFile), {recursive: true});
	await writeFile(rawFile, contents, 'utf8');

	if (existingPage === undefined) {
		return {file: rawRelative, adopted, synced: false};
	}

	const page = parseDocument(existingPage);
	await writeFile(
		pageFile,
		stringifyDocument({
			data: {
				...page.data,
				...patch,
				[SOURCE_FIELD]: rawRelative,
				[HASH_FIELD]: hashSource(contents),
			},
			// P6: the page's prose is left exactly as it was.
			body: page.body,
		}),
		'utf8',
	);

	return {file: rawRelative, adopted, synced: true};
}

/**
 * The raw note for a page, adopting it if this is the first time.
 *
 * For `edit`, which opens the buffer: the author should be editing their own
 * copy, and asking them to adopt it first would be a chore in front of a
 * thought.
 */
export async function authoredFile(
	root: string,
	kind: IngestKind,
	id: string,
): Promise<{file: string; adopted: boolean} | {error: string}> {
	const rawRelative = authoringPath(kind, id);
	const rawFile = resolve(root, rawRelative);

	if (
		await readFile(rawFile, 'utf8').then(
			() => true,
			() => false,
		)
	) {
		return {file: rawFile, adopted: false};
	}

	const page = await readFile(resolve(root, corpusPath(kind, id)), 'utf8').catch(
		() => undefined,
	);
	if (page === undefined) {
		return {error: `no ${kind} '${id}'`};
	}

	const {data, body} = parseDocument(page);
	const carried: Record<string, unknown> = {...data, id};
	delete carried[SOURCE_FIELD];
	delete carried[HASH_FIELD];

	await mkdir(path.dirname(rawFile), {recursive: true});
	await writeFile(rawFile, stringifyDocument({data: carried, body}), 'utf8');
	return {file: rawFile, adopted: true};
}
