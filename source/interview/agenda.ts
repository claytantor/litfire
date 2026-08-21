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
	theme: 'theme',
	chapter: 'chapter',
};

/** The kinds an interview can be had about today, in a readable order. */
export const INTERVIEWABLE: readonly IngestKind[] = Object.keys(
	BRIEF_FOR,
) as IngestKind[];

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
