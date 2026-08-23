import {readFile, writeFile} from 'node:fs/promises';
import {term} from '../genre/lexicon.js';
import type {SystemDef} from '../domain/schema.js';
import type {ResolvedProfile} from '../genre/types.js';
import type {CharacterState} from '../ledger/replay.js';
import {upsertBlock} from '../vault/markers.js';
import {formatStat, renderInterface} from './interface.js';

export type StatusTemplate = 'sheet' | 'hud' | 'inline';

/**
 * LEXICON-ON-DISK CARVE-OUT.
 *
 * `applyLexicon`'s doc comment (genre/lexicon.ts) says substitution is "display
 * and prompting only... this never runs over anything on its way to disk" — the
 * rule that keeps a profile change able to re-render the whole corpus without a
 * migration, because canonical keys are what's actually stored.
 *
 * A rendered status block is written to disk (inside a situation file) carrying
 * display terms — "iteration" instead of "level" — which looks like exactly the
 * violation that rule exists to prevent. It isn't, for one reason: the block sits
 * between `<!-- litrpg:status -->` markers (D1, markers.ts), which makes it a
 * GENERATED region, not authored prose. Nothing parses it back into ledger
 * state — `upsertBlock` only ever replaces the span wholesale — so the display
 * words never become an alternate source of truth. The canonical keys on
 * `CharacterState` remain the only thing a profile change or a replay ever reads.
 * Re-rendering after an `/idiom` change simply overwrites the block, the same way
 * `ledger/projections.ts` overwrites `state.md`.
 *
 * (Proposed addition to lexicon.ts's `applyLexicon` doc comment, for whoever
 * edits that file: "Generated regions bounded by vault/markers.ts markers are the
 * one exception — they are regenerated wholesale and never parsed back into
 * state, so writing display terms into one is not writing over canonical data.
 * See system/status.ts.")
 */

/**
 * Label choices, since only `advancement` is specified by contract:
 *
 * - level/iteration line uses `advancement` (arcane "level", technological
 *   "iteration") — the contract's own example.
 * - the skills heading uses `ability_group` ("school", "stack") rather than
 *   `ability` ("spell", "protocol"): `ability` names one item on the list, and
 *   there is no `ability_plural` key to head a list of them, whereas
 *   `ability_group` already reads as a collective term and needs no invented
 *   plural.
 * - "stats" and "items" have no lexicon key of their own (§4's lexicon schema
 *   defines none), so they stay neutral English rather than guessing a mapping
 *   the author never supplied.
 */
function levelLine(character: CharacterState, profile: ResolvedProfile): string {
	const advancement = term(profile, 'advancement');
	return `${advancement} ${character.level}, xp ${character.xp}`;
}

/**
 * Full stat sheet (§7 "status screen / stat block"). A blockquote so the block
 * reads as an in-world pop-up window rather than a table dumped into prose.
 *
 * Every collection that can be empty is omitted rather than shown with a
 * placeholder — unlike `projections.ts`'s `renderState`, which is a standing
 * index page where "_none_" documents the absence. A status block only appears
 * when a character exists to show one, so an empty section here is just noise a
 * reader has to skip past.
 *
 * HARD PROHIBITION: `CharacterState.stats` carries no maximums (ledger/replay.ts)
 * — it is a flat current-value map. There is nothing to divide by, so no line
 * below ever renders a "/" between two numbers; a bar or an "N / N" would be a
 * number this module invented, not one the author wrote.
 */
function renderSheet(
	character: CharacterState,
	profile: ResolvedProfile,
	displayName: string,
): string {
	const lines: string[] = [`> **${displayName}** — ${levelLine(character, profile)}`];

	const stats = Object.entries(character.stats).toSorted(([a], [b]) =>
		a.localeCompare(b),
	);
	if (stats.length > 0) {
		lines.push('>', '> | stat | value |', '> | --- | --- |');
		for (const [id, value] of stats) {
			lines.push(`> | ${id} | ${formatStat(value)} |`);
		}
	}

	if (character.skills.length > 0) {
		lines.push(
			'>',
			`> ${term(profile, 'ability_group')}: ${character.skills.join(', ')}`,
		);
	}

	const items = Object.entries(character.items).filter(([, quantity]) => quantity > 0);
	if (items.length > 0) {
		const rendered = items.map(([id, quantity]) => `${id} ×${quantity}`).join(', ');
		lines.push('>', `> items: ${rendered}`);
	}

	return lines.join('\n');
}

/**
 * Compact HUD (~4 lines). Resources are the archetype's own subset of stats
 * (genre/profiles.ts `archetypes.resources`) — e.g. arcane's mana/stamina,
 * technological's charge/heat — kept in the profile's declared order so the
 * primary resource leads. Items are excluded by contract: a HUD is a glance, not
 * an inventory.
 */
function renderHud(
	character: CharacterState,
	profile: ResolvedProfile,
	displayName: string,
): string {
	const lines = [`${displayName} — ${levelLine(character, profile)}`];

	const resources = profile.archetypes.resources.flatMap(id => {
		const value = character.stats[id];
		return value === undefined ? [] : [`${id} ${formatStat(value)}`];
	});

	if (resources.length > 0) {
		lines.push(resources.join(', '));
	}

	return lines.join('\n');
}

/** One line, meant to sit mid-sentence in a situation's prose. */
function renderInline(
	character: CharacterState,
	profile: ResolvedProfile,
	displayName: string,
): string {
	return `${displayName} — ${levelLine(character, profile)}`;
}

/**
 * Renders a character's replayed state (ledger/replay.ts `CharacterState`) into
 * one of the three status templates a profile can choose (`status_template`).
 *
 * `character` is the only data source — see the HARD PROHIBITION note above
 * `renderSheet`: nothing here fabricates a maximum, a percentage, or a bar.
 */
export function renderStatusBlock(
	character: CharacterState,
	options: {
		readonly profile: ResolvedProfile;
		readonly template?: StatusTemplate;
		readonly displayName?: string;
		/**
		 * The screen this character's system draws, when it draws one.
		 *
		 * It wins over the profile's choice of the three built-ins, because it is
		 * the author's own and those are a guess made from the idiom. Absent, the
		 * guess is still better than nothing.
		 */
		readonly drawn?: string | undefined;
		/** The system whose bands turn a value into a reading. */
		readonly system?: SystemDef | undefined;
	},
): string {
	const displayName = options.displayName ?? character.id;

	if (options.drawn !== undefined && options.drawn.trim() !== '') {
		return renderInterface(options.drawn, character, {
			displayName,
			...(options.system === undefined ? {} : {system: options.system}),
		});
	}

	const template = options.template ?? options.profile.status_template;

	switch (template) {
		case 'sheet': {
			return renderSheet(character, options.profile, displayName);
		}
		case 'hud': {
			return renderHud(character, options.profile, displayName);
		}
		case 'inline': {
			return renderInline(character, options.profile, displayName);
		}
	}
}

/**
 * Upserts a rendered block into an existing situation file (D1 marker syntax,
 * vault/markers.ts). Never creates the file: a missing situation is an authoring
 * error the caller needs to see, not something this module should paper over by
 * inventing a file the author never wrote.
 */
export async function writeStatusBlock(
	file: string,
	content: string,
	attributes: Readonly<Record<string, string>>,
): Promise<void> {
	let markdown: string;
	try {
		markdown = await readFile(file, 'utf8');
	} catch {
		throw new Error(`writeStatusBlock: '${file}' does not exist — refusing to create it`);
	}

	await writeFile(file, upsertBlock(markdown, 'status', attributes, content), 'utf8');
}
