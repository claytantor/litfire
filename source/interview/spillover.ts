import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {idSchema} from '../domain/schema.js';
import type {Proposal} from '../review/types.js';
import {stringifyDocument} from '../vault/frontmatter.js';
import {resolve, VAULT} from '../vault/paths.js';
import type {InterviewKind} from './prompts.js';

/**
 * Cross-domain spillover: what an interview established outside its own lane.
 *
 * The four interviews are separate because a good interview follows one thread,
 * not because an author answers inside one. A `/system` interview that reaches
 * "the Assessors stopped issuing licences after the Quiet Year" has established
 * a faction and a turning point, and the extraction pass — briefed only on
 * `system/` — has nowhere to put either. They are dropped, and the only record
 * is the transcript nobody reads again.
 *
 * So the extraction also returns *stubs*: minimal pages in another domain, each
 * carrying what the author actually said and nothing more. They land in the same
 * review gate as everything else (P3), so no stub reaches disk unread.
 *
 * The model supplies facts here, never files. It names a kind, an id, and what
 * was said; this module decides the path, the frontmatter, and the shape. That
 * split is deliberate — the model was briefed on one domain's schema, so trusting
 * it to write another's frontmatter is how a stub becomes a load issue instead of
 * a page.
 */

export const STUB_KINDS = [
	'character',
	'place',
	'faction',
	'artifact',
	'arc',
	'moment',
	'theme',
	'situation',
] as const;

export type StubKind = (typeof STUB_KINDS)[number];

export const proposedStubSchema = z.object({
	kind: z.enum(STUB_KINDS),
	id: idSchema,
	/** What the author called it. Never a title this module invents. */
	name: z.string().min(1),
	/** A neutral one-paragraph record of what the transcript established. */
	note: z.string().min(1),
	/** The author's own words, when they were short enough to carry. */
	quote: z.string().optional(),
	/**
	 * Factions only. What the group is working toward — the field that makes a
	 * faction a faction rather than a crowd. Absent when the author established
	 * that the group exists but not yet what it wants, which is the normal case
	 * for a stub and is why `factionSchema` leaves it optional.
	 */
	goal: z.string().optional(),
	/**
	 * Factions only. Character ids the author actually named as belonging. Every
	 * one becomes a checked reference, so a member nobody wrote a page for is
	 * reported rather than absorbed.
	 */
	members: z.array(idSchema).default([]),
});

export type ProposedStub = z.infer<typeof proposedStubSchema>;

/**
 * Ceiling on stubs from one interview.
 *
 * A spillover pass that proposes thirty pages has stopped recording what the
 * author said and started generating a world, which is the one thing the whole
 * tool refuses to do. The cap makes that failure visible instead of expensive:
 * the author sees "8 more dropped" rather than a review gate they abandon.
 */
export const MAX_STUBS = 12;

/**
 * A stub and the transcript that raised it.
 *
 * Provenance is per stub, not per plan, because `/<kind> extract all` sweeps
 * every transcript of a kind in one pass. A page that says it came from the
 * newest interview when it actually came from one three weeks earlier is a false
 * claim about the author's own history, written into their vault by us.
 */
export type SourcedStub = {
	readonly stub: ProposedStub;
	readonly transcriptId: string;
};

/** Tags one extraction's stubs with the transcript they came from. */
export function fromTranscript(
	stubs: readonly ProposedStub[],
	transcriptId: string,
): SourcedStub[] {
	return stubs.map(stub => ({stub, transcriptId}));
}

export type DroppedStub = {
	readonly stub: ProposedStub;
	readonly transcriptId: string;
	readonly reason: string;
};

export type SpilloverPlan = {
	readonly proposals: readonly Proposal[];
	readonly dropped: readonly DroppedStub[];
};

export type SpilloverContext = {
	readonly root: string;
	/** The interview that produced them, for the provenance line. */
	readonly kind: InterviewKind;
	/** Paths the extraction's primary writes already claim. */
	readonly taken?: readonly string[];
};

/** Where each kind lives. Moments are a list in one file, not a page. */
export function stubPath(kind: StubKind, id: string): string {
	switch (kind) {
		case 'character': {
			return `${VAULT.characters}/${id}.md`;
		}
		case 'place': {
			return `${VAULT.places}/${id}.md`;
		}
		case 'faction': {
			return `${VAULT.factions}/${id}.md`;
		}
		case 'artifact': {
			return `${VAULT.artifacts}/${id}.md`;
		}
		case 'theme': {
			return `${VAULT.themes}/${id}.md`;
		}
		case 'arc': {
			return `${VAULT.arcs}/${id}.md`;
		}
		case 'situation': {
			// Unplaced by construction: the author has not said where it sits, and
			// the inbox is where §5 puts a scene with no arc.
			return `${VAULT.situations}/${id}.md`;
		}
		case 'moment': {
			return `${VAULT.moments}/${id}.md`;
		}
	}
}

