import type {Formula} from './sandbox.js';

/**
 * Pulls ```js id=<name>``` blocks out of `system/formulas.md` (§6.4).
 *
 * Blocks without an `id=` are ignored rather than rejected, so an author can
 * keep illustrative snippets in the same file.
 */
export function extractFormulas(markdown: string): Formula[] {
	const formulas: Formula[] = [];
	// Tolerates ``` and ```` fences, and any attribute order after the language.
	const pattern = /^(`{3,})js\s+([^\n]*)\n([\S\s]*?)^\1\s*$/gm;

	for (const match of markdown.matchAll(pattern)) {
		const attributes = match[2] ?? '';
		const source = match[3] ?? '';
		const id = /(?:^|\s)id=([\w-]+)/.exec(attributes)?.[1];
		if (id) {
			formulas.push({id, source: source.trim()});
		}
	}

	return formulas;
}
