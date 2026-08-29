import {createHash} from 'node:crypto';
import {readExisting} from '../review/apply.js';
import {diffStat, renderDiff} from '../review/batch.js';
import type {ReviewItem} from '../review/types.js';

/**
 * A proposed batch, written to a file so a second, explicit invocation can
 * apply it.
 *
 * Two processes and a file rather than one process and a flag, deliberately.
 * The gate's guarantee is that a change is a decision somebody made, and a
 * `--propose --apply` pair in one command line is not a decision, it is a
 * typo away from being one. Nothing here can apply anything; `review apply`
 * is the only thing that can, and it takes an explicit list.
 */

export const BATCH_VERSION = 1;

export type SerialisedItem = {
	readonly index: number;
	readonly proposal: {
		readonly path: string;
		readonly contents: string;
		readonly remove?: boolean;
		readonly confidence?: 'high' | 'low';
		readonly rationale?: string;
	};
	/** Contents on disk when this was proposed; null when the file was absent. */
	readonly existing: string | null;
	/** What the gate would show. Rendered here so a caller need not diff. */
	readonly diff: readonly string[];
	readonly stat: {readonly added: number; readonly removed: number};
	/**
	 * The state this item was computed against — see `stateHash`.
	 *
	 * Per item rather than one hash for the batch: a batch whose third target
	 * moved should still be applicable for the other two, and a single hash
	 * would fail all of them over one file.
	 */
	readonly stateHash: string;
};

export type SerialisedBatch = {
	readonly batchVersion: number;
	readonly vault: string;
	readonly title: string;
	readonly createdAt: string;
	readonly items: readonly SerialisedItem[];
};

/**
 * A fingerprint of what a target looked like when the proposal was made.
 *
 * **Absent is not the same as empty**, and conflating them is the whole reason
 * this is a function rather than a `createHash` call at each site. A proposal
 * for a file that did not exist, applied after something else created it,
 * would otherwise sail through the staleness check and overwrite work nobody
 * saw — which is exactly the silent corruption the check exists to prevent.
 */
export function stateHash(existing: string | undefined): string {
	return existing === undefined
		? 'absent'
		: `sha256:${createHash('sha256').update(existing, 'utf8').digest('hex')}`;
}

export async function serialiseBatch(
	root: string,
	title: string,
	items: readonly ReviewItem[],
	now: string,
): Promise<SerialisedBatch> {
	return {
		batchVersion: BATCH_VERSION,
		vault: root,
		title,
		createdAt: now,
		items: items.map((item, index) => ({
			index: index + 1,
			proposal: {
				path: item.proposal.path,
				contents: item.proposal.contents,
				...(item.proposal.remove === undefined ? {} : {remove: item.proposal.remove}),
				...(item.proposal.confidence === undefined
					? {}
					: {confidence: item.proposal.confidence}),
				...(item.proposal.rationale === undefined
					? {}
					: {rationale: item.proposal.rationale}),
			},
			existing: item.existing ?? null,
			diff: renderDiff(item).map(line => line.text),
			stat: diffStat(item),
			stateHash: stateHash(item.existing),
		})),
	};
}

export type Staleness = {
	readonly path: string;
	readonly was: string;
	readonly now: string;
};

/**
 * Which of the chosen items no longer match the vault they were computed
 * against.
 *
 * Checked at apply time rather than trusted from propose time, because the
 * whole point is that something may have happened in between — the author
 * editing a page, another exec run landing, a `git checkout`. A stale batch
 * applied blind is a change nobody reviewed.
 */
export async function staleItems(
	root: string,
	chosen: readonly SerialisedItem[],
): Promise<readonly Staleness[]> {
	const stale: Staleness[] = [];
	for (const item of chosen) {
		// Read through the same guard a write goes through, so a path that has
		// become unsafe since propose time fails here rather than at write time.
		const current = stateHash(await readExisting(root, item.proposal.path));
		if (current !== item.stateHash) {
			stale.push({path: item.proposal.path, was: item.stateHash, now: current});
		}
	}
	return stale;
}

/** Turns chosen entries back into the `ReviewItem[]` `applyAccepted` expects. */
export function toReviewItems(chosen: readonly SerialisedItem[]): ReviewItem[] {
	return chosen.map(item => ({
		proposal: item.proposal,
		existing: item.existing ?? undefined,
		contents: item.proposal.contents,
		// The choosing *is* the acceptance. Nothing not named on the command line
		// reaches here, so there is no pending or rejected state to carry.
		decision: 'accepted' as const,
		edited: false,
	}));
}
