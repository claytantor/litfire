import {appendFile} from 'node:fs/promises';
import {resolve, VAULT} from './paths.js';

/**
 * The vault's own record of what the tool did to it.
 *
 * `log.md` has existed since the first scaffold and nothing wrote to it. It is
 * owned by the two passes that change the corpus on the author's behalf —
 * `/ingest` and `/curator` — because those are the ones whose work is worth
 * being able to reconstruct later. Replay and the wiki build are pure functions
 * of the corpus and leave no trace worth keeping; a line saying they ran would
 * be noise.
 *
 * Append-only, and never read back by the tool. This is for the author and for
 * `git log`, not a cache: nothing downstream may depend on it, so a truncated
 * or hand-edited log can never break a vault.
 */
export async function appendLog(root: string, entry: string): Promise<void> {
	const stamped = `- ${new Date().toISOString()} — ${entry.trim()}\n`;

	// Silently ignored on failure. A vault whose log is unwritable is a vault
	// with a permissions problem, not a reason to lose the work that was just
	// done (P4).
	await appendFile(resolve(root, VAULT.log), stamped, 'utf8').catch(() => undefined);
}
