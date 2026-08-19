import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {resolve, VAULT} from '../vault/paths.js';

/**
 * Runs the wiki review server in a worker thread.
 *
 * The worker executes `wiki/serve.mjs` — the copy in the author's own vault,
 * not a private module — so what litfire serves and what `node wiki/serve.mjs`
 * serves are the same file. There is no second implementation to drift.
 *
 * A worker rather than a detached process: the server is scoped to this
 * session, so `/quit` takes it with it and no orphan is left holding a port
 * after litfire is gone.
 */

export const SERVE_SCRIPT = 'serve.mjs';

export type WikiServe = {
	readonly url: string;
	readonly port: number;
	/** The interface actually bound. `0.0.0.0` means every one of them. */
	readonly host: string;
	close(): Promise<void>;
};

/**
 * The vault has no `node_modules`, so the copy gets an absolute URL to the
 * `marked` that came with litfire. Rewritten on every build, which is what lets
 * it survive litfire being reinstalled somewhere else.
 */
function markedUrl(): string {
	return import.meta.resolve('marked');
}

function sourceScript(): string {
	return fileURLToPath(new URL('./serve-script.mjs', import.meta.url));
}

/**
 * Copies the server into the vault, pointing it at litfire's `marked`.
 *
 * Write-if-changed for the same reason `ledger/projections.ts` is: the file
 * watcher sees this directory, and a rewrite on every build would trigger a
 * recompute that changes nothing.
 */
export async function writeServeScript(root: string): Promise<string> {
	const source = await readFile(sourceScript(), 'utf8');
	const contents = source.replace(
		/^const MARKED_URL = 'marked';$/m,
		`const MARKED_URL = ${JSON.stringify(markedUrl())};`,
	);

	const target = resolve(root, VAULT.wiki, SERVE_SCRIPT);
	await mkdir(resolve(root, VAULT.wiki), {recursive: true});

	const existing = await readFile(target, 'utf8').catch(() => undefined);
	if (existing !== contents) {
		await writeFile(target, contents, 'utf8');
	}

	return target;
}

let singleton: WikiServe | undefined;

export function currentServe(): WikiServe | undefined {
	return singleton;
}

export async function stopWikiServe(): Promise<void> {
	await singleton?.close();
}

export async function startWikiServe(
	root: string,
	options: {readonly port?: number | undefined; readonly host?: string | undefined} = {},
): Promise<WikiServe> {
	const script = await writeServeScript(root);

	const worker = new Worker(script, {
		workerData: {litfireServe: true, root, port: options.port, host: options.host},
		// Nothing is read from this thread's stdin, and letting the worker inherit
		// stdout would corrupt Ink's frame the moment the server logged anything.
		stdout: true,
		stderr: true,
	});

	const ready = await new Promise<{url: string; port: number; host: string}>(
		(done, fail) => {
			worker.once('message', message =>
				done(message as {url: string; port: number; host: string}),
			);
			worker.once('error', fail);
			worker.once('exit', code => fail(new Error(`wiki server exited (${code})`)));
		},
	);

	const handle: WikiServe = {
		url: ready.url,
		port: ready.port,
		host: ready.host,
		async close() {
			// Terminate rather than a graceful stop message: the worker owns nothing
			// but a listening socket, and waiting on a round trip during `/quit`
			// risks hanging the exit on a wedged thread.
			await worker.terminate();
			if (singleton === handle) {
				singleton = undefined;
			}
		},
	};

	singleton = handle;
	return handle;
}
