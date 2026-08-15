import {Static} from 'ink';
import type {Message} from '../types.js';
import {Header} from './header.js';
import {MessageView} from './message-view.js';

/**
 * Ink supports a single `<Static>` region, and it always prints above the live
 * area. The banner therefore has to travel through the same list as the
 * messages — otherwise it would render below the transcript, wedged between
 * the conversation and the composer.
 */
export type TranscriptItem =
	| {readonly kind: 'banner'; readonly id: string; readonly version: string}
	| {readonly kind: 'message'; readonly id: string; readonly message: Message};

type Props = {
	readonly items: readonly TranscriptItem[];
};

/**
 * Finished turns render through `<Static>`: Ink writes them once and never
 * redraws them. That keeps a long conversation cheap and lets the terminal's
 * own scrollback do the scrolling.
 */
export function Transcript({items}: Props) {
	return (
		<Static items={[...items]}>
			{item =>
				item.kind === 'banner' ? (
					<Header key={item.id} version={item.version} />
				) : (
					<MessageView
						key={item.id}
						role={item.message.role}
						content={item.message.content}
					/>
				)
			}
		</Static>
	);
}
