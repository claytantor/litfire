import {afterEach, describe, expect, it} from 'vitest';
import {extractFormulas} from '../source/system/formulas.js';
import {FormulaRunner, hashFormulas} from '../source/system/sandbox.js';

let runner: FormulaRunner | undefined;

afterEach(() => {
	runner?.dispose();
	runner = undefined;
});

// The exact blocks from §6.4 of the requirements.
const SPEC_MARKDOWN = [
	'```js id=xp-for-level',
	'(level) => level <= 10 ? 100 * level ** 2 : 150 * level ** 2;',
	'```',
	'',
	'```js id=max-hp',
	'({ constitution, level }) => 50 + constitution * 8 + level * 12;',
	'```',
].join('\n');

describe('extractFormulas', () => {
	it('pulls id-tagged js blocks from markdown', () => {
		const formulas = extractFormulas(SPEC_MARKDOWN);

		expect(formulas.map(f => f.id)).toEqual(['xp-for-level', 'max-hp']);
	});

	it('ignores js blocks with no id', () => {
		expect(extractFormulas('```js\n1 + 1\n```')).toHaveLength(0);
	});
});

describe('FormulaRunner', () => {
	it('evaluates the spec formulas', async () => {
		runner = await FormulaRunner.create(extractFormulas(SPEC_MARKDOWN));

		expect(await runner.call('xp-for-level', 5)).toBe(2500);
		expect(await runner.call('xp-for-level', 12)).toBe(21_600);
		expect(await runner.call('max-hp', {constitution: 10, level: 3})).toBe(166);
	});

	it('has no access to host escapes', async () => {
		runner = await FormulaRunner.create([
			{id: 'probe', source: '() => (typeof fetch) + (typeof process) + (typeof require)'},
		]);

		await expect(runner.call('probe')).rejects.toThrow(
			/returned undefinedundefinedundefined/,
		);
	});

	it('rejects nondeterministic globals', async () => {
		runner = await FormulaRunner.create([
			{id: 'rand', source: '() => Math.random()'},
			{id: 'now', source: '() => Date.now()'},
			{id: 'date', source: '() => new Date().getTime()'},
		]);

		await expect(runner.call('rand')).rejects.toThrow(/Math\.random is unavailable/);
		await expect(runner.call('now')).rejects.toThrow(/Date\.now is unavailable/);
		await expect(runner.call('date')).rejects.toThrow(/Date is unavailable/);
	});

	it('enforces a CPU timeout on a runaway formula', async () => {
		runner = await FormulaRunner.create([
			{id: 'spin', source: '() => { while (true) {} }'},
		]);

		await expect(runner.call('spin')).rejects.toThrow(/timed out/i);
	});

	it('collects compile errors instead of throwing', async () => {
		runner = await FormulaRunner.create([{id: 'broken', source: '=> => =>'}]);

		expect(runner.errors.map(e => e.id)).toEqual(['broken']);
		expect(runner.has('broken')).toBe(false);
	});

	it('rejects a non-numeric result', async () => {
		runner = await FormulaRunner.create([{id: 'str', source: '() => "nope"'}]);

		await expect(runner.call('str')).rejects.toThrow(/expected a number/);
	});
});

describe('hashFormulas', () => {
	it('is stable regardless of declaration order', () => {
		const a = [
			{id: 'x', source: '() => 1'},
			{id: 'y', source: '() => 2'},
		];
		const b = [
			{id: 'y', source: '() => 2'},
			{id: 'x', source: '() => 1'},
		];

		expect(hashFormulas(a)).toBe(hashFormulas(b));
	});

	it('changes when a formula body changes', () => {
		expect(hashFormulas([{id: 'x', source: '() => 1'}])).not.toBe(
			hashFormulas([{id: 'x', source: '() => 2'}]),
		);
	});
});