const KIND_LABEL: Readonly<Record<InterviewKind, string>> = {
	system: 'system',
	character: 'character',
	moment: 'moment',
	arc: 'arc',
	place: 'place',
	situation: 'situation',
	faction: 'faction',
	artifact: 'artifact',
	theme: 'theme',
	chapter: 'chapter',
	timeline: 'timeline',
	themes: 'themes',
};

/**
 * Frontmatter per kind.
 *
 * Every position field is left absent on purpose. An arc has no `order` and a
 * moment has no `at` because the author was not asked — and a guessed
 * position would silently reorder their story. `runChecks` raises both as open
 * questions, which is how the stub asks for the answer instead of inventing it.
 */
function frontmatterFor(stub: ProposedStub): Record<string, unknown> {
	if (stub.kind === 'situation') {
		// Situations title their page; only `id` is shared with the others.
		return {id: stub.id, title: stub.name, stub: true};
	}

	if (stub.kind === 'faction') {
		// `goal` and `members` are typed fields, so they go in frontmatter where
		// the checks and the wiki can reach them — but only when the author gave
		// them. An absent goal becomes an open question; an invented one becomes
		// a fact nobody said.
		return {
			id: stub.id,
			name: stub.name,
			...(stub.goal === undefined || stub.goal.trim() === ''
				? {}
				: {goal: stub.goal.trim()}),
			...(stub.members.length === 0 ? {} : {members: [...stub.members]}),
			stub: true,
		};
	}

	return {id: stub.id, name: stub.name, stub: true};
}

function stubBody(sourced: SourcedStub, context: SpilloverContext): string {
	const {stub} = sourced;
	const lines = [
		'',
		`# ${stub.name}`,
		'',
		'> [!info] Stub',
		`> Raised during the ${KIND_LABEL[context.kind]} interview, which was not`,
		'> about this. Nothing below is established beyond what the author said —',
		'> interview it directly to fill it in.',
		'',
		stub.note.trim(),
		'',
	];

	if (stub.quote !== undefined && stub.quote.trim() !== '') {
		lines.push(`> ${stub.quote.trim().replace(/\n/g, '\n> ')}`, '');
	}

	lines.push(`Raised in [[${sourced.transcriptId}]].`, '');
	return lines.join('\n');
}

export function renderStub(sourced: SourcedStub, context: SpilloverContext): string {
	return stringifyDocument({
		data: frontmatterFor(sourced.stub),
		body: stubBody(sourced, context),
	});
}

async function readIfPresent(file: string): Promise<string | undefined> {
	return readFile(file, 'utf8').catch(() => undefined);
}

/**
 * Turns model-proposed stubs into review-gate proposals.
 *
 * Everything dropped is reported rather than silently discarded — a stub that
 * vanished because the page already exists is useful to see, since it means the
 * interview re-established something the corpus already knows.
 */
export async function planSpillover(
	sourced: readonly SourcedStub[],
	context: SpilloverContext,
): Promise<SpilloverPlan> {
	const proposals: Proposal[] = [];
	const dropped: DroppedStub[] = [];
	const taken = new Set(context.taken ?? []);
	const seen = new Set<string>();
	let accepted = 0;

	for (const entry of sourced) {
		const {stub} = entry;
		const key = `${stub.kind}:${stub.id}`;
		if (seen.has(key)) {
			// Across a sweep this is the ordinary case rather than a model slip:
			// the same faction comes up interview after interview. The earliest
			// mention wins, because that is the transcript that introduced it.
			dropped.push({...entry, reason: 'already raised by an earlier transcript'});
			continue;
		}
		seen.add(key);

		if (accepted >= MAX_STUBS) {
			dropped.push({
				...entry,
				reason: `over the ${MAX_STUBS}-stub cap for one interview`,
			});
			continue;
		}

		const target = stubPath(stub.kind, stub.id);
		if (taken.has(target)) {
			dropped.push({...entry, reason: 'the extraction already proposes this page'});
			continue;
		}

		// A stub never overwrites an existing page. Its whole content is "we know
		// this exists and nothing else", so writing it over a page the author has
		// already filled in would destroy the very thing it is a placeholder for.
		if ((await readIfPresent(resolve(context.root, target))) !== undefined) {
			dropped.push({...entry, reason: 'the page already exists'});
			continue;
		}

		accepted += 1;
		taken.add(target);
		proposals.push({
			path: target,
			contents: renderStub(entry, context),
			confidence: 'low',
			rationale: `${stub.kind} stub raised by the ${KIND_LABEL[context.kind]} interview`,
		});
	}

	return {proposals, dropped};
}
