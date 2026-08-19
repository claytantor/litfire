import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {resolve, VAULT} from './paths.js';

/**
 * Command history, per vault.
 *
 * `.litrpg/` rather than `~/.litfire/` because history is vault-shaped:
 * `/character carl` and `/chapter new sit-014` mean nothing in another book, and
 * mixing two manuscripts' histories in one list makes arrowing back a lottery.
 * DoD 11 says deleting `.litrpg/` costs only cache, and this is cache — losing
 * it costs convenience and nothing else.
 */

const FILE = `${VAULT.meta}/history.json`;

/** Long enough to arrow back to yesterday, short enough to stay a small file. */
const MAX_ENTRIES = 200;

export async function readHistory(root: string): Promise<string[]> {
	const raw = await readFile(resolve(root, FILE), 'utf8').catch(() => undefined);
	if (raw === undefined) {
		return [];
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: [];
	} catch {
		// A corrupt history is not worth a word to the author — they came here to
		// write, and an empty list behaves exactly like a fresh vault.
		return [];
	}
}

/**
 * Appends one line, newest last.
 *
 * Consecutive duplicates collapse the way a shell's do: running `/lint` four
 * times should cost one slot, not four, or arrowing back walks through the same
 * command repeatedly before reaching anything else.
 */
export function extendHistory(history: readonly string[], line: string): string[] {
	const trimmed = line.trim();
	if (trimmed === '' || history.at(-1) === trimmed) {
		return [...history];
	}
	return [...history, trimmed].slice(-MAX_ENTRIES);
}

export async function appendHistory(root: string, line: string): Promise<string[]> {
	const next = extendHistory(await readHistory(root), line);

	await mkdir(path.dirname(resolve(root, FILE)), {recursive: true}).catch(
		() => undefined,
	);
	// Failing to record history must never surface: it is the least important
	// write this tool makes, and an unwritable vault is already being reported by
	// something that matters more.
	await writeFile(resolve(root, FILE), `${JSON.stringify(next)}\n`, 'utf8').catch(
		() => undefined,
	);

	return next;
}
