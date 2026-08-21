import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {
	arcSchema,
	artifactSchema,
	chapterSchema,
	characterSchema,
	factionSchema,
	placeSchema,
	situationSchema,
	systemSchema,
	themeSchema,
	DEFAULT_SYSTEM_ID,
	momentSchema,
	type Arc,
	type Artifact,
	type Chapter,
	type Character,
	type Faction,
	type Place,
	type Situation,
	type SystemDef,
	type Theme,
	type Moment,
} from '../domain/schema.js';
import {extractFormulas} from '../system/formulas.js';
import type {Formula} from '../system/sandbox.js';
import {parseDocument} from './frontmatter.js';
import {resolve, VAULT} from './paths.js';
import {timeSchema, type TimeBinding} from '../time/binding.js';

export type LoadIssue = {
	readonly file: string;
	readonly message: string;
};

/**
 * Where a loaded page came from.
 *
 * The schemas carry an id and nothing about the file, which is right until two
 * files declare the same id — at which point every report the tool can make is
 * "there are two of these somewhere". Naming them is the difference between a
 * finding an author can act on and one they have to go hunting for.
 */
export type Source = {
	/** Vault-relative, so it can be printed and proposed. */
	readonly path: string;
	readonly kind: string;
	readonly id: string;
	/** The filename without `.md`. Equal to `id` in a tidy vault. */
	readonly stem: string;
};

export type Vault = {
	readonly root: string;
	/**
	 * Every character system in the vault, id-sorted. Never empty: a vault with
	 * no system files still yields one, so nothing downstream has to special-case
	 * "there is no system yet".
	 */
	readonly systems: readonly SystemDef[];
	readonly formulas: readonly Formula[];
	readonly moments: readonly Moment[];
	/** How this vault reads its clock. Absent means raw seconds from origin. */
	readonly time: TimeBinding | undefined;
	readonly arcs: readonly Arc[];
	readonly situations: readonly Situation[];
	readonly characters: readonly Character[];
	readonly factions: readonly Faction[];
	/** Somewhere a scene happens. Body is prose; only id and name are data. */
	readonly places: readonly Place[];
	readonly artifacts: readonly Artifact[];
	readonly themes: readonly Theme[];
	readonly chapters: readonly Chapter[];
	/** Where each page was read from, for reports that have to name a file. */
	readonly sources: readonly Source[];
	/**
	 * Files read from a superseded layout, vault-relative. Empty in a tidy vault.
	 *
	 * Recorded here rather than discovered by the checks because only the loader
	 * knows which legacy readers actually fired — an empty `system/stats.md` is
	 * not the same as one holding stats, and only one of those is worth
	 * reporting.
	 */
	readonly legacy: readonly string[];
	/** Malformed files are reported, never thrown — the author keeps working. */
	readonly issues: readonly LoadIssue[];
};

