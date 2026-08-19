export type Decision = 'pending' | 'accepted' | 'rejected';

/**
 * One proposed write, before the author has ruled on it.
 *
 * `path` is vault-relative and comes from a model, so it is untrusted input —
 * `resolveInsideVault` in `apply.ts` is what makes it safe, not this type.
 */
export type Proposal = {
	/** Vault-relative path, e.g. `system/stats.md`. */
	readonly path: string;
	/** Complete intended file contents: frontmatter plus body. Empty for a removal. */
	readonly contents: string;
	/**
	 * Remove the file instead of writing it.
	 *
	 * Corpus is generated, and generation makes duplicates: extraction run twice
	 * over one interview slugs the same event two ways and leaves two pages for
	 * one moment. Until this existed no agent could clean that up, because a
	 * proposal could only ever write — so the tool could create the mess and not
	 * remove it.
	 *
	 * A removal is a proposal like any other and lands the same way: through the
	 * gate, as a diff the author accepts one at a time (P3), under the same path
	 * rules that forbid `raw/`, `ledger/`, `wiki/` and anything outside the
	 * vault. Nothing here can delete what the tool did not generate.
	 */
	readonly remove?: boolean;
	readonly confidence?: 'high' | 'low';
	readonly rationale?: string;
};

export type ReviewItem = {
	readonly proposal: Proposal;
	/** Current contents on disk; undefined when the file does not exist yet. */
	readonly existing: string | undefined;
	/** Contents to write — diverges from `proposal.contents` after an edit. */
	readonly contents: string;
	readonly decision: Decision;
	/** True once the author has edited the proposal by hand. */
	readonly edited: boolean;
};

export type ApplyOutcome = {
	readonly written: readonly string[];
	/** Kept separate from `written` so a report never calls a deletion a write. */
	readonly removed: readonly string[];
	readonly skipped: readonly string[];
	readonly failed: readonly {path: string; reason: string}[];
};
