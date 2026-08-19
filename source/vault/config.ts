import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {providerIdSchema} from '../llm/types.js';
import {resolve, VAULT} from './paths.js';

export const configSchema = z.object({
	version: z.number().int().default(1),
	editor: z.string().default('$EDITOR'),
	/**
	 * Which provider and model are selected. Deliberately holds no API key —
	 * keys live outside the vault (see source/llm/credentials.ts), because this
	 * file sits inside a folder people sync and share.
	 */
	provider: z
		.object({
			id: providerIdSchema.optional(),
			model: z.string().optional(),
			baseUrl: z.string().optional(),
		})
		.default({}),
	/**
	 * Hash of the formula set the author has agreed to execute (§6.4). Stored so
	 * consent survives a restart; changing any formula changes the hash and
	 * withdraws consent automatically.
	 */
	consentedFormulaHash: z.string().nullable().default(null),
});

export type Config = z.infer<typeof configSchema>;

export async function readConfig(root: string): Promise<Config> {
	const raw = await readFile(resolve(root, VAULT.config), 'utf8').catch(() => undefined);
	if (raw === undefined) {
		return configSchema.parse({});
	}

	try {
		return configSchema.parse(JSON.parse(raw));
	} catch {
		// A corrupt config must not stop the author working (P4).
		return configSchema.parse({});
	}
}

export async function writeConfig(root: string, config: Config): Promise<void> {
	await mkdir(resolve(root, VAULT.meta), {recursive: true});
	await writeFile(
		resolve(root, VAULT.config),
		`${JSON.stringify(config, null, 2)}\n`,
		'utf8',
	);
}

export async function recordConsent(root: string, hash: string): Promise<void> {
	const config = await readConfig(root);
	await writeConfig(root, {...config, consentedFormulaHash: hash});
}

export async function saveProvider(
	root: string,
	provider: {id: string; model: string; baseUrl?: string},
): Promise<void> {
	const config = await readConfig(root);
	await writeConfig(root, {
		...config,
		provider: configSchema.shape.provider.parse(provider),
	});
}
