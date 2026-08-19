import {parse, stringify} from 'yaml';

export type Document = {
	readonly data: Record<string, unknown>;
	readonly body: string;
};

const FENCE = '---';

/**
 * Splits Obsidian-style YAML frontmatter from the prose body.
 *
 * Deliberately hand-rolled rather than pulled from `gray-matter`: P2 makes
 * round-tripping an author's file without reformatting it a hard requirement,
 * so we need to control exactly what comes back out.
 */
export function parseDocument(raw: string): Document {
	const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
	const normalized = text.replace(/\r\n/g, '\n');

	if (!normalized.startsWith(`${FENCE}\n`)) {
		return {data: {}, body: normalized};
	}

	const end = normalized.indexOf(`\n${FENCE}`, FENCE.length);
	if (end === -1) {
		// An unterminated fence is prose, not broken frontmatter.
		return {data: {}, body: normalized};
	}

	const yamlText = normalized.slice(FENCE.length + 1, end);
	const after = normalized.slice(end + FENCE.length + 1);
	const body = after.startsWith('\n') ? after.slice(1) : after;

	const parsed: unknown = yamlText.trim() === '' ? {} : parse(yamlText);
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {data: {}, body};
	}

	return {data: parsed as Record<string, unknown>, body};
}

export function stringifyDocument(document: Document): string {
	const keys = Object.keys(document.data);
	if (keys.length === 0) {
		return document.body;
	}

	const yamlText = stringify(document.data, {
		// Obsidian Properties round-trips block style cleanly; flow style renders
		// as a raw string in the properties panel.
		defaultStringType: 'PLAIN',
		lineWidth: 0,
	});

	// Exactly one newline after the closing fence, which is what `parseDocument`
	// strips. `/situation place` rewrites frontmatter in an author's file, so
	// these two must be exact inverses or the tool would nibble at prose (P6).
	return `${FENCE}\n${yamlText}${FENCE}\n${document.body}`;
}
