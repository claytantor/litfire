import {z} from 'zod';
import {ProviderError, type ChatMessage, type Provider} from '../llm/index.js';
import type {InterviewKind} from './prompts.js';
import {proposedStubSchema} from './spillover.js';
import type {Transcript} from './transcript.js';
import {INGEST} from '../ingest/index.js';

/**
 * The extraction prompt, verbatim from the spec.
 *
 * This is the other half of the load-bearing split: the interviewer never asks
 * about schema, so something has to turn prose into typed fields. Keeping the
 * two prompts in separate calls is what stops the interview becoming a form.
 */
export const EXTRACTION_PERSONA = `You are extracting structured corpus data from an interview transcript.

Produce only what the transcript supports. Where the author was explicit,
record it. Where you are inferring, mark confidence: low. Never invent a proper
noun, number, or fact that does not appear in the transcript.

Emit:
1. Proposed file writes as complete frontmatter + body, conforming to schema.
2. A list of required fields the transcript did not determine, each with a
   plain-language question the interviewer should ask to close it. Write the
   question the way a person would ask it, not the way a form would.
3. Any contradictions between the transcript and the existing corpus, as
   proposed open questions. Do not resolve them.
4. Stubs for anything the author established that belongs to a *different*
   interview's domain. See the spillover section below.

Prose you write for a corpus page body is a neutral summary of what the author
said, in their register where possible. It is not creative writing and it is
not embellishment. The author reviews every word of it.

An interview that established meaning and no numbers still has everything to
record. The interviewer is told to start with meaning and reach mechanics late,
so most transcripts are mostly meaning — what the System costs, what it forbids,
who it answers to, what breaks it. Write that into the body of the page it
belongs to. Returning no writes because nothing was numeric throws away the
author's work and is the single worst outcome of this pass: they answered, and
nothing survived.

A body you write replaces the body of that file, so carry forward anything
already there that the transcript did not revise.

## Spillover

An author answering about the System names factions, places, people, and things
that happened. An author describing a character names the war that took their
sister. None of that belongs in this interview's target files, and until now all
of it was lost — the interview that established it was briefed elsewhere, so it
went into the transcript and no further.

So: when the transcript establishes something that belongs to another domain,
emit a stub for it. A stub is a claim that this thing exists and a record of
what was said about it. It is not a page you write on the author's behalf.

The bar is a proper noun or a specific thing the author asserted exists. "The
Assessors stopped issuing licences" is a faction. "Everyone remembers where they
were during the Quiet Year" is a moment. "Down in the rust quarter" is a
place. Something merely alluded to — "the people who run it", "some kind of
collapse" — is not a stub, it is an open field: ask about it instead.

Factions are the kind most often missed, because an author rarely names one as a
group. They describe an effect — licences stop being issued, a toll gets
collected, somebody decides who is allowed to descend — and the group doing it is
implied. When the transcript establishes that somebody is acting in concert and
says who, that is a faction, even if the author never used a collective noun for
them. When it establishes only that something is being done to people, that is an
open field: ask who is doing it.

Never invent a position. A stub carries no date, no order, and no numbers. If
the author said when something happened, that belongs in \`note\` as prose; the
tool asks them to place it, and a position you guessed would silently reorder
their story.

Never stub something the corpus already has — check the existing corpus below
first. Never stub the thing this interview is actually about; that is a write.
Do not pad. Five stubs from a rich interview is normal; twenty means you have
started generating a world, which is the one thing you must never do.

Kinds, and what each one is:

- \`character\` — a person.
- \`place\` — somewhere with a name.
- \`artifact\` — a thing a character uses to achieve something. Under an arcane
  idiom that is a spell, a suit of armour, a relic; under a technological one an
  M1A rifle, a mass spectrometer, an iPad. What it is *for* is the defining
  fact, so the note must say what using it achieves. A thing merely present in a
  scene is scenery, not an artifact; the test is whether somebody uses it to get
  an outcome. Quantities of an interchangeable thing — rations, ammunition — are
  not artifacts either; those are items and the ledger counts them.
- \`faction\` — people who act together toward a goal or an ideology. A guild,
  a bureau, a church, a crew, a family firm. What they are working toward is the
  defining fact, not their name or their size, so the note must say it: two
  people with a shared aim are a faction and a crowd is not. If the author has
  not said what they want, that is an open field, not a guess.
- \`moment\` — something that happened and changed the terms of the world.
- \`arc\` — a stretch of the story the author described as a unit.
- \`theme\` — something the book is arguing about, in the author's framing.
- \`situation\` — a specific scene the author described that has not been placed.

Each stub is {kind, id, name, note, quote}. \`id\` is lowercase kebab-case and
becomes the filename. \`name\` is what the author called it. \`note\` is one neutral
paragraph recording what the transcript established, in their register. \`quote\`
is the author's own words when a short line carries it better than a summary —
verbatim or omitted, never tidied.

A \`faction\` stub takes two more, both optional and both typed:

- \`goal\` — one line on what they are working toward, only if the author said.
  Omit it rather than paraphrase an implication; the tool asks them instead.
- \`members\` — kebab-case ids of people the author actually placed in this
  group. Every id becomes a checked link, so a name you inferred shows up as a
  broken reference in their vault. If the author named a member who has no page
  yet, put the id here *and* emit a \`character\` stub for them.`;

