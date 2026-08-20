import {createTwoFilesPatch} from 'diff';
import type {Line} from '../commands/types.js';
import {
	applyAccepted,
	readExisting,
	resolveInsideVault,
	type PathOptions,
} from './apply.js';
import type {ApplyOutcome, Decision, Proposal, ReviewItem} from './types.js';

/**
 * The review gate's state: a list of proposals and the author's rulings.
 *
 * Deliberately UI-free. §9 says this component is reused wholesale by the
 * Slice 2 spinner, so the decision model, the diff rendering, and the write
 * path all live here and only the keyboard surface is a component.
 */
export class ReviewBatch {
	readonly #root: string;
	#items: ReviewItem[];
	#cursor = 0;
	/**
	 * Carried by the batch rather than by a proposal, because a proposal must
	 * not be able to grant itself permission. Whoever creates the batch decides
	 * what it is allowed to touch.
	 */
	readonly #paths: PathOptions;

	private constructor(root: string, items: ReviewItem[], paths: PathOptions = {}) {
		this.#root = root;
		this.#items = items;
		this.#paths = paths;
	}

	/** Loads current contents for each proposal so diffs show real changes. */
	static async create(
		root: string,
		proposals: readonly Proposal[],
		options: PathOptions = {},
	): Promise<ReviewBatch> {
		const items: ReviewItem[] = [];
		for (const proposal of proposals) {
			items.push({
				proposal,
				existing: await readExisting(root, proposal.path),
				// A removal ends with nothing there, so the diff shows every line
				// going away rather than an empty panel the author has to take on
				// trust. Whatever contents came with the proposal are ignored.
				contents: proposal.remove === true ? '' : proposal.contents,
				decision: 'pending',
				edited: false,
			});
		}
		return new ReviewBatch(root, items, options);
	}

	get items(): readonly ReviewItem[] {
		return this.#items;
	}

	get cursor(): number {
		return this.#cursor;
	}

	get current(): ReviewItem | undefined {
		return this.#items[this.#cursor];
	}

	get size(): number {
		return this.#items.length;
	}

	get settled(): boolean {
		return this.#items.every(item => item.decision !== 'pending');
	}

	counts(): Readonly<Record<Decision, number>> {
		const counts = {pending: 0, accepted: 0, rejected: 0};
		for (const item of this.#items) {
			counts[item.decision] += 1;
		}
		return counts;
	}

	move(delta: number): void {
		if (this.#items.length === 0) {
			return;
		}
		this.#cursor = (this.#cursor + delta + this.#items.length) % this.#items.length;
	}

	#update(index: number, patch: Partial<ReviewItem>): void {
		const item = this.#items[index];
		if (!item) {
			return;
		}
		this.#items = this.#items.map((existing, i) =>
			i === index ? {...existing, ...patch} : existing,
		);
	}

	decide(decision: Exclude<Decision, 'pending'>): void {
		this.#update(this.#cursor, {decision});
		// Advance to the next undecided item so a batch can be cleared without
		// navigating manually.
		const next = this.#items.findIndex(
			(item, index) => index > this.#cursor && item.decision === 'pending',
		);
		const wrapped =
			next === -1 ? this.#items.findIndex(item => item.decision === 'pending') : next;
		if (wrapped !== -1) {
			this.#cursor = wrapped;
		}
	}

	/** "accept-all-in-this-batch" — only touches items not already ruled on. */
	acceptAllPending(): void {
		this.#items = this.#items.map(item =>
			item.decision === 'pending' ? {...item, decision: 'accepted'} : item,
		);
	}

	/** Replaces the current item's contents with the author's hand edit. */
	edit(contents: string): void {
		const item = this.current;
		if (!item) {
			return;
		}
		this.#update(this.#cursor, {
			contents,
			edited: contents !== item.proposal.contents,
		});
	}

	apply(): Promise<ApplyOutcome> {
		return applyAccepted(this.#root, this.#items, this.#paths);
	}

	/** Throws if a proposal targets somewhere it must not. */
	validatePaths(): {path: string; reason: string}[] {
		const problems: {path: string; reason: string}[] = [];
		for (const item of this.#items) {
			try {
				resolveInsideVault(this.#root, item.proposal.path, this.#paths);
			} catch (caught) {
				problems.push({
					path: item.proposal.path,
					reason: caught instanceof Error ? caught.message : String(caught),
				});
			}
		}
		return problems;
	}
}

const COLOR = {
	add: '#9ece6a',
	remove: '#f7768e',
	hunk: '#7aa2f7',
	meta: '#565f89',
} as const;

/**
 * Renders one item as a coloured unified diff.
 *
 * A new file shows as an all-additions diff rather than a raw dump, so the
 * author reads every proposal in the same shape whether it creates or edits.
 */
export function renderDiff(item: ReviewItem): Line[] {
	const patch = createTwoFilesPatch(
		item.existing === undefined ? '/dev/null' : `a/${item.proposal.path}`,
		`b/${item.proposal.path}`,
		item.existing ?? '',
		item.contents,
		'',
		'',
		{context: 3},
	);

	const lines: Line[] = [];
	for (const raw of patch.split('\n')) {
		// Drop jsdiff's separator and the redundant ---/+++ header; the UI already
		// shows the path and whether the file is new.
		if (raw.startsWith('===') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
			continue;
		}
		if (raw.startsWith('@@')) {
			lines.push({text: raw, color: COLOR.hunk});
		} else if (raw.startsWith('+')) {
			lines.push({text: raw, color: COLOR.add});
		} else if (raw.startsWith('-')) {
			lines.push({text: raw, color: COLOR.remove});
		} else if (raw.startsWith('\\')) {
			lines.push({text: raw, color: COLOR.meta, dim: true});
		} else {
			lines.push({text: raw, dim: true});
		}
	}

	// A trailing blank from the patch string adds nothing.
	while (lines.at(-1)?.text.trim() === '') {
		lines.pop();
	}

	return lines;
}

export function diffStat(item: ReviewItem): {added: number; removed: number} {
	let added = 0;
	let removed = 0;
	for (const line of renderDiff(item)) {
		if (line.text.startsWith('+')) {
			added += 1;
		} else if (line.text.startsWith('-')) {
			removed += 1;
		}
	}
	return {added, removed};
}
