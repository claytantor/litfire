import {z} from 'zod';
// Reused rather than reimplemented: `extractJsonObject` already handles the
// thinking-only models that wrap or trail their JSON.
import {extractJsonObject} from '../interview/extract.js';
import type {ChatMessage, Provider} from '../llm/index.js';
import {resolveInsideVault, type Proposal} from '../review/index.js';
import {MAX_ROUNDS, openFiles, renderOpened} from './open.js';
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
	/** Empty is only valid alongside `remove`, which is checked below. */
	contents: z.string().default(''),
	/**
	 * Remove the file rather than write it.
	 *
	 * The architect's job is the shape of the corpus, and shape includes what
	 * should not be there: extraction run twice over one interview leaves two
	 * pages for one moment, and until this existed the agent that noticed could
	 * only describe the problem. A removal still lands as a diff through the
	 * gate, one explicit decision at a time.
	 */
	remove: z.boolean().default(false),
	rationale: z.string().optional(),
});

const planSchema = z.object({
	writes: z.array(planWriteSchema).default([]),
	/**
	 * Files it needs before it can propose anything.
	 *
	 * The structural pass has the same blind spot as the conversation: the
	 * context it is given was selected against the instruction, before it had
	 * read anything. Emitting a rewrite of a file it has not seen is the one
	 * failure that actually destroys work, so it is given a way to ask instead.
	 */
	read: z.array(z.string()).default([]),
	notes: z.array(z.string()).default([]),
});

export function buildPlanMessages(
	instruction: string,
	context: string,
	register: string,
	opened: readonly string[] = [],
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
		...opened.map((content): ChatMessage => ({role: 'user', content})),
	];
}

/**
 * Runs the structural pass.
 *
 * Unlike `/reviewer`'s correction pass there is no content guard: the architect is
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
	const opened: string[] = [];
	let parsed;

	// Rounds, because the pass may need a file before it can propose anything.
	// It either reads or writes on a given round; a plan that asked for files is
	// not yet a plan, and its partial writes are discarded rather than kept,
	// since the point of reading is that they would have been made blind.
	for (let round = 0; ; round++) {
		let raw = '';
		try {
			for await (const delta of provider.chat(
				buildPlanMessages(instruction, context, register, opened),
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

		if (parsed.read.length === 0 || round >= MAX_ROUNDS) {
			break;
		}
		opened.push(renderOpened(await openFiles(root, parsed.read)));
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
		// A write with nothing in it is a malformed proposal, not an empty file:
		// the one legitimate way to end up with no contents is to remove the file,
		// and saying so explicitly is what the gate renders as a deletion.
		if (!write.remove && write.contents.trim() === '') {
			refusals.push({path: write.path, reason: 'empty contents, and not marked remove'});
			continue;
		}

		proposals.push({
			path: write.path,
			contents: write.contents,
			confidence: 'low',
			...(write.remove ? {remove: true} : {}),
			...(write.rationale === undefined ? {} : {rationale: write.rationale}),
		});
	}

	return {proposals, refusals, notes: parsed.notes, error: undefined};
}
