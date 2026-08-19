import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {stringifyDocument} from '../vault/frontmatter.js';
import {resolve, VAULT} from '../vault/paths.js';
import type {Wiki} from './types.js';

export type WikiWriteResult = {
	readonly written: readonly string[];
	readonly removed: readonly string[];
};

/**
 * Same "write only if changed" discipline as `ledger/projections.ts` (D2): a
 * watcher that saw its own write would recompute and write again forever.
 */
async function writeIfChanged(file: string, contents: string): Promise<boolean> {
	const existing = await readFile(file, 'utf8').catch(() => undefined);
	if (existing === contents) {
		return false;
	}
	await writeFile(file, contents, 'utf8');
	return true;
}

/** Hand-rolled rather than `readdir(..., {recursive: true})`: matches the style
 * already used for `listMarkdown` in `vault/load.ts` and `reviewer/corpus.ts`. */
async function listMarkdownRecursive(directory: string): Promise<string[]> {
	const entries = await readdir(directory, {withFileTypes: true}).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listMarkdownRecursive(full)));
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			files.push(full);
		}
	}
	return files;
}

/**
 * Writes every page, then deletes any `.md` file under `wiki/` the current
 * build did not produce. A character deleted from the corpus must not leave a
 * page behind still claiming they exist (types.ts) — the one way a derived
 * reference becomes actively misleading, so unlike an author's own file (P6
 * protects those), a stale page here does not get to survive a recompute.
 * The scan and the deletes are both scoped to `wiki/`; nothing outside it is
 * ever touched.
 */
export async function writeWiki(root: string, wiki: Wiki): Promise<WikiWriteResult> {
	const wikiRoot = resolve(root, VAULT.wiki);
	const written: string[] = [];
	const produced = new Set(wiki.pages.map(page => page.path));

	for (const page of wiki.pages) {
		const file = resolve(root, page.path);
		await mkdir(path.dirname(file), {recursive: true});
		const contents = stringifyDocument({data: {generated: true}, body: `\n${page.body}`});
		if (await writeIfChanged(file, contents)) {
			written.push(page.path);
		}
	}

	const removed: string[] = [];
	for (const file of await listMarkdownRecursive(wikiRoot)) {
		const relative = path.relative(root, file);
		if (!produced.has(relative)) {
			await rm(file, {force: true});
			removed.push(relative);
		}
	}

	return {written, removed};
}
