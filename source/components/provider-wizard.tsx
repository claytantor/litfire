import {Box, Text, useInput} from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import {useCallback, useEffect, useState} from 'react';
import {
	findProvider,
	LOCAL_BASE_URLS,
	maskKey,
	PLACEHOLDER_KEY,
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
	/** Where the author pointed it, for a provider with no single right host. */
	readonly baseUrl?: string;
};

type Props = {
	readonly rows: number;
	readonly columns: number;
	readonly onDone: (result: WizardResult) => void;
	readonly onCancel: () => void;
};

type Step = 'provider' | 'baseUrl' | 'key' | 'testing' | 'model' | 'saving';

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
	const [draftUrl, setDraftUrl] = useState('');
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

	const runTest = useCallback(
		async (id: ProviderId, apiKey: string, baseUrl?: string) => {
			setStep('testing');
			setFailure(undefined);
			setHint(undefined);

			const outcome = await testConnection({
				id,
				apiKey,
				...(baseUrl === undefined || baseUrl === '' ? {} : {baseUrl}),
			});

			if (outcome.ok) {
				setModels(outcome.models);
				setNote(outcome.note);
				setStep('model');
				return;
			}

			setFailure(outcome.reason);
			setHint(outcome.hint);
			// Back to whichever field is the likely culprit, so a typo is one edit
			// away rather than a restart. For a local endpoint that is the URL:
			// there is no key to have got wrong.
			setStep(findProvider(id).keyless === true ? 'baseUrl' : 'key');
		},
		[],
	);

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
				await runTest(provider, resolved.key, draftUrl);
			}
		})();
		// Only on entering the key step for a given provider.
	}, [provider, step, runTest, draftUrl]);

	/**
	 * A keyless provider never shows the key step at all.
	 *
	 * Skipping it rather than pre-filling it: a masked field containing a
	 * placeholder that is not a secret, on a host with no authentication, is a
	 * screen that teaches the wrong thing about what a key is for. A stored key
	 * is still used when one exists, which is what `resolveKey` above is for on
	 * every other provider.
	 */
	useEffect(() => {
		if (provider === undefined || step !== 'key') {
			return;
		}
		if (findProvider(provider).keyless === true) {
			void runTest(provider, PLACEHOLDER_KEY, draftUrl);
		}
	}, [provider, step, runTest, draftUrl]);

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
							const id = value as ProviderId;
							const chosen = findProvider(id);
							setProvider(id);
							setDraftUrl(chosen.baseUrl);
							setStep(chosen.needsBaseUrl === true ? 'baseUrl' : 'key');
						}}
					/>
				</Box>
			)}

			{step === 'baseUrl' && spec !== undefined && (
				<Box flexDirection="column" marginTop={1}>
					<Text>
						<Text color={theme.color.assistant}>{spec.label}</Text>
						<Text dimColor> · no key needed</Text>
					</Text>

					{failure !== undefined && (
						<Box flexDirection="column" marginTop={1}>
							<Text color={theme.color.error}>✖ {failure}</Text>
							{hint !== undefined && <Text dimColor>{hint}</Text>}
						</Box>
					)}

					<Box marginTop={1}>
						<Text dimColor>Base URL </Text>
						<TextInput
							value={draftUrl}
							onChange={setDraftUrl}
							onSubmit={value => {
								const trimmed = value.trim();
								if (trimmed !== '') {
									setDraftUrl(trimmed);
									setStep('key');
								}
							}}
							showCursor
						/>
					</Box>

					{/* The defaults differ only by port, and remembering which server
					    uses which is the one thing an author is likely to get wrong. */}
					<Box flexDirection="column" marginTop={1}>
						<Text dimColor>Common ones:</Text>
						{LOCAL_BASE_URLS.map(one => (
							<Text key={one.url} dimColor>
								{'  '}
								{one.url} — {one.label}
							</Text>
						))}
					</Box>
					<Text dimColor>enter to verify · esc to cancel</Text>
				</Box>
			)}

			{step === 'key' && spec !== undefined && spec.keyless !== true && (
				<Box flexDirection="column" marginTop={1}>
					<Text>
						<Text color={theme.color.assistant}>{spec.label}</Text>
						{spec.keysUrl !== undefined && <Text dimColor> · keys: {spec.keysUrl}</Text>}
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
								// A key supplied by the environment is never written to disk,
								// and neither is the placeholder a keyless provider sends —
								// storing that would put a fake credential in the real
								// credential file, where the next reader would trust it.
								if (
									envKey === undefined &&
									draftKey.trim() !== '' &&
									spec.keyless !== true
								) {
									await saveKey(spec.id, draftKey.trim());
								}
								onDone({
									provider: spec.id,
									model: value,
									...(spec.needsBaseUrl === true ? {baseUrl: draftUrl.trim()} : {}),
								});
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
