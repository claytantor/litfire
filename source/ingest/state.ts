import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {parseDocument, stringifyDocument} from '../vault/frontmatter.js';
import {resolve} from '../vault/paths.js';
import {INGEST, type IngestKind, type RawDocument} from './index.js';

/**
 * What a page records about where it came from.
 *
 * `source` is the raw note; `source_hash` is what that note said at the time.
 * Together they are the whole of idempotency: an ingest can tell, without
 * calling a model, whether a note has anything new to say.
 */
export const SOURCE_FIELD = 'source';
export const HASH_FIELD = 'source_hash';

/**
 * A short digest of a note's contents.
 *
 * Twelve hex characters, which is far more than enough to notice an edit and
 * short enough to sit in frontmatter an author reads. This is not a security
 * boundary — nobody is trying to forge a note past their own vault.
 *
 * Line endings are normalised so a file round-tripped through a different
 * editor does not read as changed.
 */
export function hashSource(contents: string): string {
	return createHash('sha256')
		.update(contents.replaceAll('\r\n', '\n').trim())
		.digest('hex')
		.slice(0, 12);
}

/**
 * The sources the corpus already reflects, and what they said.
 *
 * Read from the corpus rather than from a cache in `.litrpg/`, deliberately:
 * the pages *are* the record. A vault someone has pulled from git, or edited in
 * Obsidian, or restored from backup carries its own ingest state with it, and
 * there is no separate file to fall out of step.
 */
export async function readIngestState(
	root: string,
	kind: IngestKind,
): Promise<Map<string, string>> {
	const directory = resolve(root, INGEST[kind].to);
	const entries = await readdir(directory, {withFileTypes: true}).catch(() => []);
	const state = new Map<string, string>();

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) {
			continue;
		}
		const raw = await readFile(path.join(directory, entry.name), 'utf8').catch(
			() => undefined,
		);
		if (raw === undefined) {
			continue;
		}

		const {data} = parseDocument(raw);
		const source = data[SOURCE_FIELD];
		const hash = data[HASH_FIELD];
		if (typeof source === 'string' && typeof hash === 'string') {
			state.set(source, hash);
		}
	}

	return state;
}

export type SourceStatus = 'new' | 'changed' | 'unchanged';

/** Whether a note has anything the corpus has not already been told. */
export function statusOf(
	state: ReadonlyMap<string, string>,
	sourcePath: string,
	contents: string,
): SourceStatus {
	const recorded = state.get(sourcePath);
	if (recorded === undefined) {
		return 'new';
	}
	return recorded === hashSource(contents) ? 'unchanged' : 'changed';
}

/**
 * Stamps provenance onto a proposal's frontmatter.
 *
 * Done in code after the model returns, never asked of the model. It cannot
 * compute a digest, and asking it to would be exactly the arithmetic-by-model
 * this tool exists to avoid — the page would carry a plausible-looking hash
 * that meant nothing, and every later ingest would trust it.
 *
 * The body is untouched.
 */
export function stampSource(contents: string, sourcePath: string, hash: string): string {
	const {data, body} = parseDocument(contents);
	return stringifyDocument({
		data: {...data, [SOURCE_FIELD]: sourcePath, [HASH_FIELD]: hash},
		body,
	});
}

/**
 * Puts the author's own frontmatter back on top of what the model produced.
 *
 * The instruction asks it to carry those fields through, and it usually does.
 * "Usually" is not a guarantee, and this is a decision the author made — a
 * `moment:` they set by command or by hand should not depend on a model
 * remembering. Enforcing it in code costs nothing and removes the question.
 *
 * Applied only when the page is the one the note is *about*: a note named
 * `sit-001.md` speaks for `sit-001`. A compendium that produces nine moments
 * says nothing in particular about any one of them, so its frontmatter — if it
 * has any — is left to the model to interpret.
 *
 * `source` and `source_hash` are excluded. They are the tool's bookkeeping and
 * an author writing them into a note should not be able to forge provenance.
 */
export function honourAuthored(contents: string, document: RawDocument): string {
	const authored = Object.entries(document.data).filter(
		([key]) => key !== SOURCE_FIELD && key !== HASH_FIELD,
	);
	if (authored.length === 0) {
		return contents;
	}

	const {data, body} = parseDocument(contents);
	const stem = path.basename(document.path, '.md');
	if (data['id'] !== stem) {
		return contents;
	}

	return stringifyDocument({data: {...data, ...Object.fromEntries(authored)}, body});
}
