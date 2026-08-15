import {useMemo, useState} from 'react';
import {Box, Text, useApp, useInput, useWindowSize} from 'ink';
import {Composer} from './components/composer.js';
import {MessageView} from './components/message-view.js';
import {StatusBar} from './components/status-bar.js';
import {Transcript, type TranscriptItem} from './components/transcript.js';
import type {Engine} from './engine/types.js';
import {useChat} from './hooks/use-chat.js';
import {theme} from './theme.js';

type Props = {
	readonly engine: Engine;
	readonly version: string;
};

const HELP = [
	'/help   show this message',
	'/clear  clear the conversation',
	'/quit   exit litfire',
].join('\n');

export function App({engine, version}: Props) {
	const {exit} = useApp();
	const {columns} = useWindowSize();
	const {messages, streaming, status, error, send, cancel, clear} = useChat(engine);
	const [draft, setDraft] = useState('');
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [epoch, setEpoch] = useState(0);

	const isStreaming = status === 'streaming';

	useInput((_input, key) => {
		if (key.escape) {
			if (isStreaming) {
				cancel();
			} else if (draft !== '') {
				setDraft('');
			}
		}
	});

	const items = useMemo<TranscriptItem[]>(
		() => [
			// `epoch` is part of the key so /clear produces a genuinely new set of
			// static items rather than colliding with ids Ink has already printed.
			{kind: 'banner', id: `banner-${epoch}`, version},
			...messages.map((message): TranscriptItem => ({
				kind: 'message',
				id: `${epoch}-${message.id}`,
				message,
			})),
		],
		[epoch, messages, version],
	);

	const handleSubmit = (value: string) => {
		const trimmed = value.trim();
		if (trimmed === '') {
			return;
		}

		setDraft('');
		setNotice(undefined);

		switch (trimmed) {
			case '/quit':
			case '/exit': {
				exit();
				return;
			}
			case '/clear': {
				clear();
				setEpoch(current => current + 1);
				setNotice('Conversation cleared.');
				return;
			}
			case '/help': {
				setNotice(HELP);
				return;
			}
			default: {
				send(trimmed);
			}
		}
	};

	return (
		<Box flexDirection="column">
			<Transcript items={items} />

			{streaming !== '' && <MessageView role="assistant" content={streaming} pending />}

			{notice !== undefined && (
				<Box marginBottom={1} paddingX={1}>
					<Text color={theme.color.system}>{notice}</Text>
				</Box>
			)}

			<Composer
				value={draft}
				onChange={setDraft}
				onSubmit={handleSubmit}
				disabled={isStreaming}
			/>

			<StatusBar
				status={status}
				error={error}
				engineName={engine.name}
				columns={columns}
			/>
		</Box>
	);
}
