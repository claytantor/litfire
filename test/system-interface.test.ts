import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {extractInterface, fieldsOf, renderInterface} from '../source/system/interface.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-interface-'));
	await scaffoldVault(root, 'arcane');
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function file(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), {recursive: true});
	await writeFile(target, contents, 'utf8');
}

const SCREEN = [
	'┌─ THE LATHE ──────────────┐',
	'│ {name}      TIER {level} │',
	'│ COHERENCE   {coherence}  │',
	'└──────────────────────────┘',
].join('\n');

async function vaultWithScreen(screen = SCREEN) {
	await file(
		`${VAULT.systems}/core.md`,
		[
			'---',
			'id: core',
			'name: Core',
			'stats:',
			'  - id: coherence',
			'    default: 3',
			'---',
			'',
			'```interface',
			screen,
			'```',
			'',
		].join('\n'),
	);
	await file(
		`${VAULT.characters}/carl.md`,
		'---\nid: carl\nsystem: core\nlevel: 4\nstats:\n  coherence: 7\n---\n\nHim.\n',
	);
	await rm(path.join(root, VAULT.systems, 'system-01.md'), {force: true});
	context = {
		root,
		project: await computeProject(root),
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	};
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
}

describe('reading the screen an author drew', () => {
	it('takes the block out of the system’s body', () => {
		expect(extractInterface('# Core\n\n```interface\nHP {hp}\n```\n')).toBe('HP {hp}');
	});

	it('keeps the drawing exactly, including the spaces', () => {
		// The box is the author's; a renderer that trimmed it would break the
		// alignment they lined up by hand.
		const drawn = extractInterface(`x\n\n\`\`\`interface\n${SCREEN}\n\`\`\`\n`);
		expect(drawn).toBe(SCREEN);
	});

	it('finds every field it asks for, once each', () => {
		expect(fieldsOf('{a} {b} {a}')).toEqual(['a', 'b']);
	});

	it('is undefined when a system draws nothing', () => {
		expect(extractInterface('# Core\n\nJust prose.\n')).toBeUndefined();
	});
});

describe('filling it in', () => {
	const carl = {
		id: 'carl',
		system: 'core',
		level: 4,
		xp: 0,
		stats: {coherence: 7},
		skills: ['first-ability'],
		items: {},
		artifacts: [],
	};

	it('substitutes stats and the built-in fields', () => {
		const out = renderInterface('{name} L{level} C{coherence} [{skills}]', carl);
		expect(out).toBe('carl L4 C7 [first-ability]');
	});

	it('leaves a placeholder standing when nothing is behind it', () => {
		// Blanking it would be indistinguishable from a zero. The author can see
		// what is missing, and the checks say the same thing in words.
		expect(renderInterface('{coherence} {nowhere}', carl)).toBe('7 {nowhere}');
	});

	it('shows an em dash rather than nothing for an empty skill list', () => {
		expect(renderInterface('{skills}', {...carl, skills: []})).toBe('—');
	});
});

describe('the interface is a specification', () => {
	it('reports a field the system does not declare', async () => {
		await vaultWithScreen('{coherence} {resonance}');
		const finding = context.project!.questions.find(
			q => q.kind === 'interface_field_unknown',
		);

		expect(finding?.detail).toContain('{resonance}');
		expect(finding?.detail).toContain('declares no such stat');
	});

	it('says nothing about the built-in fields', async () => {
		await vaultWithScreen('{name} {level} {xp} {skills}');

		expect(
			context.project!.questions.filter(q => q.kind === 'interface_field_unknown'),
		).toEqual([]);
	});
});

describe('the scene, as its cast sees it', () => {
	it('draws every character through their own system', async () => {
		await vaultWithScreen();
		await file(
			`${VAULT.situations}/sit-900.md`,
			'---\nid: sit-900\ntitle: The Room\narc: arc-01\norder: 5\ncharacters:\n  - carl\n---\n\nProse.\n',
		);
		context = {...context, project: await computeProject(root)};

		const output = said(await run('/situation sit-900 sheet'));

		expect(output).toContain('THE LATHE');
		expect(output).toContain('TIER 4');
		expect(output).toContain('COHERENCE   7');
	});

	it('falls back to the profile’s template when a system draws nothing', async () => {
		// A vault gets something useful before anyone has drawn anything.
		context = {
			root,
			project: await computeProject(root),
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		};
		const output = said(await run('/situation sit-001 sheet'));

		expect(output).not.toContain('nobody in this scene');
		expect(output).toContain('protagonist');
	});

	it('asks for an id rather than guessing', async () => {
		await vaultWithScreen();
		expect(said(await run('/situation sheet'))).toContain('usage:');
	});
});
