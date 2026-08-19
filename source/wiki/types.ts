/**
 * The derived wiki (§4 — this genre's readers build wikis, and so should its
 * authors).
 *
 * Every page here is *computed*: what the corpus says, cross-referenced with
 * what the ledger replayed. It is the reference an author cannot hold in their
 * head — where a skill was acquired, who was in the room, which scenes a place
 * appears in — and it is derived in exactly the sense `ledger/state.md` is.
 * Regenerated wholesale, never hand-edited, never the source of truth for a
 * fact it states.
 *
 * Pages are written as markdown into the vault so three consumers share one
 * artifact: Obsidian browses them, the agents read them off disk (P1 — the
 * filesystem is the API), and the HTTP server renders them for review.
 */

export type WikiKind =
	| 'system'
	| 'character'
	| 'place'
	| 'faction'
	| 'moment'
	| 'artifact'
	| 'skill'
	| 'item'
	| 'arc'
	| 'situation'
	| 'theme'
	| 'index';

export type WikiPage = {
	/** Vault-relative, e.g. `wiki/characters/carl.md`. */
	readonly path: string;
	readonly kind: WikiKind;
	readonly id: string;
	readonly title: string;
	/**
	 * One line, no markdown. This is what the index lists and what the agents
	 * receive as grounding, so it has to carry the computed facts rather than
	 * restate the author's prose — "level 1→7 across 12 scenes, with donut ×8"
	 * earns its tokens; "Carl is a character" does not.
	 */
	readonly summary: string;
	/**
	 * Where this page sits among its own kind, when its kind has an order that is
	 * not alphabetical. A moment's position on the clock, an arc's `order`.
	 * Absent sorts last, then by title — an undated moment has no place in a
	 * sequence, and saying so beats inventing one.
	 */
	readonly sortKey?: bigint;
	/** Full page markdown, headings and all. No frontmatter — the writer adds it. */
	readonly body: string;
};

export type Wiki = {
	readonly pages: readonly WikiPage[];
};
