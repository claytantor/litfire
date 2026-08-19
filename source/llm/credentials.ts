import {chmod, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {findProvider} from './catalog.js';
import type {ProviderId} from './types.js';

/**
 * API keys are stored **outside the vault**, deliberately.
 *
 * P1 says the filesystem is the API and everything is markdown on disk — but
 * that governs corpus content, not secrets. §6.4 already anticipates shared
 * corpora, and P2 makes the vault an Obsidian folder people sync and share. A
 * key written into `.litrpg/` would ride along with any of that. So the vault
 * records only which provider and model are selected; the key lives here, at
 * 0600, in the user's config directory.
 */
function credentialsPath(): string {
	const base = process.env['XDG_CONFIG_HOME'] ?? path.join(homedir(), '.config');
	return path.join(base, 'litfire', 'credentials.json');
}

export type StoredKeys = Record<string, string>;

async function readAll(): Promise<StoredKeys> {
	const raw = await readFile(credentialsPath(), 'utf8').catch(() => undefined);
	if (raw === undefined) {
		return {};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === 'string',
			),
		);
	} catch {
		return {};
	}
}

export type KeySource = 'env' | 'file' | 'stored' | 'missing';

export type ResolvedKey = {
	readonly key: string | undefined;
	readonly source: KeySource;
	/** Name of the env var that would take precedence, for display. */
	readonly envVar: string;
	/** Name of its `…_FILE` variant, for display. */
	readonly fileEnvVar: string;
	/** Absolute path the key was read from, when `source` is `file`. */
	readonly path?: string;
	/**
	 * A misconfiguration worth saying out loud rather than falling through from
	 * silently — a `…_FILE` pointing at a path that does not exist otherwise
	 * looks exactly like having set nothing at all.
	 */
	readonly problem?: string;
};

/**
 * The path-valued companion to a key env var: `KIMI_CODE_API_KEY_FILE`.
 *
 * The Docker-secrets convention, and the right shape for anyone who keeps keys
 * in `~/.local/secrets` or a password-manager mount: the secret never enters the
 * environment, never lands in shell history, and never shows up in `ps`. It also
 * means the key is read fresh each time, so rotating the file is enough.
 */
export function keyFileEnvVar(id: ProviderId): string {
	return `${findProvider(id).envVar}_FILE`;
}

/** `~` is expanded here because a value in a config file never reaches a shell. */
function expandHome(candidate: string): string {
	if (candidate === '~') {
		return homedir();
	}
	return candidate.startsWith('~/')
		? path.join(homedir(), candidate.slice(2))
		: candidate;
}

/**
 * Warns when a key file is readable by anyone but its owner.
 *
 * The same standard this module already holds its own credentials file to — it
 * creates that at 0600 and calls a world-readable window "however brief, a
 * window". A file the user pointed us at deserves the same remark, once, rather
 * than a refusal: it is their file and their call.
 */
async function permissionProblem(file: string): Promise<string | undefined> {
	try {
		const {mode} = await stat(file);
		// eslint-disable-next-line no-bitwise
		return (mode & 0o077) === 0
			? undefined
			: `${file} is readable by other users — chmod 600 it`;
	} catch {
		return undefined;
	}
}

/**
 * Precedence: the literal env var, then the file it names, then the stored key.
 *
 * The literal comes first for the same reason the environment already beat the
 * stored key — a one-off `KIMI_CODE_API_KEY=… litfire` has to work even when a
 * shell profile permanently sets the `…_FILE` form. Which one actually supplied
 * the key is reported, so the winner is never a guess.
 */
export async function resolveKey(id: ProviderId): Promise<ResolvedKey> {
	const spec = findProvider(id);
	const fileEnvVar = keyFileEnvVar(id);
	const base = {envVar: spec.envVar, fileEnvVar};

	const fromEnv = process.env[spec.envVar];
	if (fromEnv !== undefined && fromEnv.trim() !== '') {
		return {...base, key: fromEnv.trim(), source: 'env'};
	}

	let problem: string | undefined;
	const configured = process.env[fileEnvVar]?.trim();
	if (configured !== undefined && configured !== '') {
		const file = expandHome(configured);
		const raw = await readFile(file, 'utf8').catch(() => undefined);
		const key = raw?.trim();

		if (key !== undefined && key !== '') {
			const warning = await permissionProblem(file);
			return {
				...base,
				key,
				source: 'file',
				path: file,
				...(warning === undefined ? {} : {problem: warning}),
			};
		}

		problem =
			raw === undefined
				? `${fileEnvVar} points at ${file}, which cannot be read`
				: `${fileEnvVar} points at ${file}, which is empty`;
	}

	// A broken `…_FILE` does not block the stored key (P4) — it is reported and
	// the next source is tried, so a typo in a profile cannot lock anyone out.
	const stored = (await readAll())[id];
	if (stored !== undefined && stored.trim() !== '') {
		return {
			...base,
			key: stored.trim(),
			source: 'stored',
			...(problem === undefined ? {} : {problem}),
		};
	}

	return {
		...base,
		key: undefined,
		source: 'missing',
		...(problem === undefined ? {} : {problem}),
	};
}

export async function saveKey(id: ProviderId, key: string): Promise<string> {
	const file = credentialsPath();
	await mkdir(path.dirname(file), {recursive: true, mode: 0o700});

	const all = await readAll();
	all[id] = key.trim();

	// Create at 0600 up front rather than writing then tightening — a
	// world-readable window, however brief, is a window.
	await writeFile(file, `${JSON.stringify(all, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});
	// writeFile's mode only applies on create; enforce it on an existing file.
	await chmod(file, 0o600);

	return file;
}

export async function forgetKey(id: ProviderId): Promise<void> {
	const all = await readAll();
	if (!(id in all)) {
		return;
	}
	delete all[id];
	const file = credentialsPath();
	await writeFile(file, `${JSON.stringify(all, null, 2)}\n`, {
		encoding: 'utf8',
		mode: 0o600,
	});
	await chmod(file, 0o600);
}

/** Never render a raw key. */
export function maskKey(key: string): string {
	if (key.length <= 8) {
		return '•'.repeat(key.length);
	}
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export {credentialsPath};
