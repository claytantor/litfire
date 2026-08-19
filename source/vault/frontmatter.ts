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

	// `intAsBigInt` is the only way to read an integer out of YAML without it
	// passing through a double first. The in-world clock reaches ±1 trillion
	// years, which is two orders of magnitude past what a double holds exactly,
	// and the rounding is silent — see `source/time/instant.ts`.
	const parsed: unknown =
		yamlText.trim() === '' ? {} : parse(yamlText, {intAsBigInt: true});
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {data: {}, body};
	}

	return {data: narrow(parsed) as Record<string, unknown>, body};
}

/**
 * Fields that stay bigint. Everything else becomes a number again.
 *
 * Levels, xp, stats and orders are small by nature and are read by schemas,
 * comparisons and arithmetic all over the codebase that expect a number;
 * promoting them wholesale would be a large change for no gain, and mixing the
 * two silently is how `1n + 1` becomes a TypeError in production. So the widening
 * is exactly as broad as the problem: the clock.
 */
const BIGINT_KEYS = new Set(['at']);

function narrow(value: unknown, key?: string): unknown {
	if (typeof value === 'bigint') {
		if (key !== undefined && BIGINT_KEYS.has(key)) {
			return value;
		}
		// Outside the safe range this is already a lie, but it is the same lie the
		// parser told before bigint reading was turned on, and a field that is not
		// the clock has no business holding a number that large. The schemas
		// report it; this is not the place to decide.
		return Number(value);
	}

	if (Array.isArray(value)) {
		return value.map(entry => narrow(entry, key));
	}

	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([name, entry]) => [name, narrow(entry, name)]),
		);
	}

	return value;
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
	// strips. The linking verbs rewrite frontmatter in an author's file, so
	// these two must be exact inverses or the tool would nibble at prose (P6).
	return `${FENCE}\n${yamlText}${FENCE}\n${document.body}`;
}
