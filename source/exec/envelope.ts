import type {Line} from '../commands/types.js';

/**
 * The contract an agent parses.
 *
 * Versioned from the first release, because the alternative is agents scraping
 * `Line[]` text and every wording change becoming a breaking one. `lines` is
 * still here — the human rendering is not lost, it is just no longer the
 * interface — and `data` is the typed payload the caller should actually read.
 *
 * `data` may be null for a command that has no structured form yet. It is never
 * null for `questions` or `lint`: those are the two an agent will really parse,
 * and a null there would push it straight back to scraping text.
 */
export const SCHEMA_VERSION = 1;

export type Envelope = {
	readonly ok: boolean;
	readonly command: string;
	readonly vault: string;
	readonly litfireVersion: string;
	readonly schemaVersion: number;
	/** The typed payload. Null when this command has no structured form. */
	readonly data: unknown;
	/** The human rendering, kept so nothing the TUI would have shown is lost. */
	readonly lines: readonly Line[];
	/** True when the command changed the vault. Always false in tier 1. */
	readonly dirty: boolean;
	/** Present only when `ok` is false. */
	readonly error?: {
		readonly code: ExitCode;
		readonly reason: string;
		/** The command the author should run, when there is one. */
		readonly remedy?: string;
	};
};

/**
 * Exit codes, because an agent branches on them.
 *
 * Distinct rather than a single failure code: "refused because interactive" and
 * "refused because the batch is stale" call for completely different responses
 * from a caller, and collapsing them would force it to parse the message to
 * tell them apart — which is the thing this envelope exists to avoid.
 */
export const EXIT = {
	ok: 0,
	commandError: 1,
	usageError: 2,
	refused: 3,
	staleBatch: 4,
	consentRequired: 5,
	noProvider: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export function envelope(
	fields: Omit<Envelope, 'schemaVersion' | 'ok'> & {readonly ok?: boolean},
): Envelope {
	return {
		schemaVersion: SCHEMA_VERSION,
		ok: fields.ok ?? fields.error === undefined,
		...fields,
	};
}

/** Renders an envelope for a terminal, when `--json` was not asked for. */
export function renderEnvelope(one: Envelope): string {
	const body = one.lines.map(line => line.text).join('\n');
	if (one.error === undefined) {
		return body;
	}
	return [
		body,
		body === '' ? undefined : '',
		one.error.reason,
		one.error.remedy === undefined ? undefined : `  ${one.error.remedy}`,
	]
		.filter(part => part !== undefined)
		.join('\n');
}
