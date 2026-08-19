import type {Chapter, Situation} from '../domain/schema.js';
import type {Step} from '../ledger/replay.js';

export type SeamKind = 'chapter' | 'arc' | 'elapsed' | 'place' | 'cast';

export type Seam = {
	readonly kind: SeamKind;
	readonly from: string;
	readonly to: string;
	readonly detail: string;
};

type SituationStep = Extract<Step, {kind: 'situation'}>;

function seamsBetween(
	prev: SituationStep,
	curr: SituationStep,
	moments: readonly string[],
	byId: ReadonlyMap<string, Situation>,
	chapters: readonly Chapter[],
): Seam[] {
	const seams: Seam[] = [];
	const prevSituation = byId.get(prev.id);
	const currSituation = byId.get(curr.id);

	const opening = chapters
		.filter(chapter => chapter.starts_at === curr.id)
		.map(c => c.id);
	if (opening.length > 0) {
		seams.push({
			kind: 'chapter',
			from: prev.id,
			to: curr.id,
			detail: `chapter '${opening.join("', '")}' opens on '${curr.id}'`,
		});
	}

	if (prev.arc !== curr.arc) {
		seams.push({
			kind: 'arc',
			from: prev.id,
			to: curr.id,
			detail: `moves from arc '${prev.arc}' to arc '${curr.arc}'`,
		});
	}

	if (moments.length > 0) {
		seams.push({
			kind: 'elapsed',
			from: prev.id,
			to: curr.id,
			detail: `moment${moments.length === 1 ? '' : 's'} '${moments.join("', '")}' land between '${prev.id}' and '${curr.id}'`,
		});
	}

	const prevPlace = prevSituation?.place;
	const currPlace = currSituation?.place;
	if (prevPlace !== undefined && currPlace !== undefined && prevPlace !== currPlace) {
		seams.push({
			kind: 'place',
			from: prev.id,
			to: curr.id,
			detail: `place changes from '${prevPlace}' to '${currPlace}'`,
		});
	}

	const prevCast = prevSituation?.characters ?? [];
	const currCast = currSituation?.characters ?? [];
	const entered = currCast.filter(id => !prevCast.includes(id));
	const left = prevCast.filter(id => !currCast.includes(id));
	if (entered.length > 0 || left.length > 0) {
		const parts: string[] = [];
		if (entered.length > 0) {
			parts.push(`${entered.join(', ')} enter${entered.length === 1 ? 's' : ''}`);
		}
		if (left.length > 0) {
			parts.push(`${left.join(', ')} leave${left.length === 1 ? 's' : ''}`);
		}
		seams.push({kind: 'cast', from: prev.id, to: curr.id, detail: parts.join('; ')});
	}

	return seams;
}

/**
 * A seam names a place a chapter break would read as natural; it is a signal
 * for the author's own chapter files (§6 step 6), never a cut the tool makes
 * itself. Each kind is checked independently so a pair that changes arc,
 * place, and cast at once reports three seams rather than one blurred guess.
 */
export function findSeams(
	sequence: readonly Step[],
	situations: readonly Situation[],
	chapters: readonly Chapter[],
): readonly Seam[] {
	const byId = new Map(situations.map(situation => [situation.id, situation]));
	const seams: Seam[] = [];

	let previous: SituationStep | undefined;
	let moments: string[] = [];

	for (const step of sequence) {
		if (step.kind === 'moment') {
			moments.push(step.id);
			continue;
		}

		if (previous) {
			seams.push(...seamsBetween(previous, step, moments, byId, chapters));
		}
		previous = step;
		moments = [];
	}

	return seams;
}
