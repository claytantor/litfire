import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	currentServe,
	startWikiServe,
	stopWikiServe,
	type WikiServe,
} from '../source/wiki/host.js';

/**
 * These exercise `wiki/serve.mjs` running in a worker — the same file an author
 * can run with `node wiki/serve.mjs`, not a private in-process copy. There is
 * only one server implementation and this is it.
 */

let root = '';
let servers: WikiServe[] = [];

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-wiki-'));
	servers = [];
});

afterEach(async () => {
	await Promise.all(servers.map(server => server.close()));
	await rm(root, {recursive: true, force: true});
});

async function boot(options?: {
	readonly port?: number;
	readonly host?: string;
}): Promise<WikiServe> {
	const server = await startWikiServe(root, options ?? {port: 0});
	servers.push(server);
	return server;
}

async function write(relativePath: string, contents: string): Promise<void> {
	const file = path.join(root, relativePath);
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, contents, 'utf8');
}

/**
 * `fetch` builds its request through the WHATWG `URL` parser, which
 * collapses a literal `..` segment before the request ever leaves the
 * process — so it cannot exercise the server's own traversal guard for the
 * unencoded form. A raw `http.request` with an explicit `path` sends the
 * string verbatim, the way a non-normalizing client (or an attacker) would.
 */
function rawGet(
	server: WikiServe,
	rawPath: string,
): Promise<{status: number; body: string}> {
	return new Promise((resolvePromise, reject) => {
		const req = request(
			{host: '127.0.0.1', port: server.port, path: rawPath, method: 'GET'},
			res => {
				let body = '';
				res.on('data', (chunk: Buffer) => {
					body += chunk.toString('utf8');
				});
				res.on('end', () => resolvePromise({status: res.statusCode ?? 0, body}));
			},
		);
		req.on('error', reject);
		req.end();
	});
}

describe('binding', () => {
	it('binds to 127.0.0.1 and reports it in the url', async () => {
		const server = await boot();

		expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
		expect(server.url).not.toContain('0.0.0.0');
		expect(server.url).not.toContain('localhost');
	});

	it('falls through to the next port when the requested one is taken', async () => {
		const first = await boot({port: 0});
		const second = await boot({port: first.port});

		expect(second.port).toBe(first.port + 1);
	});
});

describe('the module singleton', () => {
	it('tracks the running server until it is stopped', async () => {
		expect(currentServe()).toBeUndefined();

		const server = await startWikiServe(root, {port: 0});
		expect(currentServe()).toBe(server);

		await stopWikiServe();
		expect(currentServe()).toBeUndefined();
	});
});

describe('GET /', () => {
	it('renders the wiki index when one has been built', async () => {
		await write('wiki/index.md', '---\ngenerated: true\n---\n\n# Wiki\n\nHello wiki.\n');
		const server = await boot();

		const res = await fetch(`${server.url}/`);
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(html).toContain('Hello wiki.');
		expect(html).not.toContain('generated: true');
	});

	it('shows a friendly message when no wiki has been built yet', async () => {
		const server = await boot();

		const res = await fetch(`${server.url}/`);
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(html).toContain('/wiki build');
	});
});

describe('rendering', () => {
	it('renders a wiki page with frontmatter stripped', async () => {
		await write(
			'wiki/characters/carl.md',
			'---\nid: carl\n---\n\n# Carl\n\nA donut collector.\n',
		);
		const server = await boot();

		const res = await fetch(`${server.url}/wiki/characters/carl.md`);
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(html).toContain('A donut collector.');
		expect(html).not.toContain('id: carl');
	});

	it('renders a corpus page from outside wiki/', async () => {
		await write(
			'situations/sit-001.md',
			'---\nid: sit-001\n---\n\n# Sit 001\n\nCarl finds a donut.\n',
		);
		const server = await boot();

		const res = await fetch(`${server.url}/corpus/situations/sit-001.md`);
		const html = await res.text();

		expect(res.status).toBe(200);
		expect(html).toContain('Carl finds a donut.');
		expect(html).not.toContain('id: sit-001');
	});
});

