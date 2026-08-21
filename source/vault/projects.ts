import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {legacyRecentPath, litfireHome, statePath} from './home.js';
import {VAULT} from './paths.js';

/**
 * Resolves an author-supplied path.
 *
 * Relative paths resolve against the *current* project, which makes `/project`
 * behave like `cd` — `../other-book` does what it looks like. At startup the
 * current project is the launch directory, so a bare relative path is still
 * relative to where litfire was started.
 */
export function resolveProjectPath(current: string, candidate: string): string {
	const trimmed = candidate.trim();
	if (trimmed === '') {
		return current;
	}

	// `~` is shell syntax the TUI has to expand itself.
	if (trimmed === '~') {
		return homedir();
	}
	if (trimmed.startsWith('~/')) {
		return path.join(homedir(), trimmed.slice(2));
	}

	return path.resolve(current, trimmed);
}

export type ProjectState = 'vault' | 'empty' | 'missing' | 'not-a-directory';

/**
 * Classifies a path so the caller can react without a second stat.
 *
 * `empty` is a real and useful state: switching to a directory that is not yet
 * a vault is how an author starts a new book, and `/init` is the next step.
 */
export async function inspectProject(root: string): Promise<ProjectState> {
	const info = await stat(root).catch(() => undefined);
	if (info === undefined) {
		return 'missing';
	}
	if (!info.isDirectory()) {
		return 'not-a-directory';
	}

	// Deliberately NOT `.litrpg/`: that directory is created as a side effect of
	// `/provider` and interview metrics, so treating it as a marker reports any
	// directory litfire has merely been run in as a vault. `system/` and
	// `index.md` are written only by `/init`, and survive deleting the cache
	// (DoD 11).
	// `VAULT.legacySetting` is here for the same reason it is still read: a vault
	// written before `setting/` must not stop being recognised as a vault.
	for (const marker of [VAULT.setting, VAULT.legacySetting, VAULT.index]) {
		if (await stat(path.join(root, marker)).catch(() => undefined)) {
			return 'vault';
		}
	}

	return 'empty';
}

// ---------------------------------------------------------------------------
// Cross-project state: ~/.litfire/state.json
// ---------------------------------------------------------------------------

const stateSchema = z.object({
	version: z.number().default(1),
	/** The project a bare `litfire` reopens. */
	lastProject: z.string().nullable().default(null),
	projects: z.array(z.string()).default([]),
});

export type LitfireState = z.infer<typeof stateSchema>;

const MAX_RECENT = 10;

const EMPTY_STATE: LitfireState = {version: 1, lastProject: null, projects: []};

/** Shape of the old `recent.json`, read once so the list survives the move. */
const legacySchema = z.object({projects: z.array(z.string()).default([])});

export async function readState(): Promise<LitfireState> {
	const raw = await readFile(statePath(), 'utf8').catch(() => undefined);
	if (raw !== undefined) {
		try {
			return stateSchema.parse(JSON.parse(raw));
		} catch {
			// A corrupt state file is not worth an error on startup: the only cost
			// of ignoring it is reopening the wrong directory once.
			return EMPTY_STATE;
		}
	}

	// Nothing at the new path — inherit the pre-`~/.litfire` recents list rather
	// than silently forgetting every project the author has opened.
	const legacy = await readFile(legacyRecentPath(), 'utf8').catch(() => undefined);
	if (legacy === undefined) {
		return EMPTY_STATE;
	}

	let inherited: string[];
	try {
		inherited = legacySchema.parse(JSON.parse(legacy)).projects;
	} catch {
		return EMPTY_STATE;
	}

	// Only what still exists comes across. The old list recorded every directory
	// litfire was ever started in, so it accumulated paths that are long gone.
	const projects: string[] = [];
	let lastProject: string | null = null;
	for (const entry of inherited) {
		const state = await inspectProject(entry);
		if (state === 'missing') {
			continue;
		}
		projects.push(entry);
		lastProject ??= state === 'vault' ? entry : null;
	}

	return {version: 1, lastProject, projects};
}

async function writeState(state: LitfireState): Promise<void> {
	const file = statePath();
	await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
	await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function readRecent(): Promise<string[]> {
	return (await readState()).projects;
}

/** The project a bare `litfire` should reopen, if one was recorded. */
export async function readLastProject(): Promise<string | undefined> {
	return (await readState()).lastProject ?? undefined;
}

/**
 * Records a visit: most recent first, de-duplicated, capped.
 *
 * `lastProject` only advances for an actual vault. Running litfire in a plain
 * directory — to `/init` it, or by accident — must not make that directory the
 * thing a bare `litfire` reopens tomorrow.
 */
export async function rememberProject(root: string): Promise<void> {
	const resolved = path.resolve(root);
	const state = await readState();
	const projects = [
		resolved,
		...state.projects.filter(entry => entry !== resolved),
	].slice(0, MAX_RECENT);

	const isVault = (await inspectProject(resolved)) === 'vault';
	await writeState({
		version: 1,
		lastProject: isVault ? resolved : state.lastProject,
		projects,
	});
}

/** Drops entries that no longer exist, so the list stays useful. */
export async function readLiveRecent(): Promise<{root: string; state: ProjectState}[]> {
	const entries = await readRecent();
	const live: {root: string; state: ProjectState}[] = [];
	for (const entry of entries) {
		const state = await inspectProject(entry);
		if (state !== 'missing') {
			live.push({root: entry, state});
		}
	}
	return live;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * How the launch directory was chosen. The UI reports this, because opening a
 * directory other than the one the author is standing in is a surprise unless
 * it says so.
 */
export type StartupMode =
	/** `litfire <path>` — an explicit target. */
	| 'argument'
	/** `litfire .` or `litfire` with nothing remembered — the launch directory. */
	| 'cwd'
	/** Bare `litfire` — reopened the last vault. */
	| 'last'
	/** Bare `litfire`, but the remembered vault is gone. */
	| 'stale';

export type Startup = {
	readonly root: string;
	readonly mode: StartupMode;
	/** The remembered path that could not be opened, when mode is `stale`. */
	readonly missing?: string;
};

/**
 * Resolves what `litfire`, `litfire .`, and `litfire <path>` each open.
 *
 * A path argument always wins — including `.`, which is how an author says
 * "this directory, not wherever I was last". Only a bare invocation consults
 * `~/.litfire`, and a remembered project that has since been deleted or moved
 * falls back to the launch directory rather than failing to start.
 */
export async function resolveStartup(
	argument: string | undefined,
	cwd: string,
): Promise<Startup> {
	if (argument !== undefined && argument.trim() !== '') {
		const root = resolveProjectPath(cwd, argument);
		return {root, mode: root === path.resolve(cwd) ? 'cwd' : 'argument'};
	}

	const last = await readLastProject();
	if (last === undefined) {
		return {root: path.resolve(cwd), mode: 'cwd'};
	}
	if ((await inspectProject(last)) === 'vault') {
		return {root: last, mode: 'last'};
	}

	return {root: path.resolve(cwd), mode: 'stale', missing: last};
}

/** Shortens a path for display, collapsing the home directory to `~`. */
export function displayPath(root: string): string {
	const home = homedir();
	return root === home
		? '~'
		: root.startsWith(`${home}${path.sep}`)
			? `~${root.slice(home.length)}`
			: root;
}

/** The name shown in the footer. */
export function projectName(root: string): string {
	return path.basename(path.resolve(root)) || root;
}

export {litfireHome, statePath};