export const proposedWriteSchema = z.object({
	/** Vault-relative path, e.g. `system/stats.md`. */
	path: z.string().min(1),
	/** Complete file contents: frontmatter plus body. */
	contents: z.string().min(1),
	confidence: z.enum(['high', 'low']).default('high'),
	rationale: z.string().optional(),
});

export const openFieldSchema = z.object({
	field: z.string().min(1),
	/** Phrased as a person would ask it, not as a form would. */
	question: z.string().min(1),
});

export const contradictionSchema = z.object({
	detail: z.string().min(1),
	where: z.string().optional(),
});

export const extractionSchema = z.object({
	writes: z.array(proposedWriteSchema).default([]),
	open_fields: z.array(openFieldSchema).default([]),
	contradictions: z.array(contradictionSchema).default([]),
	/**
	 * Cross-domain facts, as facts. `planSpillover` turns them into files —
	 * the model is briefed on one domain's schema, so it does not get to write
	 * another's frontmatter.
	 */
	stubs: z.array(proposedStubSchema).default([]),
});

export type ProposedWrite = z.infer<typeof proposedWriteSchema>;
export type OpenField = z.infer<typeof openFieldSchema>;
export type Contradiction = z.infer<typeof contradictionSchema>;
export type Extraction = z.infer<typeof extractionSchema>;

/** Schema hints per interview, so proposals land on the right vault paths. */
/**
 * Where a kind's answers land, and what its frontmatter holds.
 *
 * The four written by hand encode judgment a field list cannot: how many system
 * pages one apparatus is, what counts as a moment rather than a scene. The rest
 * are generated from the ingest spec, which already states each kind's
 * destination and fields — writing them out a second time here would be two
 * descriptions of one thing, and two descriptions of one thing is how they
 * drift.
 */
function specHint(kind: InterviewKind): string {
	const spec = INGEST[kind];
	return [
		'Target files.',
		'',
		`Write one page per thing at ${spec.to}/<id>.md, where the id is the`,
		'filename. Its frontmatter holds:',
		'',
		spec.fields,
		'',
		'Anything the author did not tell you is an open field, not a guess. Never',
		'invent a proper noun, a number or a date to fill one.',
	].join('\n');
}

const BESPOKE_HINT: Partial<Record<InterviewKind, string>> = {
	system: [
		'Target files.',
		'',
		'A vault may hold SEVERAL character systems, and each gets its own page at',
		'systems/<id>.md. A character system is the thing that tracks and manages a',
		"character's stats, and a character is under exactly one at a time.",
		'',
		'This interview is namespaced to one system — the Focus above names it, and',
		'its id is the filename. Write that page. Every system page MUST carry a',
		'`name`: it is what the author calls it, and every view, interview and',
		'wikilink uses it. If the author never named it, say so as an open field',
		'rather than titling it yourself.',
		'',
		'That last rule decides how many pages you propose. Parts of one apparatus —',
		'an agent that grants power, another that audits it, the interface they',
		'reach a person through — are one system with several components, and they',
		'belong on one page. Two systems means two sets of rules a character could',
		'be tracked by *instead of* each other. When the author has named the whole',
		'apparatus, use that name; do not invent one, and do not split a single set',
		'of rules into several pages because it has several parts.',
		'',
		'A system page carries frontmatter {id, name, stats, skills, curves} and the',
		'prose about that system in its body — what it is, what it costs, what it',
		'forbids, its ceiling, its exploit, who runs it. `stats` is a list of',
		'{id, name, default, min, max}; `skills` a list of {id, name,',
		'requires_skills}; `curves` the keys `xp_for_level` and `max_level`.',
		'Formulas go in the body as fenced ```js id=<name> blocks and are scoped to',
		'that system, so two systems may each define their own `xp-for-level`.',
		'',
		'Only propose a formula if the author gave you the actual rule, and only a',
		'stat or skill the author actually named. Do not invent mechanics to fill',
		'these fields — an interview about meaning correctly leaves them empty and',
		'writes the body instead. Returning a system page with nothing but prose is',
		'a good outcome.',
		'',
		'system/system.md is NOT a system page. It is the vault-level setting file,',
		'and its frontmatter carries `system_origin` (divine, arcane, technological,',
		'simulated, emergent, unexplained), `system_visibility` (character,',
		'universal, privileged, reader-only), and `system_agency` (agent,',
		'bureaucracy, physics, unknown) — set one only when an answer actually',
		'determines it, and leave it out otherwise. PRESERVE the existing `idiom`',
		"value: it sets the whole vault's vocabulary and is never yours to change.",
		'Its body is the account of the world the systems run in. Never propose',
		'system/stats.md, system/skills.md, system/curves.md or system/formulas.md:',
		'those are the old single-system layout, and writing one splits a vault that',
		'has moved to systems/ into two systems that fight over the same characters.',
	].join('\n'),
	character: [
		'Target file: characters/<id>.md with frontmatter {id, name, level, xp,',
		'stats, skills} and the narrative in the body. Only set level/xp/stats if',
		'the author stated numbers; otherwise omit them and list them as open fields.',
	].join(' '),
};

