// The litfire wiki review server.
//
// This file is copied into a vault at `wiki/serve.mjs` by `/wiki build`, and
// that copy is what `/wiki serve` runs in a worker thread. It is deliberately
// standalone — `node:` builtins plus `marked` — so the same file works three
// ways: as a worker inside litfire, as `node wiki/serve.mjs [port]` from a
// terminal, and as something an author can read to see exactly what is being
// served.
//
// Everything is read off disk per request (P1 — the filesystem is the API), so
// after a `/wiki build` or a hand edit in Obsidian a browser refresh is all
// that is needed. Nothing is cached and nothing is pre-rendered.
//
// SECURITY. This serves an author's unpublished manuscript.
//   1. The bind address defaults to 127.0.0.1 and only widens when the author
//      asks for it. Anything else reaches every machine on the network, with no
//      authentication — that is a deliberate choice, never a default.
//   2. Resolve every request path canonically inside the served directory, and
//      decode BEFORE validating. Load-bearing at any bind address, and more so
//      once the listener is not loopback.
//   3. Escape raw HTML out of author markdown; this opens in a real browser.

import {readdir, readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {networkInterfaces} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isMainThread, parentPort, workerData} from 'node:worker_threads';

// litfire:marked-url — the copy written into a vault has this line rewritten to
// an absolute file URL, because a vault has no node_modules of its own.
const MARKED_URL = 'marked';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7391;
/** Words an author can use instead of typing an address. */
const ALL_INTERFACES = new Set(['lan', 'all', 'any', '0.0.0.0']);
/** "the next few" — enough to survive a couple of stale servers, not a scan. */
const PORT_SCAN_ATTEMPTS = 10;
const WIKI_DIR = 'wiki';
const WIKI_PREFIX = '/wiki/';
const CORPUS_PREFIX = '/corpus/';

const {Marked} = await import(MARKED_URL);

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

class ForbiddenPathError extends Error {}

/**
 * A request path is untrusted input choosing a file. A substring test for `..`
 * cannot see through `a/../../b` — only where the path actually lands once
 * resolved can, which is why this compares canonical paths.
 */
function resolveWithinBase(baseDir, candidate) {
	if (candidate.trim() === '') {
		throw new ForbiddenPathError('empty path');
	}
	if (path.isAbsolute(candidate)) {
		throw new ForbiddenPathError('absolute paths are not allowed');
	}
	if (candidate.includes('\0')) {
		throw new ForbiddenPathError('null byte in path');
	}

	const base = path.resolve(baseDir);
	const target = path.resolve(base, candidate);
	const relative = path.relative(base, target);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new ForbiddenPathError('path escapes the served directory');
	}
	if (!target.endsWith('.md')) {
		throw new ForbiddenPathError('only markdown files are served');
	}

	return target;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const HTML_ESCAPES = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

