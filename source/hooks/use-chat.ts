import {useCallback, useRef, useState} from 'react';
import type {Engine} from '../engine/types.js';
import {AbortedError} from '../engine/types.js';
import {createMessage, type ChatStatus, type Message} from '../types.js';

export type UseChatResult = {
	/** Turns that are finished. Append-only, so `<Static>` can own them. */
	readonly messages: readonly Message[];
	/** Text of the reply currently arriving, or '' when nothing is in flight. */
	readonly streaming: string;
	readonly status: ChatStatus;
	readonly error: string | undefined;
	readonly send: (input: string) => void;
	readonly cancel: () => void;
	/** Drops history so the next turn starts a fresh context. */
	readonly clear: () => void;
};

export function useChat(engine: Engine): UseChatResult {
	const [messages, setMessages] = useState<readonly Message[]>([]);
	const [streaming, setStreaming] = useState('');
	const [status, setStatus] = useState<ChatStatus>('idle');
	const [error, setError] = useState<string | undefined>(undefined);
	const abortRef = useRef<AbortController | undefined>(undefined);
	// Bumped by `clear`. An in-flight turn captures the value at send time and
	// refuses to commit its buffer if the conversation moved on beneath it.
	const generationRef = useRef(0);

	const cancel = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const send = useCallback(
		(input: string) => {
			const trimmed = input.trim();
			if (trimmed === '' || abortRef.current) {
				return;
			}

			const controller = new AbortController();
			abortRef.current = controller;
			const generation = generationRef.current;

			const outgoing = createMessage('user', trimmed, Date.now());
			// Capture the history the engine should see, including this turn,
			// without depending on when React flushes the state update.
			const history = [...messages, outgoing];

			setMessages(history);
			setStreaming('');
			setStatus('streaming');
			setError(undefined);

			void (async () => {
				let buffer = '';
				try {
					for await (const delta of engine.send(history, controller.signal)) {
						// An engine that ignores its abort signal would otherwise keep
						// painting into a conversation the user already cleared.
						if (generationRef.current !== generation) {
							break;
						}
						buffer += delta;
						setStreaming(buffer);
					}
					if (generationRef.current === generation) {
						setStatus('idle');
					}
				} catch (caught) {
					if (generationRef.current !== generation) {
						// Cleared mid-flight; the error belongs to a conversation
						// that no longer exists.
					} else if (caught instanceof AbortedError || controller.signal.aborted) {
						// A cancelled turn keeps whatever text already arrived.
						setStatus('idle');
					} else {
						setStatus('error');
						setError(caught instanceof Error ? caught.message : String(caught));
					}
				} finally {
					if (generationRef.current === generation) {
						// Commit the reply — even a partial one — so the transcript
						// reflects what the user actually saw on screen.
						if (buffer.trim() !== '') {
							setMessages(previous => [
								...previous,
								createMessage('assistant', buffer.trimEnd(), Date.now()),
							]);
						}
						setStreaming('');
					}
					abortRef.current = undefined;
				}
			})();
		},
		[engine, messages],
	);

	const clear = useCallback(() => {
		generationRef.current += 1;
		abortRef.current?.abort();
		setMessages([]);
		setStreaming('');
		setStatus('idle');
		setError(undefined);
	}, []);

	return {messages, streaming, status, error, send, cancel, clear};
}
