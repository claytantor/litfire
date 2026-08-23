import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {systemSchema} from '../source/domain/schema.js';
import {readingOf, renderInterface} from '../source/system/interface.js';
import {
	buildInterpretationGeneration,
	statsWantingBands,
} from '../source/system/generate.js';
import {saveProvider} from '../source/vault/config.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-reads-'));
	await scaffoldVault(root, 'arcane');
	await saveProvider(root, {id: 'openai', model: 'gpt-4o'});
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function file(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), {recursive: true});
	await writeFile(target, contents, 'utf8');
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

const run = async (line: string) => {
	const [head = '', ...args] = line.trim().split(/\s+/);
	return findCommand(head.replace(/^\//, ''))!.run(args, context);
};

const banded = systemSchema.parse({
	id: 'core',
	stats: [
		{
			id: 'coherence',
			bands: [
				{upto: 20, reads: 'Fragmenting'},
				{upto: 60, reads: 'Unsettled'},
				{reads: 'Laminar'},
			],
		},
		{id: 'flux'},
	],
});

const carl = {
	id: 'carl',
	system: 'core',
	level: 1,
	xp: 0,
	stats: {coherence: 31, flux: 4},
	skills: [],
	items: {},
	artifacts: [],
};

/**
 * A system that judges is most of what makes one worth having. The screen says
 * 31; the world says "Unsettled", and the second is what a reader remembers.
 */
describe('what a system makes of a number', () => {
	it('takes the first band the value fits under', () => {
		expect(readingOf(banded, 'coherence', 5)).toBe('Fragmenting');
		expect(readingOf(banded, 'coherence', 31)).toBe('Unsettled');
		expect(readingOf(banded, 'coherence', 900)).toBe('Laminar');
	});

	it('treats upto as inclusive, so a boundary belongs to the band below', () => {
		expect(readingOf(banded, 'coherence', 20)).toBe('Fragmenting');
		expect(readingOf(banded, 'coherence', 21)).toBe('Unsettled');
	});

	it('says nothing for a stat nobody has banded', () => {
		// Different from making nothing of it: the system has not been asked.
		expect(readingOf(banded, 'flux', 4)).toBeUndefined();
	});

	it('renders inline, beside the number', () => {
		expect(
			renderInterface('C {coherence} {coherence-interpretation}', carl, {system: banded}),
		).toBe('C 31 Unsettled');
	});

	it('leaves the placeholder standing when there are no bands', () => {
		expect(renderInterface('{flux-interpretation}', carl, {system: banded})).toBe(
			'{flux-interpretation}',
		);
	});

	/**
	 * The property that makes bands the right shape rather than a live call: a
	 * reader who sees 31 called "Fragmenting" in one chapter and "Unsettled" in
	 * another, with the number unchanged, has caught a mistake nobody made.
	 */
	it('reads the same way every time it is rendered', () => {
		const once = renderInterface('{coherence-interpretation}', carl, {system: banded});
		const twice = renderInterface('{coherence-interpretation}', carl, {system: banded});
		expect(once).toBe(twice);
	});
});

describe('which stats want a reading', () => {
	it('is decided by the screen, not by every stat declared', () => {
		// A reading nobody shows is a phrase written for nobody.
		expect(statsWantingBands(banded, '{coherence} {flux} {flux-interpretation}')).toEqual(
			['flux'],
		);
	});

	it('skips a stat that already has bands', () => {
		expect(statsWantingBands(banded, '{coherence-interpretation}')).toEqual([]);
	});

	it('is empty when the system draws no screen', () => {
		expect(statsWantingBands(banded, undefined)).toEqual([]);
	});
});

describe('the pass that asks', () => {
	async function systemWithScreen() {
		await rm(path.join(root, VAULT.systems, 'system-01.md'), {force: true});
		await file(
			`${VAULT.systems}/core.md`,
			[
				'---',
				'id: core',
				'name: Core',
				'stats:',
				'  - id: coherence',
				'---',
				'',
				'The Sky reports what it sees, and never explains itself.',
				'',
				'```interface',
				'C {coherence} {coherence-interpretation}',
				'```',
				'',
			].join('\n'),
		);
		await file('raw/systems/core.md', 'The Sky reports what it sees.\n');
		context = {
			root,
			project: await computeProject(root),
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		};
	}

	it('tells the model to be the system, not to describe it', async () => {
		await systemWithScreen();
		const {instruction} = await buildInterpretationGeneration(
			root,
			context.project!,
			context.project!.vault.systems[0]!,
		);

		expect(instruction).toContain('You are the character system');
		expect(instruction).toContain('Not an assistant describing');
		expect(instruction).toContain('Speak as that system speaks');
	});

	it('gives it the system’s own words as the only guide to its voice', async () => {
		await systemWithScreen();
		const {context: given} = await buildInterpretationGeneration(
			root,
			context.project!,
			context.project!.vault.systems[0]!,
		);

		expect(given).toContain('The Sky reports what it sees');
		expect(given).toContain('coherence');
	});

	it('asks for a state rather than a verdict on the person', async () => {
		await systemWithScreen();
		const {instruction} = await buildInterpretationGeneration(
			root,
			context.project!,
			context.project!.vault.systems[0]!,
		);

		expect(instruction).toContain('"Fragmenting" rather than');
		expect(instruction).toContain('A system reports what it observes');
	});

	it('proposes into the raw note, like every other generated thing', async () => {
		await systemWithScreen();
		const {note} = await buildInterpretationGeneration(
			root,
			context.project!,
			context.project!.vault.systems[0]!,
		);

		expect(note).toBe('raw/systems/core.md');
	});

	it('is reachable, and names what it will ask about', async () => {
		await systemWithScreen();
		const result = await run('/system core generate interpretations');

		expect(result.generateStats).toEqual({system: 'core', what: 'interpretations'});
		expect(said(result)).toContain('how it reads coherence');
	});

	it('says so rather than spending anything when every reading exists', async () => {
		await systemWithScreen();
		await file(
			`${VAULT.systems}/core.md`,
			[
				'---',
				'id: core',
				'stats:',
				'  - id: coherence',
				'    bands:',
				'      - upto: 20',
				'        reads: Fragmenting',
				'      - reads: Laminar',
				'---',
				'',
				'```interface',
				'C {coherence} {coherence-interpretation}',
				'```',
				'',
			].join('\n'),
		);
		context = {...context, project: await computeProject(root)};

		const result = await run('/system core generate interpretations');

		expect(result.generateStats).toBeUndefined();
		expect(said(result)).toContain('already written');
	});
});

describe('a screen asking for a reading nobody wrote', () => {
	it('is reported as unread, not as a missing stat', async () => {
		await rm(path.join(root, VAULT.systems, 'system-01.md'), {force: true});
		await file(
			`${VAULT.systems}/core.md`,
			'---\nid: core\nstats:\n  - id: coherence\n---\n\n```interface\n{coherence-interpretation}\n```\n',
		);
		const project = await computeProject(root);

		const finding = project.questions.find(q => q.kind === 'stat_unread');
		expect(finding?.detail).toContain('generate interpretations');
		expect(project.questions.filter(q => q.kind === 'interface_field_unknown')).toEqual(
			[],
		);
	});
});
