import {Box, Text, useInput} from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import {useCallback, useEffect, useState} from 'react';
import {
	findProvider,
	maskKey,
	PROVIDERS,
	resolveKey,
	saveKey,
	testConnection,
	type ModelInfo,
	type ProviderId,
} from '../llm/index.js';
import {contentWidth, rowsFor, viewportHeight} from '../hooks/use-viewport.js';
import {theme} from '../theme.js';
import {SelectList, type SelectItem} from './select-list.js';

export type WizardResult = {
	readonly provider: ProviderId;
	readonly model: string;
};

type Props = {
	readonly rows: number;
	readonly columns: number;
	readonly onDone: (result: WizardResult) => void;
	readonly onCancel: () => void;
};

type Step = 'provider' | 'key' | 'testing' | 'model' | 'saving';

/**
 * `/provider` — select a provider, supply a key, verify the connection, then
 * pick a model from the list the provider itself returned.
 *
 * The verification step is a model-list call, so it costs no tokens and proves
 * the key, the network path, and the base URL in one go.
 */
export function ProviderWizard({rows, columns, onDone, onCancel}: Props) {
	const [step, setStep] = useState<Step>('provider');
	const [provider, setProvider] = useState<ProviderId | undefined>(undefined);
	const [draftKey, setDraftKey] = useState('');
	const [envKey, setEnvKey] = useState<string | undefined>(undefined);
	/** Where an auto-supplied key came from — the env var, or the file it named. */
	const [keyOrigin, setKeyOrigin] = useState<string | undefined>(undefined);
	const [models, setModels] = useState<readonly ModelInfo[]>([]);
	const [failure, setFailure] = useState<string | undefined>(undefined);
	const [hint, setHint] = useState<string | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);

	useInput(
		(_input, key) => {
			if (key.escape) {
				onCancel();
			}
		},
		{isActive: step !== 'saving'},
	);

	const runTest = useCallback(async (id: ProviderId, apiKey: string) => {
		setStep('testing');
		setFailure(undefined);
		setHint(undefined);

		const outcome = await testConnection({id, apiKey});

		if (outcome.ok) {
			setModels(outcome.models);
			setNote(outcome.note);
			setStep('model');
			return;
		}

		setFailure(outcome.reason);
		setHint(outcome.hint);
		// Back to the key step so a typo is one edit away, not a restart.
		setStep('key');
	}, []);

	// A key already supplied by the environment — literally, or through the file
	// its `…_FILE` variant names — skips straight to verification. Typing a key
	// that is already on disk is busywork.
	useEffect(() => {
		if (provider === undefined || step !== 'key') {
			return;
		}
		void (async () => {
			const resolved = await resolveKey(provider);
			if ((resolved.source === 'env' || resolved.source === 'file') && resolved.key) {
				setEnvKey(resolved.key);
				setKeyOrigin(
					resolved.source === 'file'
						? (resolved.path ?? resolved.fileEnvVar)
						: resolved.envVar,
				);
				await runTest(provider, resolved.key);
			}
		})();
		// Only on entering the key step for a given provider.
	}, [provider, step, runTest]);

	const providerItems: SelectItem[] = PROVIDERS.map(spec => ({
		value: spec.id,
		label: spec.label,
		...(spec.note === undefined ? {} : {hint: `— ${spec.note}`}),
	}));

	const modelItems: SelectItem[] = models.map(model => ({
		value: model.id,
		label: model.id,
		...(model.label === undefined || model.label === model.id
			? {}
			: {hint: `— ${model.label}`}),
	}));

	const spec = provider === undefined ? undefined : findProvider(provider);

	const width = contentWidth(columns);
	// Round border, the `/provider` heading, the step's marginTop, its own
	// caption, and a row of slack. Anything the step adds above the list is
	// measured on top of that, because a note or a provider label wraps on a
	// narrow terminal and the list is what has to give way.
	const listHeight = (extra = 0) => viewportHeight(rows, 2 + 1 + 1 + 1 + 1 + extra);

	const connectedRows =
		spec === undefined
			? 0
			: rowsFor(
					`✔ connected to ${spec.label}${keyOrigin === undefined ? '' : ` (key from ${keyOrigin})`}`,
					width,
				) +
				(note === undefined ? 0 : rowsFor(note, width)) +
				// The step's second marginTop, above the "Select a model" caption.
				1 +
				(envKey === undefined && draftKey !== '' ? 1 : 0);

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={theme.color.border}
			paddingX={1}
		>
			<Text bold color={theme.color.brand}>
				/provider
			</Text>

			{step === 'provider' && (
				<Box flexDirection="column" marginTop={1}>
					<Text dimColor>Select a model provider:</Text>
					<SelectList
						items={providerItems}
						height={listHeight()}
						width={width}
						onSelect={value => {
							setProvider(value as ProviderId);
							setStep('key');
						}}
					/>
				</Box>
			)}

			{step === 'key' && spec !== undefined && (
				<Box flexDirection="column" marginTop={1}>
					<Text>
						<Text color={theme.color.assistant}>{spec.label}</Text>
						<Text dimColor> · keys: {spec.keysUrl}</Text>
					</Text>

					{failure !== undefined && (
						// The hint gets its own line rather than a parenthetical: the one
						// that matters most here explains which of two sibling entries the
						// key belongs to, and that does not fit inside brackets.
						<Box flexDirection="column" marginTop={1}>
							<Text color={theme.color.error}>✖ {failure}</Text>
							{hint !== undefined && <Text dimColor>{hint}</Text>}
						</Box>
					)}

					<Box marginTop={1}>
						<Text dimColor>API key </Text>
						<TextInput
							value={draftKey}
							onChange={setDraftKey}
							onSubmit={value => {
								const trimmed = value.trim();
								if (trimmed !== '') {
									void runTest(spec.id, trimmed);
								}
							}}
							placeholder={`or set ${spec.envVar}, or ${spec.envVar}_FILE=<path>`}
							mask="•"
							showCursor
						/>
					</Box>
					<Text dimColor>enter to verify · esc to cancel</Text>
				</Box>
			)}

			{step === 'testing' && spec !== undefined && (
				<Box marginTop={1}>
					<Text color={theme.color.brand}>
						<Spinner type="dots" />
					</Text>
					<Text dimColor> verifying against {spec.label}…</Text>
				</Box>
			)}

			{step === 'model' && spec !== undefined && (
				<Box flexDirection="column" marginTop={1}>
					<Text color={theme.color.assistant}>
						✔ connected to {spec.label}
						{keyOrigin === undefined ? '' : ` (key from ${keyOrigin})`}
					</Text>
					{note !== undefined && <Text dimColor>{note}</Text>}
					<Box marginTop={1}>
						<Text dimColor>Select a model ({models.length} available):</Text>
					</Box>
					<SelectList
						items={modelItems}
						height={listHeight(connectedRows)}
						width={width}
						onSelect={value => {
							setStep('saving');
							void (async () => {
								// A key supplied by the environment is never written to disk.
								if (envKey === undefined && draftKey.trim() !== '') {
									await saveKey(spec.id, draftKey.trim());
								}
								onDone({provider: spec.id, model: value});
							})();
						}}
					/>
					{envKey === undefined && draftKey !== '' && (
						<Text dimColor>
							{'  '}key {maskKey(draftKey.trim())} will be saved outside the vault
						</Text>
					)}
				</Box>
			)}

			{step === 'saving' && (
				<Box marginTop={1}>
					<Text color={theme.color.brand}>
						<Spinner type="dots" />
					</Text>
					<Text dimColor> saving…</Text>
				</Box>
			)}
		</Box>
	);
}
