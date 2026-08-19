import type {Situation, Theme} from '../domain/schema.js';
import type {Step} from '../ledger/replay.js';

export type SubthemeCoverage = {
	readonly pillar: string;
	readonly id: string;
	readonly name: string;
	readonly count: number;
	/** Situations since this sub-theme was last touched, in replay order. */
	readonly sinceLastTouch: number;
	readonly starved: boolean;
};

export type PillarCoverage = {
	readonly id: string;
	readonly name: string;
	readonly count: number;
	readonly subthemes: readonly SubthemeCoverage[];
};

export type Coverage = {
	readonly pillars: readonly PillarCoverage[];
	readonly untagged: readonly string[];
};

/**
 * Coverage is reported at leaf level and aggregated upward for display (§8) —
 * a parent-level rollup alone would hide a starved sub-theme.
 *
 * Hard requirement: this never produces open questions and never blocks.
 */
export function computeCoverage(
	themes: readonly Theme[],
	situations: readonly Situation[],
	sequence: readonly Step[],
	starvedAfter = 5,
): Coverage {
	const placedOrder = sequence
		.filter(step => step.kind === 'situation')
		.map(step => step.id);
	const byId = new Map(situations.map(situation => [situation.id, situation]));

	const counts = new Map<string, number>();
	const lastIndex = new Map<string, number>();

	placedOrder.forEach((situationId, index) => {
		for (const subtheme of byId.get(situationId)?.themes ?? []) {
			counts.set(subtheme, (counts.get(subtheme) ?? 0) + 1);
			lastIndex.set(subtheme, index);
		}
	});

	const total = placedOrder.length;

	const pillars = themes.map((theme): PillarCoverage => {
		const subthemes = theme.subthemes.map((subtheme): SubthemeCoverage => {
			const count = counts.get(subtheme.id) ?? 0;
			const last = lastIndex.get(subtheme.id);
			const sinceLastTouch = last === undefined ? total : total - 1 - last;

			return {
				pillar: theme.id,
				id: subtheme.id,
				name: subtheme.name ?? subtheme.id,
				count,
				sinceLastTouch,
				starved: total > 0 && sinceLastTouch >= starvedAfter,
			};
		});

		return {
			id: theme.id,
			name: theme.name ?? theme.id,
			count: subthemes.reduce((sum, subtheme) => sum + subtheme.count, 0),
			subthemes,
		};
	});

	const known = new Set(themes.flatMap(theme => theme.subthemes.map(sub => sub.id)));
	const untagged = [...new Set(situations.flatMap(s => s.themes))]
		.filter(id => !known.has(id))
		.toSorted();

	return {pillars, untagged};
}
