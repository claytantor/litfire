import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {render} from 'ink-testing-library';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {App} from '../source/app.js';
import {saveProvider} from '../source/vault/config.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let litfireHome = '';
let savedHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-confirm-'));
	await scaffoldVault(root, 'arcane');
	await saveProvider(root, {id: 'openai', model: 'gpt-4o'});
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

const flush = async (ms = 150) => {
	await new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Polls rather than sleeping a fixed interval.
 *
 * Ink renders on its own schedule and these tests share a machine with fifty
 * other files, so any single sleep long enough to be reliable under parallel
 * load is far longer than the render actually takes. Waiting for the condition
 * is both faster and not a coin flip.
 */
async function until(
	predicate: () => boolean,
	what: string,
	timeout = 4000,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function type(stdin: {write: (data: string) => void}, value: string) {
	stdin.write(value);
	await flush(20);
	stdin.write('\r');
	await flush();
}

const mount = () => render(<App root={root} version="1.2.3" watch={false} />);

/**
 * `/questions theme` on a scaffolded vault has nothing to ask about, so it is
 * the one command that reliably reaches the prompt without a model call.
 */
describe('a command that asks before it acts', () => {
	it('shows the question and the default', async () => {
		const {stdin, lastFrame} = mount();
		await flush();
		await type(stdin, '/questions theme');
		await until(
			() => (lastFrame() ?? '').includes('begin interview anyway?'),
			'the prompt',
		);

		expect(lastFrame() ?? '').toContain('y/N');
	});

	it('declines on anything that is not y, return included', async () => {
		const {stdin, frames, lastFrame} = mount();
		await flush();
		await type(stdin, '/questions theme');
		await until(
			() => (lastFrame() ?? '').includes('begin interview anyway?'),
			'the prompt',
		);

		stdin.write('\r');
		await until(() => frames.join('\n').includes('nothing to do'), 'the decline');

		expect(frames.join('\n')).toContain('nothing to do');
		// The prompt is gone, so the composer has the keyboard back.
		expect(lastFrame() ?? '').not.toContain('begin interview anyway?');
	});

	it('declines on n', async () => {
		const {stdin, frames, lastFrame} = mount();
		await flush();
		await type(stdin, '/questions theme');
		await until(
			() => (lastFrame() ?? '').includes('begin interview anyway?'),
			'the prompt',
		);

		stdin.write('n');
		await until(() => frames.join('\n').includes('nothing to do'), 'the decline');

		expect(frames.join('\n')).toContain('nothing to do');
	});

	/**
	 * The reason this intercepts every key rather than only y and n: a stray
	 * character must not fall through into the draft behind a question the
	 * author has not answered yet.
	 */
	it('swallows a stray key instead of typing it into the draft', async () => {
		const {stdin, lastFrame} = mount();
		await flush();
		await type(stdin, '/questions theme');
		await until(
			() => (lastFrame() ?? '').includes('begin interview anyway?'),
			'the prompt',
		);

		stdin.write('k');
		await until(
			() => !(lastFrame() ?? '').includes('begin interview anyway?'),
			'the prompt to clear',
		);

		const frame = lastFrame() ?? '';
		expect(frame).not.toContain('begin interview anyway?');
		expect(frame).not.toMatch(/›\s*k/);
	});

	it('acts on y', async () => {
		const {stdin, frames, lastFrame} = mount();
		await flush();
		await type(stdin, '/questions theme');
		await until(
			() => (lastFrame() ?? '').includes('begin interview anyway?'),
			'the prompt',
		);

		stdin.write('y');
		await until(
			() => !(lastFrame() ?? '').includes('begin interview anyway?'),
			'the prompt to clear',
		);

		const output = frames.join('\n');
		// The interview needs a real provider, so it fails to open — which is
		// itself the proof that saying yes dispatched `proceed` rather than
		// declining. What must not appear is the decline.
		expect(output).not.toContain('nothing to do');
	});
});
