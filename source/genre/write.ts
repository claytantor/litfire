import {readFile, writeFile} from 'node:fs/promises';
import {parseDocument, stringifyDocument} from '../vault/frontmatter.js';
import {resolve, VAULT} from '../vault/paths.js';
import type {LexiconKey} from './lexicon.js';

/**
 * Writes to the per-vault idiom override (§3.2).
 *
 * The shipped profile is a default layer and author edits win, so every term
 * change lands in `system/idiom.md` and nothing here ever edits a shipped
 * profile. Terms stay display-only: this changes what a term renders as, never
 * what is stored on disk, which is what lets an author rename `mana` to
 * `essence` without migrating a single corpus file.
 */

const FRESH_BODY = [
	'',
	'# Idiom override',
	'',
	'Anything set here wins over the shipped profile. Terms are display-only —',
	'they never change what is stored on disk, so changing one re-renders the',
	'corpus without migrating a file.',
	'',
].join('\n');

function currentLexicon(data: Record<string, unknown>): Record<string, string> {
	const raw = data['lexicon'];
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return {};
	}

	// Copied key by key rather than cast: a hand-edited file can hold a non-string
	// value, and carrying it through would write invalid YAML back out. Unknown
	// keys survive untouched — this file is the author's, not ours.
	const lexicon: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === 'string') {
			lexicon[key] = value;
		}
	}
	return lexicon;
}

/**
 * Sets or clears one term, returning the value that was there before.
 *
 * `value: undefined` clears. When the last term goes, the `lexicon` key is
 * removed entirely rather than left as an empty map — `loadSetting` treats the
 * mere presence of the key as a declaration, so an empty one would strand the
 * vault on a phantom `<idiom>-local` profile it no longer needs.
 */
export async function writeLexiconTerm(
	root: string,
	key: LexiconKey,
	value: string | undefined,
): Promise<string | undefined> {
	const file = resolve(root, VAULT.idiom);
	const raw = await readFile(file, 'utf8').catch(() => undefined);

	// A scaffolded `idiom.md` carries its frontmatter commented out as a worked
	// example. Parsing drops those comments, so the first `/idiom set` replaces
	// the example with the real thing. The prose body is preserved either way,
	// which is the part the author may have written in (P6).
	const document = raw === undefined ? {data: {}, body: FRESH_BODY} : parseDocument(raw);

	const lexicon = currentLexicon(document.data);
	const previous = lexicon[key];

	if (value === undefined) {
		delete lexicon[key];
	} else {
		lexicon[key] = value;
	}

	const data = {...document.data};
	if (Object.keys(lexicon).length === 0) {
		delete data['lexicon'];
	} else {
		data['lexicon'] = lexicon;
	}

	await writeFile(file, stringifyDocument({data, body: document.body}), 'utf8');
	return previous;
}
