/**
 * Generated-region markers (§11, decision D1).
 *
 * ```
 * <!-- litrpg:status char=carl at=sit-042 -->
 * ...generated block...
 * <!-- /litrpg:status -->
 * ```
 *
 * This syntax is a permanent format commitment, so it is parsed and emitted
 * here and nowhere else. Regeneration replaces only the span between markers,
 * which is what lets a generated block live inside author-owned prose without
 * regeneration clobbering the surrounding text.
 */

export type MarkerBlock = {
	readonly name: string;
	readonly attributes: Readonly<Record<string, string>>;
	readonly content: string;
	readonly start: number;
	readonly end: number;
};

const OPEN = /<!--\s*litrpg:([\w-]+)([^>]*?)-->/g;

function parseAttributes(raw: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of raw.matchAll(/([\w-]+)=([^\s>]+)/g)) {
		const key = match[1];
		const value = match[2];
		if (key !== undefined && value !== undefined) {
			attributes[key] = value;
		}
	}
	return attributes;
}

export function formatMarker(
	name: string,
	attributes: Readonly<Record<string, string>> = {},
): string {
	const rendered = Object.entries(attributes)
		.map(([key, value]) => ` ${key}=${value}`)
		.join('');
	return `<!-- litrpg:${name}${rendered} -->`;
}

export function findBlocks(markdown: string): MarkerBlock[] {
	const blocks: MarkerBlock[] = [];
	OPEN.lastIndex = 0;

	for (const match of markdown.matchAll(OPEN)) {
		const name = match[1];
		if (name === undefined || name.startsWith('/')) {
			continue;
		}

		const openStart = match.index;
		const openEnd = openStart + match[0].length;
		const closeToken = `<!-- /litrpg:${name} -->`;
		const closeStart = markdown.indexOf(closeToken, openEnd);
		if (closeStart === -1) {
			// An unclosed marker is treated as prose rather than swallowing the
			// rest of the file.
			continue;
		}

		blocks.push({
			name,
			attributes: parseAttributes(match[2] ?? ''),
			content: markdown.slice(openEnd, closeStart).replace(/^\n/, '').replace(/\n$/, ''),
			start: openStart,
			end: closeStart + closeToken.length,
		});
	}

	return blocks;
}

/**
 * Replaces the first block with a matching name, or appends one when absent.
 * Everything outside the marked span is preserved byte for byte.
 */
export function upsertBlock(
	markdown: string,
	name: string,
	attributes: Readonly<Record<string, string>>,
	content: string,
): string {
	const rendered = `${formatMarker(name, attributes)}\n${content}\n<!-- /litrpg:${name} -->`;
	const existing = findBlocks(markdown).find(block => block.name === name);

	if (!existing) {
		const separator = markdown.endsWith('\n') || markdown === '' ? '' : '\n';
		return `${markdown}${separator}\n${rendered}\n`;
	}

	return markdown.slice(0, existing.start) + rendered + markdown.slice(existing.end);
}
