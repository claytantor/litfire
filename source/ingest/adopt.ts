import {readdir, readFile} from 'node:fs/promises';
import type {Proposal} from '../review/types.js';
import {parseDocument, stringifyDocument} from '../vault/frontmatter.js';
import {resolve} from '../vault/paths.js';
import {authoringPath, corpusPath} from './authoring.js';
import {INGEST, INGEST_KINDS, type IngestKind} from './index.js';
import {hashSource, HASH_FIELD, SOURCE_FIELD} from './state.js';

/**
 * Giving an authored corpus page a note to have come from.
 *
 * Raw-first says the corpus is derived: every page points at the note it was
 * built from, and `/ingest` can rebuild it. A vault written before that has the
 * opposite — pages the author typed directly, with no source anywhere. Those
 * pages are not redundant with `raw/`, they are the only copy, and until each
 * has a note behind it the corpus cannot be regenerated and must not be
 * deleted.
 *
 * Adoption closes that gap without a model. The page's own frontmatter and
 * prose become the note; the page is stamped to point at it. Nothing is
 * invented, nothing is summarised, and the result is a vault where `/ingest`
 * reports every page as unchanged — which is the definition of a corpus that is
 * safely disposable.
 *
 * This is the sweep form of what an edit already does one page at a time
 * (`authoredFile`). The difference is only that an author who wants to finish
 * the migration should not have to edit thirty pages to trigger it.
 */

export type Adoption = {
	readonly kind: IngestKind;
	readonly id: string;
	/** The page being adopted, vault-relative. */
	readonly page: string;
	/** The note that would be written for it. */
	readonly note: string;
};

export type AdoptionSkip = {
	readonly kind: IngestKind;
	readonly id: string;
	readonly page: string;
	readonly reason: string;
};

export type AdoptionPlan = {
	/** Two proposals per adoption: the note, then the page that cites it. */
	readonly proposals: readonly Proposal[];
	readonly adopting: readonly Adoption[];
	readonly skipped: readonly AdoptionSkip[];
	/** Pages that already carry provenance. Counted, never listed. */
	readonly alreadyAdopted: number;
};

/**
 * Only the canonical directory, never a legacy one.
 *
 * A situation in `situations/inbox/` needs moving, not adopting — writing a
 * note for it would give one id a note, a canonical page and a legacy page, and
 * make the duplicate harder to resolve rather than easier. `legacy_location`
 * already tells the author to move it; adoption reports it and leaves it alone.
 */
async function pagesOf(root: string, kind: IngestKind): Promise<string[]> {
	const directory = INGEST[kind].to;
	const entries = await readdir(resolve(root, directory), {withFileTypes: true}).catch(
		() => [],
	);

	return entries
		.filter(entry => entry.isFile() && entry.name.endsWith('.md'))
		.filter(entry => entry.name !== 'README.md')
		.map(entry => `${directory}/${entry.name}`)
		.toSorted();
}

/**
 * What adopting these kinds would write, without writing any of it.
 *
 * Every proposal goes through the review gate like any other write (P3). Both
 * halves are proposed rather than the page being stamped silently afterwards:
 * the page genuinely changes, and a write the author never saw is exactly what
 * the gate exists to prevent. Accept-all makes the volume bearable.
 */
export async function planAdoption(
	root: string,
	kinds: readonly IngestKind[] = INGEST_KINDS,
): Promise<AdoptionPlan> {
	const proposals: Proposal[] = [];
	const adopting: Adoption[] = [];
	const skipped: AdoptionSkip[] = [];
	let alreadyAdopted = 0;

	for (const kind of kinds) {
		for (const page of await pagesOf(root, kind)) {
			const contents = await readFile(resolve(root, page), 'utf8').catch(() => undefined);
			if (contents === undefined) {
				continue;
			}

			const {data, body} = parseDocument(contents);
			const stem = page.slice(page.lastIndexOf('/') + 1, -'.md'.length);
			const id = typeof data['id'] === 'string' ? data['id'] : stem;

			if (typeof data[SOURCE_FIELD] === 'string') {
				alreadyAdopted += 1;
				continue;
			}

			// A note that already exists is the author's, and it may say far more
			// than the page ever caught. Overwriting it with a thinner derivative
			// would destroy the very thing raw-first is protecting.
			const note = authoringPath(kind, id);
			const existingNote = await readFile(resolve(root, note), 'utf8').then(
				() => true,
				() => false,
			);
			if (existingNote) {
				skipped.push({
					kind,
					id,
					page,
					reason: `${note} already exists — run /ingest ${kind} ${id} so the page catches up with the note`,
				});
				continue;
			}

			// The whole page, frontmatter and prose, so the note is a complete
			// record rather than a stub whose body the next ingest would drop.
			const carried: Record<string, unknown> = {...data, id};
			delete carried[SOURCE_FIELD];
			delete carried[HASH_FIELD];
			const noteContents = stringifyDocument({data: carried, body});

			proposals.push({
				path: note,
				contents: noteContents,
				confidence: 'high',
				rationale: `${page} has no source — this is its content, moved to where you own it`,
			});
			proposals.push({
				path: corpusPath(kind, id),
				contents: stringifyDocument({
					data: {
						...data,
						id,
						[SOURCE_FIELD]: note,
						[HASH_FIELD]: hashSource(noteContents),
					},
					body,
				}),
				confidence: 'high',
				rationale: `cites ${note}, so /ingest can tell this page is up to date`,
			});
			adopting.push({kind, id, page, note});
		}
	}

	return {proposals, adopting, skipped, alreadyAdopted};
}
