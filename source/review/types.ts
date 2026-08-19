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
	/** Complete intended file contents: frontmatter plus body. */
	readonly contents: string;
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
	readonly skipped: readonly string[];
	readonly failed: readonly {path: string; reason: string}[];
};