export function buildExtractionMessages(
	transcript: Transcript,
	grounding: string,
): ChatMessage[] {
	const body = transcript.exchanges
		.map(
			(exchange, index) =>
				`### ${index + 1}. Interviewer\n${exchange.question}\n\n### Author\n${exchange.answer}`,
		)
		.join('\n\n');

	return [
		{role: 'system', content: EXTRACTION_PERSONA},
		{
			role: 'user',
			content: [
				`Interview kind: ${transcript.kind}`,
				transcript.focus === undefined ? '' : `Focus: ${transcript.focus}`,
				'',
				BESPOKE_HINT[transcript.kind] ?? specHint(transcript.kind),
				'',
				'# Existing corpus',
				'',
				grounding.trim() === '' ? '(empty vault)' : grounding.trim(),
				'',
				'# Transcript',
				'',
				body,
				'',
				'---',
				'',
				'Respond with a single JSON object and nothing else — no prose before or',
				'after, no markdown fence. Shape:',
				'{"writes":[{"path":"...","contents":"...","confidence":"high|low","rationale":"..."}],',
				' "open_fields":[{"field":"...","question":"..."}],',
				' "contradictions":[{"detail":"...","where":"..."}],',
				' "stubs":[{"kind":"character|place|faction|moment|arc|theme|situation",',
				'           "id":"kebab-case","name":"...","note":"...","quote":"...",',
				'           "goal":"faction only","members":["faction only"]}]}',
			]
				.filter(line => line !== undefined)
				.join('\n'),
		},
	];
}

/**
 * Pulls a JSON object out of a model response.
 *
 * Only one of the four providers reliably honours a JSON mode, and Kimi Code's
 * models are thinking-only, so a reply may arrive wrapped in a fence or trailed
 * by commentary despite the instruction. Rather than fail the extraction, find
 * the outermost balanced object and parse that.
 */
export function extractJsonObject(raw: string): unknown {
	const fenced = /```(?:json)?\s*\n([\S\s]*?)```/.exec(raw);
	const text = fenced?.[1] ?? raw;

	const start = text.indexOf('{');
	if (start === -1) {
		throw new Error('no JSON object in the response');
	}

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = start; index < text.length; index++) {
		const char = text[index];

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
		} else if (char === '{') {
			depth++;
		} else if (char === '}') {
			depth--;
			if (depth === 0) {
				return JSON.parse(text.slice(start, index + 1));
			}
		}
	}

	// Reached when the braces never balance, which in practice means the reply
	// stopped early. Providers that report a truncation flag fail before this
	// with a message that names the budget; this is the fallback for those that
	// do not, and it must not read as "the model emitted bad JSON".
	throw new Error(
		'unterminated JSON object in the response — it was cut off before it finished',
	);
}

export type ExtractionResult =
	| {readonly ok: true; readonly extraction: Extraction; readonly raw: string}
	| {readonly ok: false; readonly reason: string; readonly raw: string};

/**
 * Runs the extraction pass. Never throws on a bad model response — a failed
 * extraction returns the raw text so the author can see what came back, because
 * the transcript is already saved and re-running is free.
 */
export async function runExtraction(
	provider: Provider,
	transcript: Transcript,
	grounding: string,
	signal: AbortSignal,
): Promise<ExtractionResult> {
	let raw = '';
	try {
		for await (const delta of provider.chat(
			buildExtractionMessages(transcript, grounding),
			signal,
		)) {
			raw += delta;
		}
	} catch (caught) {
		// A provider hint is the actionable half of a transport failure — a
		// truncated answer says *why* it failed and what to change — so it is
		// carried through rather than dropped at the boundary.
		const hint = caught instanceof ProviderError ? caught.hint : undefined;
		const reason = caught instanceof Error ? caught.message : String(caught);
		return {
			ok: false,
			reason: hint === undefined ? reason : `${reason} — ${hint}`,
			raw,
		};
	}

	try {
		const parsed = extractionSchema.parse(extractJsonObject(raw));
		return {ok: true, extraction: parsed, raw};
	} catch (caught) {
		return {
			ok: false,
			reason: caught instanceof Error ? caught.message : String(caught),
			raw,
		};
	}
}