function escapeHtml(text) {
	return text.replace(/[&<>"']/g, char => HTML_ESCAPES[char] ?? char);
}

/**
 * Only the body is ever rendered, so this splits frontmatter off without
 * parsing the YAML — which is what keeps the script free of a yaml dependency
 * a vault could not resolve.
 */
function splitFrontmatter(raw) {
	const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
	const normalized = text.replace(/\r\n/g, '\n');
	if (!normalized.startsWith('---\n')) {
		return normalized;
	}
	const end = normalized.indexOf('\n---', 3);
	if (end === -1) {
		return normalized;
	}
	const after = normalized.slice(end + 4);
	return after.startsWith('\n') ? after.slice(1) : after;
}

/**
 * Marked stopped sanitizing after v1 — raw HTML tokens pass through verbatim.
 * Corpus text can be pasted from anywhere and this renders into the author's
 * real browser, so raw HTML becomes visible text instead of executing.
 */
const markdown = new Marked({
	renderer: {
		html({text}) {
			return escapeHtml(text);
		},
	},
});

const WIKILINK = () => /\[\[([^[\]]+)\]\]/g;

/**
 * Splits Obsidian's alias form, `[[target|display]]`.
 *
 * Only the left half names a file. The index writes `[[the-lathe|The Lathe]]`
 * so a reader sees the name rather than the slug, and resolving the whole
 * capture as an id finds nothing — which renders the link as plain text and is
 * exactly how every index link went dead.
 */
function splitWikilink(raw) {
	const bar = raw.indexOf('|');
	if (bar === -1) {
		const only = raw.trim();
		return {target: only, label: only};
	}
	const target = raw.slice(0, bar).trim();
	const label = raw.slice(bar + 1).trim();
	return {target, label: label === '' ? target : label};
}

async function findMarkdownByBasename(baseDir, id, skipTopLevel = new Set()) {
	let entries;
	try {
		entries = await readdir(baseDir, {withFileTypes: true, recursive: true});
	} catch {
		return undefined;
	}

	for (const entry of entries) {
		if (!entry.isFile() || entry.name !== `${id}.md`) {
			continue;
		}
		const relative = path.relative(baseDir, path.join(entry.parentPath, entry.name));
		const segments = relative.split(path.sep);
		if (segments.some(segment => segment.startsWith('.'))) {
			continue;
		}
		const [top] = segments;
		if (top !== undefined && skipTopLevel.has(top)) {
			continue;
		}
		return segments.join('/');
	}

	return undefined;
}

/**
 * `[[carl]]` links to the wiki page when one exists, otherwise the corpus file
 * of that basename, otherwise plain text — a dangling wikilink should read as
 * prose rather than invite a click to a 404.
 */
async function resolveWikilinks(root, body) {
	const ids = new Set();
	for (const match of body.matchAll(WIKILINK())) {
		if (match[1] !== undefined) {
			ids.add(splitWikilink(match[1]).target);
		}
	}

	const targets = new Map();
	for (const id of ids) {
		const wikiHit = await findMarkdownByBasename(path.join(root, WIKI_DIR), id);
		if (wikiHit !== undefined) {
			targets.set(id, `/wiki/${wikiHit}`);
			continue;
		}
		const corpusHit = await findMarkdownByBasename(root, id, new Set([WIKI_DIR]));
		targets.set(id, corpusHit === undefined ? undefined : `/corpus/${corpusHit}`);
	}

	return body.replace(WIKILINK(), (_whole, raw) => {
		const {target, label} = splitWikilink(raw);
		const href = targets.get(target);
		// A dangling link still reads as prose, and reads as the *name* — falling
		// back to the slug would be a second, quieter regression.
		return href === undefined ? label : `[${label}](${href})`;
	});
}

async function renderMarkdownBody(root, raw) {
	return markdown.parse(await resolveWikilinks(root, splitFrontmatter(raw)), {
		async: false,
	});
}

const STYLE = `
* { box-sizing: border-box; }
body { margin: 0; background: #f6f4ef; color: #211c14;
	font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; }
header { border-bottom: 1px solid #ddd6c8; background: #efeade; padding: 0.75rem 1.5rem; }
header a { color: #6b4f2a; font-weight: 600; text-decoration: none; }
header a:hover { text-decoration: underline; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
h1, h2, h3 { line-height: 1.3; }
a { color: #6b4f2a; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	background: #efeade; border-radius: 4px; }
code { padding: 0.1em 0.35em; }
pre { padding: 1rem; overflow-x: auto; }
pre code { padding: 0; background: none; }
blockquote { margin: 1rem 0; padding: 0.25rem 1rem; border-left: 3px solid #ddd6c8; color: #55503f; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ddd6c8; padding: 0.4rem 0.6rem; text-align: left; }
`;

function renderPage(title, bodyHtml) {
	return [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeHtml(title)}</title>`,
		`<style>${STYLE}</style>`,
		'</head>',
		'<body>',
		'<header><nav><a href="/">&larr; wiki index</a></nav></header>',
		`<main>${bodyHtml}</main>`,
		'</body>',
		'</html>',
	].join('\n');
}

const NO_WIKI_BODY =
	'<h1>No wiki built yet</h1><p>Run <code>/wiki build</code> to generate one.</p>';

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function sendHtml(res, status, html) {
	res.writeHead(status, {'content-type': 'text/html; charset=utf-8'});
	res.end(html);
}

/**
 * Deliberately not `new URL(req.url).pathname`: the WHATWG parser collapses a
 * literal `..` on its own but leaves `%2e%2e%2f` alone, so the two spellings
 * would take different routes. Stripping the query and decoding by hand puts
 * both through the identical canonical-path check.
 */
function requestPathname(rawUrl) {
	const queryIndex = rawUrl.indexOf('?');
	return queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
}

async function serveVaultFile(root, res, baseDir, candidate) {
	const target = resolveWithinBase(baseDir, candidate);
	const raw = await readFile(target, 'utf8').catch(() => undefined);
	if (raw === undefined) {
		sendHtml(res, 404, renderPage('Not found', '<h1>404</h1><p>Nothing here.</p>'));
		return;
	}
	sendHtml(
		res,
		200,
		renderPage(path.basename(target, '.md'), await renderMarkdownBody(root, raw)),
	);
}

async function handleRequest(root, req, res) {
	let pathname;
	try {
		pathname = decodeURIComponent(requestPathname(req.url ?? '/'));
	} catch {
		sendHtml(res, 400, renderPage('Bad request', '<h1>400</h1><p>Malformed path.</p>'));
		return;
	}

	try {
		if (pathname === '/') {
			const raw = await readFile(path.join(root, WIKI_DIR, 'index.md'), 'utf8').catch(
				() => undefined,
			);
			sendHtml(
				res,
				200,
				renderPage(
					'Wiki',
					raw === undefined ? NO_WIKI_BODY : await renderMarkdownBody(root, raw),
				),
			);
		} else if (pathname.startsWith(WIKI_PREFIX)) {
			await serveVaultFile(
				root,
				res,
				path.join(root, WIKI_DIR),
				pathname.slice(WIKI_PREFIX.length),
			);
		} else if (pathname.startsWith(CORPUS_PREFIX)) {
			await serveVaultFile(root, res, root, pathname.slice(CORPUS_PREFIX.length));
		} else {
			sendHtml(res, 404, renderPage('Not found', '<h1>404</h1><p>Nothing here.</p>'));
		}
	} catch (error) {
		if (error instanceof ForbiddenPathError) {
			sendHtml(res, 403, renderPage('Forbidden', '<h1>403</h1><p>Not servable.</p>'));
		} else {
			const message = error instanceof Error ? error.message : String(error);
			sendHtml(
				res,
				500,
				renderPage('Error', `<h1>500</h1><p>${escapeHtml(message)}</p>`),
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

export function resolveHost(requested) {
	if (requested === undefined || requested === '') {
		return DEFAULT_HOST;
	}
	return ALL_INTERFACES.has(requested.toLowerCase()) ? '0.0.0.0' : requested;
}

/**
 * `http://0.0.0.0:7391` is not a usable link, so when bound to everything the
 * reported URL is the first real IPv4 this machine has — the address another
 * device on the network would actually type.
 */
function reachableAddress(host) {
	if (host !== '0.0.0.0') {
		return host;
	}
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === 'IPv4' && !entry.internal) {
				return entry.address;
			}
		}
	}
	return '127.0.0.1';
}

