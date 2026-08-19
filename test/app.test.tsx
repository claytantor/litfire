import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {render} from 'ink-testing-library';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {App} from '../source/app.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let litfireHome = '';
let savedHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-tui-'));
	// Mounting App records the project it opened. Without this the suite would
	// write the author's real ~/.litfire and point `litfire` at a temp directory
	// that this same afterEach then deletes.
	litfireHome = await mkdtemp(path.join(tmpdir(), 'litfire-home-'));
	savedHome = process.env['LITFIRE_HOME'];
	process.env['LITFIRE_HOME'] = litfireHome;
});

afterEach(async () => {
	if (savedHome === undefined) {
		delete process.env['LITFIRE_HOME'];
	} else {
		process.env['LITFIRE_HOME'] = savedHome;
	}
	await rm(root, {recursive: true, force: true});
	await rm(litfireHome, {recursive: true, force: true});
});

const flush = async (ms = 120) => {
	await new Promise(resolve => setTimeout(resolve, ms));
};

/** Ink needs a tick between the text and the Enter, or the submit is lost. */
async function type(stdin: {write: (data: string) => void}, value: string) {
	stdin.write(value);
	await flush(20);
	stdin.write('\r');
	await flush();
}

// `watch={false}` keeps chokidar out of the test process.
const mount = () => render(<App root={root} version="1.2.3" watch={false} />);

describe('App shell', () => {
	it('prints the banner and the footer', async () => {
		const {lastFrame} = mount();
		await flush();

		const frame = lastFrame() ?? '';
		expect(frame).toContain('litfire v1.2.3');
		expect(frame).toContain('unplaced');
	});

	it('reports an unknown command without crashing', async () => {
		const {stdin, frames} = mount();
		await flush();
		await type(stdin, '/nonsense');

		expect(frames.join('\n')).toContain("unknown command 'nonsense'");
	});

	it('/help lists the commands', async () => {
		const {stdin, frames} = mount();
		await flush();
		await type(stdin, '/help');

		const all = frames.join('\n');
		expect(all).toContain('/sheet');
		expect(all).toContain('/pacing');
		expect(all).toContain('/questions');
	});

	it('/init asks what kind of world this is before scaffolding', async () => {
		const {stdin, frames} = mount();
		await flush();
		await type(stdin, '/init');
		await flush(300);

		const all = frames.join('\n');
		expect(all).toContain('what kind of world');
		// `base` stays a first-class option — declining to pick a genre is a
		// supported path, not a fallthrough.
		expect(all).toContain('base');
		expect(all).toContain('arcane');
		expect(all).toContain('technological');
	});

	it('/init <idiom> scaffolds the vault', async () => {
		const {stdin, frames} = mount();
		await flush();
		await type(stdin, '/init technological');
		await flush(500);

		const all = frames.join('\n');
		expect(all).toContain('created');
		expect(all).toContain('idiom: technological');
	});

	it('/sheet renders a character after a vault exists', async () => {
		await scaffoldVault(root);
		const {stdin, frames} = mount();
		await flush(300);
		await type(stdin, '/sheet protagonist');
		await flush(200);

		const all = frames.join('\n');
		expect(all).toContain('protagonist');
		expect(all).toContain('level');
	});

	it('/questions reports the queue', async () => {
		await scaffoldVault(root);
		const {stdin, frames} = mount();
		await flush(300);
		await type(stdin, '/questions');
		await flush(200);

		// The seeded vault has an arc milestone carl cannot hit without consent,
		// so either outcome is valid — what matters is that it renders.
		expect(frames.join('\n')).toMatch(/open questions|no open questions/);
	});

	it('/timeline shows placed situations and the inbox', async () => {
		await scaffoldVault(root);
		const {stdin, frames} = mount();
		await flush(300);
		await type(stdin, '/timeline');
		await flush(200);

		expect(frames.join('\n')).toContain('sit-001');
	});
});
