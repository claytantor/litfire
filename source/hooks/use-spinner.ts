import {useEffect, useState} from 'react';

/**
 * The `dots` frames, as text.
 *
 * `ink-spinner` is a component, which is the right shape almost everywhere —
 * but some waits in this tool are rendered as `Line[]` and handed to a pager or
 * a list, where there is nowhere to put an element. Those still need something
 * that moves, so the frames are available as a string here.
 *
 * Same sequence and interval as `ink-spinner`'s default, so a screen showing
 * both does not look like two different programs.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const INTERVAL_MS = 80;

/**
 * One spinner frame, advancing while `active`.
 *
 * Returns an empty string when idle rather than a stalled glyph: a spinner that
 * has stopped reads as a hang, which is the exact impression the spinner exists
 * to prevent.
 */
export function useSpinnerFrame(active: boolean): string {
	const [index, setIndex] = useState(0);

	useEffect(() => {
		if (!active) {
			return;
		}
		const timer = setInterval(() => {
			setIndex(current => (current + 1) % FRAMES.length);
		}, INTERVAL_MS);
		// Unref'd so a spinner can never be the reason the process stays alive.
		timer.unref?.();
		return () => {
			clearInterval(timer);
		};
	}, [active]);

	return active ? (FRAMES[index % FRAMES.length] ?? FRAMES[0]) : '';
}

export {FRAMES as SPINNER_FRAMES};