function listenOnce(server, port, host) {
	return new Promise((resolvePromise, reject) => {
		const onError = error => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.off('error', onError);
			resolvePromise();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(port, host);
	});
}

async function bind(server, requestedPort, host) {
	if (requestedPort === 0) {
		await listenOnce(server, 0, host);
		return server.address().port;
	}
	for (let offset = 0; offset < PORT_SCAN_ATTEMPTS; offset += 1) {
		try {
			await listenOnce(server, requestedPort + offset, host);
			return requestedPort + offset;
		} catch (error) {
			if (error?.code !== 'EADDRINUSE') {
				throw error;
			}
		}
	}
	throw new Error(
		`no free port in ${requestedPort}-${requestedPort + PORT_SCAN_ATTEMPTS - 1}`,
	);
}

export async function startServer(root, port = DEFAULT_PORT, requestedHost) {
	const host = resolveHost(requestedHost);
	const server = createServer((req, res) => {
		void handleRequest(root, req, res);
	});
	const bound = await bind(server, port, host);

	return {
		url: `http://${reachableAddress(host)}:${bound}`,
		port: bound,
		host,
		async close() {
			if (server.listening) {
				await new Promise((done, fail) => {
					server.close(error => (error ? fail(error) : done()));
					// `close` only stops new connections; an idle keep-alive socket
					// from a browser tab would hold the callback open otherwise.
					server.closeAllConnections();
				});
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Bootstrap: worker thread, or `node wiki/serve.mjs [port]`
// ---------------------------------------------------------------------------

/** The vault root is the parent of the `wiki/` directory this file sits in. */
function rootFromHere() {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

if (!isMainThread && workerData?.litfireServe === true) {
	const server = await startServer(
		workerData.root,
		workerData.port ?? DEFAULT_PORT,
		workerData.host,
	);
	// oxlint-disable-next-line unicorn/require-post-message-target-origin
	// This is worker_threads' parentPort, not window.postMessage — there is no
	// target origin to give it.
	parentPort.postMessage({
		ready: true,
		url: server.url,
		port: server.port,
		host: server.host,
	});
	parentPort.on('message', message => {
		if (message === 'stop') {
			void server.close().then(() => process.exit(0));
		}
	});
} else if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url)) {
	const port = Number.parseInt(process.argv[2] ?? '', 10);
	const server = await startServer(
		rootFromHere(),
		Number.isFinite(port) ? port : DEFAULT_PORT,
		process.argv[3],
	);
	process.stdout.write(
		`litfire wiki → ${server.url}${server.host === '0.0.0.0' ? ' (all interfaces)' : ''}\n`,
	);
}
