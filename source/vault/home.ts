import {homedir} from 'node:os';
import path from 'node:path';

/**
 * litfire's own directory, outside every vault.
 *
 * Cross-project state lives here rather than in a vault for the same reason
 * credentials do: a vault is a folder the author may share or sync, and the
 * list of their *other* books does not belong in it.
 *
 * `LITFIRE_HOME` overrides it — that is what the tests use, and it lets an
 * author keep separate state per machine role without symlinking.
 */
export function litfireHome(): string {
	const override = process.env['LITFIRE_HOME'];
	return override !== undefined && override.trim() !== ''
		? path.resolve(override.trim())
		: path.join(homedir(), '.litfire');
}

/** Where the last-opened project and the recents list are recorded. */
export function statePath(): string {
	return path.join(litfireHome(), 'state.json');
}

/**
 * The pre-`~/.litfire` location of the recents list.
 *
 * Read once, to migrate. API keys were never moved out of here — key material
 * does not get relocated as a side effect of a convenience feature.
 */
export function legacyRecentPath(): string {
	const base = process.env['XDG_CONFIG_HOME'] ?? path.join(homedir(), '.config');
	return path.join(base, 'litfire', 'recent.json');
}