describe('wikilinks', () => {
	it('links to the wiki page when one exists', async () => {
		await write('wiki/characters/carl.md', '# Carl\n');
		await write('wiki/index.md', 'See [[carl]] for details.\n');
		const server = await boot();

		const html = await (await fetch(`${server.url}/`)).text();

		expect(html).toContain('<a href="/wiki/characters/carl.md">carl</a>');
	});

	it('falls back to the corpus file when no wiki page exists', async () => {
		await write('characters/carl.md', '# Carl\n');
		await write('wiki/index.md', 'See [[carl]] for details.\n');
		const server = await boot();

		const html = await (await fetch(`${server.url}/`)).text();

		expect(html).toContain('<a href="/corpus/characters/carl.md">carl</a>');
	});

	it('resolves the alias form, linking the target and showing the name', async () => {
		// The index writes `[[the-lathe|The Lathe]]` so a reader sees the name
		// rather than the slug. Resolving the whole capture as an id finds no
		// file, which silently turned every index link into plain text.
		await write('wiki/systems/the-lathe.md', '# The Lathe\n');
		await write('wiki/index.md', '- [[the-lathe|The Lathe]] — 5 stats\n');
		const server = await boot();

		const html = await (await fetch(`${server.url}/`)).text();

		expect(html).toContain('<a href="/wiki/systems/the-lathe.md">The Lathe</a>');
		expect(html).not.toContain('the-lathe|The Lathe');
	});

	it('falls back to the corpus for an aliased link too', async () => {
		await write('factions/the-hand-of-juno.md', '# The Hand of Juno\n');
		await write('wiki/index.md', '[[the-hand-of-juno|The Hand of Juno]]\n');
		const server = await boot();

		const html = await (await fetch(`${server.url}/`)).text();

		expect(html).toContain(
			'<a href="/corpus/factions/the-hand-of-juno.md">The Hand of Juno</a>',
		);
	});

	it('shows the name, not the slug, when an aliased link dangles', async () => {
		await write('wiki/index.md', 'See [[nowhere|The Missing Thing]] for details.\n');
		const server = await boot();

		const html = await (await fetch(`${server.url}/`)).text();

		expect(html).toContain('See The Missing Thing for details.');
		expect(html).not.toContain('nowhere');
	});

	it('renders a link to a nonexistent page as plain text', async () => {
		await write('wiki/index.md', 'See [[nobody]] for details.\n');
		const server = await boot();

		const html = await (await fetch(`${server.url}/`)).text();

		expect(html).toContain('See nobody for details.');
		expect(html).not.toContain('href="/wiki/nobody');
		expect(html).not.toContain('href="/corpus/nobody');
	});
});

describe('security', () => {
	it('refuses a literal traversal attempt', async () => {
		const server = await boot();

		const {status, body} = await rawGet(server, '/corpus/../../../etc/passwd');

		expect(status).toBe(403);
		expect(body).not.toContain('root:');
	});

	it('refuses a URL-encoded traversal attempt', async () => {
		const server = await boot();

		const {status, body} = await rawGet(
			server,
			'/corpus/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
		);

		expect(status).toBe(403);
		expect(body).not.toContain('root:');
	});

	it('refuses a non-markdown path', async () => {
		await write('system/stats.txt', 'not markdown');
		const server = await boot();

		const res = await fetch(`${server.url}/corpus/system/stats.txt`);

		expect(res.status).toBe(403);
	});

	it('escapes raw HTML instead of letting it survive as a tag', async () => {
		await write(
			'wiki/index.md',
			'Before.\n\n<script>window.pwned = true;</script>\n\nAfter.\n',
		);
		const server = await boot();

		const html = await (await fetch(`${server.url}/`)).text();

		expect(html).not.toContain('<script>window.pwned');
		expect(html).toContain('&lt;script&gt;');
	});
});

describe('anything else', () => {
	it('returns 404 for an unknown route', async () => {
		const server = await boot();

		const res = await fetch(`${server.url}/nope`);

		expect(res.status).toBe(404);
	});

	it('returns 404 for a route file that does not exist', async () => {
		const server = await boot();

		const res = await fetch(`${server.url}/corpus/characters/nobody.md`);

		expect(res.status).toBe(404);
	});
});

describe('the bind address', () => {
	it('stays on loopback by default', async () => {
		const server = await boot();

		expect(server.host).toBe('127.0.0.1');
		expect(server.url).toContain('127.0.0.1');
	});

	/**
	 * Opt-in only. Binding every interface changes who can read an unpublished
	 * manuscript, so it happens when the author asks and never by default.
	 */
	it('binds every interface when asked, by word or by address', async () => {
		for (const host of ['lan', 'all', 'any', '0.0.0.0']) {
			const server = await boot({port: 0, host});
			expect(server.host).toBe('0.0.0.0');
		}
	});

	it('is case-insensitive about the word', async () => {
		expect((await boot({port: 0, host: 'LAN'})).host).toBe('0.0.0.0');
	});

	/** `http://0.0.0.0:7391` is not a usable link from another device. */
	it('reports an address something else could actually reach', async () => {
		const server = await boot({port: 0, host: 'lan'});

		expect(server.url).not.toContain('0.0.0.0');
		expect(await (await fetch(`${server.url}/`)).status).toBe(200);
	});

	it('accepts an explicit interface address', async () => {
		const server = await boot({port: 0, host: '127.0.0.1'});

		expect(server.host).toBe('127.0.0.1');
	});
});