async function readIfPresent(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

async function listMarkdown(directory: string): Promise<string[]> {
	try {
		const entries = await readdir(directory, {withFileTypes: true});
		return entries
			.filter(entry => entry.isFile() && entry.name.endsWith('.md'))
			.map(entry => path.join(directory, entry.name))
			.toSorted();
	} catch {
		return [];
	}
}

/**
 * Reads one frontmatter-bearing file into a schema, recording a load issue
 * rather than throwing (P4: nothing blocks the author).
 */
async function loadOne<T>(
	file: string,
	schema: {parse: (value: unknown) => T},
	issues: LoadIssue[],
	fallbackId?: string,
): Promise<T | undefined> {
	const raw = await readIfPresent(file);
	if (raw === undefined) {
		return undefined;
	}

	try {
		const {data} = parseDocument(raw);
		if (fallbackId !== undefined && data['id'] === undefined) {
			data['id'] = fallbackId;
		}
		return schema.parse(data);
	} catch (caught) {
		issues.push({
			file,
			message: caught instanceof Error ? caught.message : String(caught),
		});
		return undefined;
	}
}

async function loadDirectory<T>(
	directory: string,
	schema: {parse: (value: unknown) => T},
	issues: LoadIssue[],
	track?: {readonly kind: string; readonly into: Source[]; readonly root: string},
): Promise<T[]> {
	const loaded: T[] = [];
	for (const file of await listMarkdown(directory)) {
		const stem = path.basename(file, '.md');
		const one = await loadOne(file, schema, issues, stem);
		if (one !== undefined) {
			loaded.push(one);
			if (track !== undefined) {
				const id = (one as {id?: unknown}).id;
				track.into.push({
					path: path.relative(track.root, file).split(path.sep).join('/'),
					kind: track.kind,
					id: typeof id === 'string' ? id : stem,
					stem,
				});
			}
		}
	}
	return loaded;
}

/**
 * Reads `systems/<id>.md`: schema from the frontmatter, formulas from the body.
 *
 * The body doubles as the formula file because a system's curve and the prose
 * explaining it belong on one page — and `extractFormulas` reads fenced blocks
 * out of any string, so nothing new is needed to find them.
 */
async function loadSystems(
	root: string,
	issues: LoadIssue[],
): Promise<{systems: SystemDef[]; formulas: Formula[]}> {
	const systems: SystemDef[] = [];
	const formulas: Formula[] = [];

	for (const file of await listMarkdown(resolve(root, VAULT.systems))) {
		const raw = await readIfPresent(file);
		if (raw === undefined) {
			continue;
		}

		const {data, body} = parseDocument(raw);
		data['id'] ??= path.basename(file, '.md');

		try {
			const system = systemSchema.parse(data);
			systems.push(system);
			for (const formula of extractFormulas(body)) {
				formulas.push({...formula, system: system.id});
			}
		} catch (caught) {
			issues.push({
				file,
				message: caught instanceof Error ? caught.message : String(caught),
			});
		}
	}

	return {systems, formulas};
}

export async function loadVault(root: string): Promise<Vault> {
	const issues: LoadIssue[] = [];
	const sources: Source[] = [];
	const legacy: string[] = [];

	// The legacy system is spread across four files so each is independently
	// editable in Obsidian; they are merged into one SystemDef here.
	const statsDocument = await loadOne(
		resolve(root, VAULT.stats),
		{parse: value => systemSchema.pick({stats: true}).parse(value)},
		issues,
	);
	const skillsDocument = await loadOne(
		resolve(root, VAULT.skills),
		{parse: value => systemSchema.pick({skills: true}).parse(value)},
		issues,
	);
	const curvesDocument = await loadOne(
		resolve(root, VAULT.curves),
		{parse: value => systemSchema.pick({curves: true}).parse({curves: value})},
		issues,
	);

	const time = await loadOne(resolve(root, VAULT.time), timeSchema, issues);

	const {systems: named, formulas: scopedFormulas} = await loadSystems(root, issues);

	// The shared file stays unscoped, so a formula in it is reachable from every
	// system — the escape hatch for a rule that genuinely is universal.
	const formulasRaw = await readIfPresent(resolve(root, VAULT.formulas));
	const formulas: Formula[] = [
		...(formulasRaw ? extractFormulas(formulasRaw) : []),
		...scopedFormulas,
	];

	// The legacy files become a system only when they hold something, so a vault
	// that has moved wholly to `systems/` is not haunted by an empty one. When
	// nothing at all is defined, one empty system is still produced: downstream
	// code should never have to ask whether a character has a system to be under.
	const legacySystem = systemSchema.parse({
		id: DEFAULT_SYSTEM_ID,
		stats: statsDocument?.stats ?? [],
		skills: skillsDocument?.skills ?? [],
		curves: curvesDocument?.curves,
	});
	const legacyIsReal =
		statsDocument !== undefined ||
		skillsDocument !== undefined ||
		curvesDocument !== undefined;

	if (statsDocument !== undefined) {
		legacy.push(VAULT.stats);
	}
	if (skillsDocument !== undefined) {
		legacy.push(VAULT.skills);
	}
	if (curvesDocument !== undefined) {
		legacy.push(VAULT.curves);
	}

	const systems = (
		legacyIsReal || named.length === 0 ? [legacySystem, ...named] : named
	).toSorted((a, b) => a.id.localeCompare(b.id));

	// A page each, plus whatever the pre-moments list file still holds. Pages win
	// on a clash: an author who has split a moment out has said which they mean.
	const moments: Moment[] = await loadDirectory(
		resolve(root, VAULT.moments),
		momentSchema,
		issues,
		{kind: 'moment', into: sources, root},
	);
	const known = new Set(moments.map(moment => moment.id));

	const legacyRaw = await readIfPresent(resolve(root, VAULT.legacyMoments));
	if (legacyRaw) {
		legacy.push(VAULT.legacyMoments);
		const {data} = parseDocument(legacyRaw);
		const list = Array.isArray(data['world_events']) ? data['world_events'] : [];
		for (const entry of list) {
			try {
				const moment = momentSchema.parse(entry);
				if (!known.has(moment.id)) {
					moments.push(moment);
					known.add(moment.id);
				}
			} catch (caught) {
				issues.push({
					file: VAULT.legacyMoments,
					message: caught instanceof Error ? caught.message : String(caught),
				});
			}
		}
	}
	moments.sort((a, b) => a.id.localeCompare(b.id));

	const [arcs, characters, factions, places, artifacts, themes, placed, inbox, chapters] =
		await Promise.all([
			loadDirectory(resolve(root, VAULT.arcs), arcSchema, issues, {
				kind: 'arc',
				into: sources,
				root,
			}),
			loadDirectory(resolve(root, VAULT.characters), characterSchema, issues, {
				kind: 'character',
				into: sources,
				root,
			}),
			loadDirectory(resolve(root, VAULT.factions), factionSchema, issues, {
				kind: 'faction',
				into: sources,
				root,
			}),
			loadDirectory(resolve(root, VAULT.places), placeSchema, issues, {
				kind: 'place',
				into: sources,
				root,
			}),
			loadDirectory(resolve(root, VAULT.artifacts), artifactSchema, issues, {
				kind: 'artifact',
				into: sources,
				root,
			}),
			loadDirectory(resolve(root, VAULT.themes), themeSchema, issues, {
				kind: 'theme',
				into: sources,
				root,
			}),
			loadDirectory(resolve(root, VAULT.situations), situationSchema, issues, {
				kind: 'situation',
				into: sources,
				root,
			}),
			loadDirectory(resolve(root, VAULT.inbox), situationSchema, issues, {
				kind: 'situation',
				into: sources,
				root,
			}),
			loadDirectory(resolve(root, VAULT.chapters), chapterSchema, issues, {
				kind: 'chapter',
				into: sources,
				root,
			}),
		]);

	return {
		root,
		systems,
		formulas,
		moments,
		time,
		arcs,
		// Inbox situations carry no arc, so they replay as unplaced (§5).
		situations: [...placed, ...inbox.map(s => ({...s, arc: undefined}))],
		characters,
		factions,
		places,
		artifacts,
		themes,
		chapters,
		sources,
		legacy,
		issues,
	};
}
