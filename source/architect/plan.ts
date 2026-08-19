import {z} from 'zod';
// Reused rather than reimplemented: `extractJsonObject` already handles the
// thinking-only models that wrap or trail their JSON.
import {extractJsonObject} from '../interview/extract.js';
import type {ChatMessage, Provider} from '../llm/index.js';
import {resolveInsideVault, type Proposal} from '../review/index.js';
import {PLAN_PERSONA, PLAN_SHAPE} from './prompts.js';

export type PlanOutcome = {
	readonly proposals: readonly Proposal[];
	/** Paths the vault refused, kept so the author sees the attempt. */
	readonly refusals: readonly {path: string; reason: string}[];
	readonly notes: readonly string[];
	readonly error: string | undefined;
};

const planWriteSchema = z.object({
	path: z.string().min(1),
	contents: z.string().min(1),
	rationale: z.string().optional(),
});

const planSchema = z.object({
	writes: z.array(planWriteSchema).default([]),
	notes: z.array(z.string()).default([]),
});

export function buildPlanMessages(
	instruction: string,
	context: string,
	register: string,
): ChatMessage[] {
	return [
		{
			role: 'system',
			content: [PLAN_PERSONA, register === '' ? '' : `Register: ${register}`]
				.filter(part => part !== '')
				.join('\n\n'),
		},
		{
			role: 'user',
			content: [
				context,
				'',
				'# What the author asked for',
				'',
				instruction,
				'',
				'---',
				'',
				PLAN_SHAPE,
			].join('\n'),
		},
	];
}

/**
 * Runs the structural pass.
 *
 * Unlike `/editor`'s correction pass there is no content guard: the architect is
 * *supposed* to move things around, so a guard that rejected structural change
 * would reject the feature. What stands in its place is `resolveInsideVault` —
 * the same path check every proposal in this tool passes — and the review gate,
 * where the author sees each rewrite as a diff before any of it lands. A refused
 * path is reported rather than dropped, so an architect reaching for `raw/` is
 * visible instead of silently ignored.
 */
export async function runPlan(
	provider: Provider,
	root: string,
	instruction: string,
	context: string,
	register: string,
	signal: AbortSignal,
): Promise<PlanOutcome> {
	let raw = '';
	try {
		for await (const delta of provider.chat(
			buildPlanMessages(instruction, context, register),
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
		parsed = planSchema.parse(extractJsonObject(raw));
	} catch (caught) {
		return {
			proposals: [],
			refusals: [],
			notes: [],
			error: caught instanceof Error ? caught.message : String(caught),
		};
	}

	const proposals: Proposal[] = [];
	const refusals: {path: string; reason: string}[] = [];

	for (const write of parsed.writes) {
		try {
			resolveInsideVault(root, write.path);
		} catch (caught) {
			refusals.push({
				path: write.path,
				reason: caught instanceof Error ? caught.message : String(caught),
			});
			continue;
		}
		proposals.push({
			path: write.path,
			contents: write.contents,
			confidence: 'low',
			...(write.rationale === undefined ? {} : {rationale: write.rationale}),
		});
	}

	return {proposals, refusals, notes: parsed.notes, error: undefined};
}
