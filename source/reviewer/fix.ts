import {z} from 'zod';
// Reused rather than reimplemented: `extractJsonObject` already handles the
// thinking-only models that wrap or trail their JSON, and a second copy of that
// recovery logic would drift from the one the interview depends on.
import {extractJsonObject, proposedWriteSchema} from '../interview/extract.js';
import type {ChatMessage, Provider} from '../llm/index.js';
import type {Proposal} from '../review/index.js';
import {guardCorrection} from './guard.js';
import {CORRECTION_PERSONA, CORRECTION_SHAPE} from './prompts.js';

export type Target = {
	readonly path: string;
	readonly contents: string;
};

/** A proposal the guard threw out, kept so the author can see it was tried. */
export type Refusal = {
	readonly path: string;
	readonly reason: string;
	readonly line: number | undefined;
};

export type FixOutcome = {
	readonly proposals: readonly Proposal[];
	readonly refusals: readonly Refusal[];
	/** Things the model declined to touch and wanted to mention instead. */
	readonly notes: readonly string[];
	readonly error: string | undefined;
};

const correctionSchema = z.object({
	writes: z.array(proposedWriteSchema).default([]),
	notes: z.array(z.string()).default([]),
});

export function buildCorrectionMessages(
	targets: readonly Target[],
	register: string,
): ChatMessage[] {
	const files = targets
		.map(target => `## ${target.path}\n\n\`\`\`\n${target.contents}\n\`\`\``)
		.join('\n\n');

	return [
		{
			role: 'system',
			content:
				register === ''
					? CORRECTION_PERSONA
					: `${CORRECTION_PERSONA}\n\nRegister: ${register}`,
		},
		{
			role: 'user',
			content: ['# Files', '', files, '', '---', '', CORRECTION_SHAPE].join('\n'),
		},
	];
}

/**
 * Runs the correction pass and filters it through the guard.
 *
 * The guard runs here rather than at the review gate on purpose: a rejected
 * proposal should never occupy a slot in the author's review queue. Making them
 * page through a rewrite to reject it would train them to hold `A` — which is
 * exactly how an overstepping edit gets accepted.
 *
 * Refusals are reported rather than dropped silently. A reviewer that quietly
 * discards half its own output looks like it found nothing, and the author
 * deserves to know it overstepped.
 */
export async function runCorrectionPass(
	provider: Provider,
	targets: readonly Target[],
	register: string,
	signal: AbortSignal,
): Promise<FixOutcome> {
	const known = new Map(targets.map(target => [target.path, target.contents]));

	let raw = '';
	try {
		for await (const delta of provider.chat(
			buildCorrectionMessages(targets, register),
			signal,
		)) {
			raw += delta;
		}
	} catch (caught) {
		return {
			proposals: [],
			refusals: [],
			notes: [],
			error: caught instanceof Error ? caught.message : String(caught),
		};
	}

	let parsed;
	try {
		parsed = correctionSchema.parse(extractJsonObject(raw));
	} catch (caught) {
		return {
			proposals: [],
			refusals: [],
			notes: [],
			error: caught instanceof Error ? caught.message : String(caught),
		};
	}

	const proposals: Proposal[] = [];
	const refusals: Refusal[] = [];

	for (const write of parsed.writes) {
		const existing = known.get(write.path);

		// A path outside the set it was shown is not a correction of anything —
		// the model reached for a file nobody offered it.
		if (existing === undefined) {
			refusals.push({
				path: write.path,
				reason: 'not one of the files offered for correction',
				line: undefined,
			});
			continue;
		}

		const verdict = guardCorrection(existing, write.contents);
		if (verdict.ok) {
			proposals.push(write);
		} else {
			refusals.push({path: write.path, reason: verdict.reason, line: verdict.line});
		}
	}

	return {proposals, refusals, notes: parsed.notes, error: undefined};
}
