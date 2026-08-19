/**
 * The `/reviewer` agent: a literary editor working over the whole rendered
 * corpus.
 *
 * Named for the job rather than the craft. `$EDITOR` is the program the author
 * writes in, and having one word mean both that and the model reading the
 * finished pages made every sentence about either of them ambiguous.
 *
 * It answers questions, surfaces inconsistencies, and proposes corrections —
 * but the writes it may propose are deliberately narrow. Everything else in
 * this tool treats a model proposal as "the author will review it"; here the
 * proposal is additionally *structurally* constrained before the author ever
 * sees it, because "fix my spelling" and "rewrite my prose" are one sloppy
 * generation apart, and only one of them was asked for.
 */

/** One corpus file, as it appears in the map the reviewer always sees. */
export type CorpusEntry = {
	/** Vault-relative, e.g. `situations/sit-014.md`. */
	readonly path: string;
	/** Which part of the corpus this is: `situation`, `character`, `theme`, … */
	readonly kind: string;
	readonly id: string | undefined;
	readonly title: string | undefined;
	readonly chars: number;
	readonly frontmatter: Readonly<Record<string, unknown>>;
};

export type CorpusMap = {
	readonly entries: readonly CorpusEntry[];
	/** Deterministic findings, so the reviewer can discuss them without re-deriving. */
	readonly openQuestions: readonly string[];
	/** `/init` placeholders withheld — they are not the author's world. */
	readonly examplesSkipped: number;
};

/**
 * The verdict on whether a proposed rewrite is a *correction*.
 *
 * Deliberately not a boolean: a refusal has to say what tripped it, both so the
 * author can see the reviewer overstepped and so a false positive is debuggable
 * rather than mysterious.
 */
export type GuardVerdict =
	| {readonly ok: true; readonly changedLines: number}
	| {readonly ok: false; readonly reason: string; readonly line: number | undefined};
