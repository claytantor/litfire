import type {InterviewKind} from '../interview/prompts.js';
import type {ResolvedProfile, Setting} from './types.js';

/**
 * Interview overlays (§5).
 *
 * A profile *appends* questions and a register note; it never removes a base
 * question. That constraint is what keeps one engine viable — the genre-neutral
 * brief stays the primary prompt, and the idiom is an addition rather than a
 * fork of the prompt text.
 *
 * The traffic runs one way. Everything here is setting-specific by definition;
 * anything that pays off in *every* idiom belongs in the base brief instead, or
 * it is genre-neutral text that a vault silently loses by choosing no profile.
 */

const SF_SYSTEM = `Because this world's System is built rather than discovered, also press on:

- Who built this, who owns it now, and who pays for its upkeep? A technological
  System has an operator and an operating cost — both are plot.
- What is the interface, physically? An implant, an overlay, an issued device,
  something grown? Who can remove it?
- What happens when it fails, and how often does it? Anything built degrades,
  and failure modes are free tension.
- Is anyone maintaining it, and are they good at their job?
- What is the version history? A System that has been patched has politics.
- Who is excluded, and how? Access control is the most reliably underused SF
  premise in the genre.
- What does the operator get out of running this? If the answer is nothing, the
  System is scenery.`;

const ARCANE_SYSTEM = `Because this world's System is discovered rather than built, also press on:

- What did people believe before the rules were legible, and who was wrong?
- Is there an authority that adjudicates the rules, or is it self-executing?
- What is forbidden as opposed to impossible, and who does the forbidding?
- What is the folk version of the System, and how does it diverge from the true
  one?
- What did the previous age's practitioners do differently, and why did it stop?`;

/** Overlay id → the interviews it augments. */
const OVERLAYS: Readonly<Record<string, Partial<Record<InterviewKind, string>>>> = {
	sf: {system: SF_SYSTEM},
	arcane: {system: ARCANE_SYSTEM},
};

/**
 * Reminds the interviewer what the author has already committed to, so it
 * presses correctly: a technological origin means "it's just how it works" is
 * not an available answer, while `unexplained` means the mystery is deliberate
 * and should not be interrogated as though it were an oversight.
 */
function descriptorNotes(setting: Setting): string[] {
	const notes: string[] = [];

	if (setting.system_origin !== undefined) {
		notes.push(
			setting.system_origin === 'unexplained'
				? "The author has chosen to leave the System's origin unexplained. That is a deliberate choice — do not press them to explain it. Press instead on what people believe about it."
				: `The System's origin is ${setting.system_origin}. ${
						setting.system_origin === 'technological' ||
						setting.system_origin === 'simulated'
							? 'Readers will expect internal logic that connects to something, so "it just works" is not available as an answer here.'
							: 'Press for the specific rather than the mystical.'
					}`,
		);
	}

	if (setting.system_visibility !== undefined) {
		notes.push(`Visibility is ${setting.system_visibility}.`);
	}
	if (setting.system_agency !== undefined) {
		notes.push(`Agency is ${setting.system_agency}.`);
	}

	return notes;
}

/**
 * Everything a profile and setting contribute to one interview's prompt,
 * appended after the base brief.
 */
export function overlayFor(
	kind: InterviewKind,
	profile: ResolvedProfile,
	setting: Setting,
	briefing: string,
): string {
	const parts: string[] = [];

	const overlayId = profile.interview_overlay;
	const overlay = overlayId === undefined ? undefined : OVERLAYS[overlayId]?.[kind];
	if (overlay !== undefined) {
		parts.push(overlay);
	}

	const notes = descriptorNotes(setting);
	if (notes.length > 0) {
		parts.push(
			`Already established about this setting:\n\n${notes.map(n => `- ${n}`).join('\n')}`,
		);
	}

	if (briefing !== '') {
		parts.push(briefing);
	}

	if (profile.register !== undefined) {
		parts.push(`Register: ${profile.register}`);
	}

	return parts.join('\n\n');
}

export {OVERLAYS};
