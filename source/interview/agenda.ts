import type {Project} from '../core/project.js';
import type {IngestKind} from '../ingest/index.js';
import type {OpenQuestion} from '../ledger/checks.js';
import type {InterviewKind} from './prompts.js';

/**
 * What the deterministic checks think is worth asking about.
 *
 * `/questions` has always listed the open queue and nothing has ever acted on
 * it: the author reads that a moment has no position on the clock and then goes
 * and dates it themselves, in a separate command, remembering which of seven
 * findings they had got to. Meanwhile the interview knows how to press but runs
 * against a fixed brief with no idea what this vault is actually missing.
 *
 * One half knows what is missing and cannot ask. The other can ask and does not
 * know. This joins them: the checks decide the agenda, the interview works it.
 */

/**
 * Which brief covers a primitive. Absent means nobody has written one yet.
 *
 * Every primitive has one now, so this map is the identity — which is the point.
 * It stays as a map rather than being deleted because it is what enforces that:
 * a primitive added without a brief is a hole `/questions` reports rather than
 * a crash, and the entry is the one place someone has to look to see whether
 * the writing was done.
 *
 * Two of the original four briefs never matched a primitive name — `timeline`
 * covered moments *and* the arcs between them, and `themes` was plural where
 * the primitive is `theme`. Splitting the timeline brief along that seam is
 * what finally lined the names up with the folders. Both old names survive in
 * `InterviewKind` only until `/timeline` and `/themes` retire.
 */
export const BRIEF_FOR: Partial<Record<IngestKind, InterviewKind>> = {
	system: 'system',
	character: 'character',
	moment: 'moment',
	arc: 'arc',
	place: 'place',
	situation: 'situation',
	faction: 'faction',
	artifact: 'artifact',
	skill: 'skill',
	theme: 'theme',
	chapter: 'chapter',
};

/** The kinds an interview can be had about today, in a readable order. */
export const INTERVIEWABLE: readonly IngestKind[] = Object.keys(
	BRIEF_FOR,
) as IngestKind[];

/**
 * The findings worth putting to a person.
 *
 * A check fires for two quite different reasons. Some report a decision the
 * author has not made — a faction with no goal, an artifact whose outcome is
 * unstated, a scene naming someone who does not exist. Those are interview
 * material, and the tool is forbidden to settle them itself (P5).
 *
 * The rest report a mechanical inconsistency: a stat out of range, a formula
 * that will not compile, two files claiming one id. Those have answers that are
 * looked up rather than asked for, and the persona is explicit that the
 * interviewer never raises numbers, formulas or schema. Putting them in front
 * of it would produce exactly the interrogation this command exists not to be.
 *
 * So the author sees every finding — `/questions` and `/lint` both list the
 * lot — and only these reach the interviewer.
 */
const ASKABLE: ReadonlySet<string> = new Set([
	'faction_goal_unknown',
	'artifact_outcome_unknown',
	'system_unnamed',
	'moment_undated',
	'broken_reference',
	'arc_unordered',
	// Two pages with one name is nearly always one thing written twice, and
	// which of them is real — or whether they are genuinely different — is the
	// author's to say and nobody else's.
	'duplicate_name',
]);

export function askable(questions: readonly OpenQuestion[]): OpenQuestion[] {
	return questions.filter(question => ASKABLE.has(question.kind));
}

/**
 * The agenda, as the interviewer should receive it.
 *
 * This is the most dangerous text in the feature. A bare list of gaps in a
 * prompt produces a model that works down it, announces how many there are, and
 * calls that an interview — which is the form this tool exists to be better
 * than, arrived at from the inside. So the framing does most of the work and
 * the list is deliberately given as *where to start*, not as what to cover.
 *
 * Kept next to `ASKABLE` rather than in `prompts.ts` because the two have to
 * agree: the instructions describe a list this function produced, and a change
 * to one is a lie about the other.
 */
export function renderAgenda(questions: readonly OpenQuestion[]): string {
	if (questions.length === 0) {
		return '';
	}

	return [
		'The deterministic checks have found gaps in this part of the vault. They',
		'are where this conversation should start — not what it has to cover.',
		'',
		...questions.map(question => `- ${question.where}: ${question.detail}`),
		'',
		'How to use that list:',
		'',
		'Open on ONE of them. Pick the one you think will produce the best answer,',
		'not the first one written down. Ask about it the way you would ask about',
		'anything else — the specific, the concrete, the particular instance.',
		'',
		'Never show the author this list, never say how many items are on it, and',
		'never work down it in order. They know what is unresolved; they have a',
		'command that tells them. What they came here for is to be asked well',
		'about one of them.',
		'',
		'Abandon it the moment the conversation is better elsewhere. If an answer',
		'opens onto something that is not on the list at all, that is the more',
		'valuable thing and you follow it. A gap filled as a side effect of a good',
		'conversation is worth more than one closed by asking directly, and an',
		'interview that closes every item and discovers nothing has failed at the',
		'only thing it was for.',
	].join('\n');
}

/**
 * Every id of one kind currently in the vault.
 *
 * A finding names *where* it is — an id — and not what kind of thing that is,
 * so the vault is what resolves one to the other. Matching on ids rather than
 * on the finding's name is the difference between a rule that holds and a set
 * of prefix conventions that quietly stops matching the day someone adds
 * `arc_unordered` and spells it `unordered_arc`.
 */
export function idsOf(project: Project, kind: IngestKind): Set<string> {
	const {vault} = project;
	const pages = {
		character: vault.characters,
		moment: vault.moments,
		place: vault.places,
		situation: vault.situations,
		system: vault.systems,
		arc: vault.arcs,
		faction: vault.factions,
		artifact: vault.artifacts,
		skill: vault.skills,
		theme: vault.themes,
		chapter: vault.chapters,
	}[kind];

	return new Set(pages.map(page => page.id));
}

/**
 * The open questions about one kind, which is what an interview about it should
 * open on.
 *
 * Deliberately not every question that mentions the kind. A `broken_reference`
 * on a situation that names a missing character is filed under situation,
 * because that is the page with something wrong on it — and the author fixing
 * it is deciding about that scene, not about a character who does not exist.
 */
export function agendaFor(project: Project, kind: IngestKind): OpenQuestion[] {
	const ids = idsOf(project, kind);
	return project.questions.filter(
		question => question.status === 'open' && ids.has(question.where),
	);
}
