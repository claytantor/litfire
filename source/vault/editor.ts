import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readConfig} from './config.js';

/**
 * Resolves the configured editor. D4: `$EDITOR` by default because it is
 * portable and works over SSH; a configured value overrides it.
 */
export async function resolveEditor(root: string): Promise<string | undefined> {
	const configured = (await readConfig(root)).editor;
	const command = configured === '$EDITOR' ? process.env['EDITOR'] : configured;
	return command === undefined || command.trim() === '' ? undefined : command;
}

/** Opens a file in the editor and resolves when it exits. */
export function openInEditor(command: string, file: string): Promise<number> {
	return new Promise(resolve => {
		// `stdio: inherit` hands the terminal to the editor; Ink is suspended by
		// the caller for the duration.
		const child = spawn(command, [file], {stdio: 'inherit'});
		child.on('close', code => resolve(code ?? 0));
		child.on('error', () => resolve(-1));
	});
}

/** Opens a file detached, for "scaffold and keep working" flows. */
export function openDetached(command: string, file: string): void {
	const child = spawn(command, [file], {detached: true, stdio: 'ignore'});
	child.unref();
}

/**
 * Round-trips text through the editor via a temp file.
 *
 * The review gate now edits inline in its own buffer, so this is the escape
 * hatch rather than the only way out: `ctrl+e` reaches for the author's real
 * editor when a proposal is too big to comfortably fix in a pane. `/situation
 * new` still uses it outright, because writing a whole scene is a real editor's
 * job.
 */
export async function editText(
	command: string,
	contents: string,
	basename: string,
): Promise<string | undefined> {
	const directory = await mkdtemp(path.join(tmpdir(), 'litfire-edit-'));
	const file = path.join(directory, basename.replace(/[/\\]/g, '-'));

	try {
		await writeFile(file, contents, 'utf8');
		const code = await openInEditor(command, file);
		if (code < 0) {
			return undefined;
		}
		return await readFile(file, 'utf8');
	} catch {
		return undefined;
	} finally {
		await rm(directory, {recursive: true, force: true});
	}
}
