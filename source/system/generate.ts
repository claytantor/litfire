import type {Project} from '../core/project.js';
import type {SystemDef} from '../domain/schema.js';
import {authoringPath} from '../ingest/authoring.js';
import {resolve} from '../vault/paths.js';
import {readFile} from 'node:fs/promises';

/**
 * Deriving a stats model from the screen an author drew.
 *
 * The whole idea, and the reason it is worth a model pass at all: an author
 * designs the status screen their world shows, and what stats must exist and
 * how each is computed falls out of it. They write the fiction-facing artefact
 * — the thing a reader sees on the page — rather than specifying a data model
 * and hoping a readable screen appears at the other end.
 *
 * ## Where it writes, and why that is not the obvious place
 *
 * Into `raw/systems/<id>.md`, the author's own note, and not the derived page.
 * A formula written to `corpus/systems/<id>.md` would be dropped by the next
 * `/ingest system`, because the corpus is regenerated from the note and the
 * note would not have it. Proposing into raw is what makes a generated formula
 * survive, and it is the same permission the curator holds for the same reason.
 *
 * ## The thing this pass must not do
 *
 * A generated formula is a number, and never inventing one is this project's
 * hardest rule. Everywhere else it is easy to honour because an invented fact
 * reads as a sentence an author can judge; nobody can read
 * `50 + con * 8 + level * 12` and tell whether it is right for their book. It
 * compiles, it looks plausible, and it is wrong in a way that surfaces four
 * hundred pages later when a fight turns out to be unlosable.
 *
 * So every formula arrives with a worked table, in the file, above the block it
 * explains. The author reviews the behaviour — which they can judge — instead
 * of the expression, which they cannot. The table stays in the vault afterwards
 * as documentation of a rule the story now runs on.
 */

const INSTRUCTION = [
	'You are deriving a stats model for one character system in a LitRPG vault,',
	'from the status screen its author drew.',
	'',
	'The screen is the specification. Every `{placeholder}` on it is a statement',
	'that the thing exists: if it draws `{coherence}`, coherence is a stat. Your',
	'job is to make the vault agree with the screen the author has already',
	'designed — not to design one.',
	'',
	'## What you propose',
	'',
	'One file: the raw note named below. Emit its whole contents, with the',
	'existing prose and the ```interface block preserved exactly. You are adding',
	'frontmatter and formula blocks to a document that already exists.',
	'',
	'### Stats, in the frontmatter',
	'',
	'```yaml',
	'stats:',
	'  - id: coherence',
	'    name: Coherence',
	'    default: 0',
	'    min: 0',
	'    max: 10',
	'  - id: capacity',
	'    name: Capacity',
	'    formula: capacity',
	'```',
	'',
	'A stat with a `formula` is computed after every scene from the rest of the',
	"character's state. A stat without one is moved by what happens in scenes and",
	'by nothing else. Decide which each placeholder is: a thing the story does to',
	'a character is accumulated, a thing that follows from other numbers is',
	'derived.',
	'',
	'Take `min` and `max` from the screen where it states them — `{x}/10` says',
	'the maximum is 10. Where it does not, leave the field out rather than',
	'choosing a bound the author never mentioned.',
	'',
	'### Formulas, in the body',
	'',
	'One ```js block per derived stat, with `id=` matching the stat’s `formula`:',
	'',
	'```js id=capacity',
	'({strength, level}) => 10 + strength * 2 + level;',
	'```',
	'',
	'A single arrow function, taking one object and returning a number. It',
	'receives every stat by id plus `level` and `xp`. It is pure: no clock, no',
	'randomness, no I/O, and it must not call another formula.',
	'',
	'## Ids are kebab-case, and that constrains you',
	'',
	'Stat ids match `^[a-z0-9][a-z0-9-]*$`. A formula reads its inputs by',
	'destructuring, and `({max-hp}) =>` is a syntax error — so a derived stat',
	'that another formula needs to read must have a single-word id, or be read as',
	"`state['max-hp']`. Prefer single words for anything derived.",
	'',
	'## Every formula arrives with a worked table',
	'',
	'This is not optional and it is the point of the whole exchange. Above each',
	'```js block, in the body, write:',
	'',
	'- one or two sentences saying what the rule is and why it behaves that way,',
	'  in the language of the world rather than of arithmetic;',
	'- a markdown table of worked values, four to six rows, spanning the range a',
	'  character will actually occupy — early, middle, and the far end.',
	'',
	'The author cannot check an expression. They can check whether a level-20',
	'character having 386 of something is right for their book, and that is the',
	'judgement you are handing them. Choose rows that would expose a rule being',
	'wrong.',
	'',
	'## What you must not do',
	'',
	'Do not invent a stat the screen does not draw and the prose does not name.',
	'Do not invent a bound, a default or a curve the author has not implied — a',
	'missing field is correct for something undecided, and the checks report it.',
	'Do not rewrite the interface block, the prose, or anything else in the file.',
	'Do not propose ledger events; what happens in a scene is the story, and it',
	'is not yours to write.',
	'',
	'Give each write a one-line `rationale`. The gate shows only a few lines of',
	'it, so the explanation belongs in the file, where it stays.',
].join('\n');

export type StatsGeneration = {
	readonly instruction: string;
	readonly context: string;
	/** The note being proposed into, vault-relative. */
	readonly note: string;
};

/**
 * Everything the pass is given about one system.
 *
 * The interface first, because it is the specification and the rest is
 * supporting detail. A system with no interface can still be worked from — its
 * prose and its existing stats say something — but it is a weaker brief, and
 * the instruction says which it is looking at rather than pretending they are
 * the same.
 */
export async function buildStatsGeneration(
	root: string,
	project: Project,
	system: SystemDef,
): Promise<StatsGeneration> {
	const note = authoringPath('system', system.id);
	const existing = await readFile(resolve(root, note), 'utf8').catch(() => undefined);
	const drawn = project.vault.interfaces[system.id];

	const context = [
		`# The system: ${system.id}${system.name ? ` — ${system.name}` : ''}`,
		'',
		drawn === undefined
			? [
					'This system draws no status screen, so there is no specification to',
					'work from — only its prose and whatever stats it already declares.',
					'Propose only what those clearly imply, and say in `notes` that a',
					'drawn interface would settle it.',
				].join('\n')
			: ['## The screen it draws', '', '```', drawn, '```'].join('\n'),
		'',
		'## Stats it already declares',
		'',
		system.stats.length === 0
			? '_None._'
			: system.stats
					.map(
						stat =>
							`- \`${stat.id}\`${stat.name ? ` — ${stat.name}` : ''}${
								stat.formula === undefined ? '' : ` (derived by \`${stat.formula}\`)`
							}`,
					)
					.join('\n'),
		'',
		'## Formulas already defined in this vault',
		'',
		project.vault.formulas.length === 0
			? '_None._'
			: project.vault.formulas.map(formula => `- \`${formula.id}\``).join('\n'),
		'',
		`## The note to propose, at ${note}`,
		'',
		existing === undefined
			? '_It does not exist yet. Propose it whole._'
			: ['```markdown', existing.trim(), '```'].join('\n'),
	].join('\n');

	return {instruction: INSTRUCTION, context, note};
}
