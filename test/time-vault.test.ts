import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {findCommand} from '../source/commands/registry.js';
import type {CommandContext} from '../source/commands/types.js';
import {computeProject} from '../source/core/project.js';
import {resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';
import {calendarFor} from '../source/time/binding.js';
import {buildWiki} from '../source/wiki/index.js';

let root = '';
let context: CommandContext;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-time-'));
	await scaffoldVault(root, 'arcane');
	context = {
		root,
		project: await computeProject(root),
		activeCharacter: undefined,
		setActiveCharacter: () => {},
		consentFormulas: () => {},
	};
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function refresh(consented?: string) {
	context = {
		...context,
		project: await computeProject(
			root,
			consented === undefined ? {} : {consentedFormulaHash: consented},
		),
	};
}

async function run(line: string) {
	const [head = '', ...args] = line.trim().split(/\s+/);
	const result = await findCommand(head.replace(/^\//, ''))!.run(args, context);
	if (result.dirty) {
		await refresh();
	}
	return result;
}

const said = (r: {lines: readonly {text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

async function moment(id: string, at: string) {
	await mkdir(resolve(root, VAULT.moments), {recursive: true});
	await writeFile(
		resolve(root, VAULT.moments, `${id}.md`),
		`---\nid: ${id}\nat: ${at}\n---\n\n# ${id}\n`,
		'utf8',
	);
	await refresh();
}

describe('the clock survives the round trip to disk', () => {
	it('reads a deep-time instant back exactly, digit for digit', async () => {
		// Not a round number: a double would return ...124.
		await moment('substrate-patch', '-26174880000000123');

		expect(context.project!.vault.moments[0]?.at).toBe(-26_174_880_000_000_123n);
		expect(context.project!.vault.issues).toEqual([]);
	});

	it('reaches a trillion years back without complaint', async () => {
		await moment('the-first-light', '-31557600000000000000');

		expect(context.project!.vault.moments[0]?.at).toBe(-31_557_600_000_000_000_000n);
		expect(context.project!.vault.issues).toEqual([]);
	});

	it('reports an instant past the supported range instead of loading it', async () => {
		// Isolate the out-of-range moment: the scaffold's we-001/we-002 are valid
		// and would otherwise still load, making the moments list non-empty.
		await rm(resolve(root, VAULT.moments, 'we-001.md'), {force: true});
		await rm(resolve(root, VAULT.moments, 'we-002.md'), {force: true});
		await moment('too-far', '-31557600000000000001');

		expect(context.project!.vault.issues).toHaveLength(1);
		expect(context.project!.vault.moments).toHaveLength(0);
	});

	it('leaves every other integer field a plain number', async () => {
		// The widening is exactly as broad as the clock, and no broader.
		const character = context.project!.vault.characters[0];
		expect(character === undefined || typeof character.level === 'number').toBe(true);
		const arc = context.project!.vault.arcs[0];
		expect(arc === undefined || typeof arc.order === 'number').toBe(true);
	});

	it('orders deep-time moments by the clock, not by rounding', async () => {
		await moment('later', '-26174880000000000');
		await moment('earlier', '-26174880000000001');

		const order = context.project!.replay.sequence.map(step => step.id);
		expect(order.indexOf('earlier')).toBeLessThan(order.indexOf('later'));
	});
});

describe('/time', () => {
	it('reads as seconds until something says otherwise', async () => {
		await moment('the-breach', '0');
		const shown = said(await run('/time'));

		expect(shown).toContain('Seconds from origin');
		expect(shown).toContain('the-breach');
	});

	it('binds Earth/Sol time and reads the moments back as dates', async () => {
		await moment('the-breach', '0');
		await moment('a-day-later', '86400');

		expect(
			said(await run('/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles')),
		).toContain('gregorian');

		const shown = said(await run('/time'));
		expect(shown).toContain('Gregorian (America/Los_Angeles)');
		expect(shown).toContain('2031-08-15 19:33:00');
		expect(shown).toContain('2031-08-16 19:33:00');
	});

	it('refuses an epoch that is not an instant, and changes nothing', async () => {
		expect(said(await run('/time gregorian sometime'))).toContain('ISO 8601');
		expect(context.project!.vault.time).toBeUndefined();
	});

	it('names what second zero is', async () => {
		await run('/time origin The Substrate Patch');
		expect(context.project!.vault.time?.origin).toBe('The Substrate Patch');
		expect(said(await run('/time'))).toContain('The Substrate Patch');
	});

	it('says a date is beyond Gregorian rather than inventing one', async () => {
		await moment('the-first-light', '-31557600000000000000');
		await run('/time gregorian 2031-08-15T19:33:00-07:00');

		expect(said(await run('/time'))).toContain('beyond this calendar');
	});
});

describe('/time at', () => {
	it('converts a date to the seconds a moment stores', async () => {
		await run('/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles');

		const shown = said(await run('/time at 2031-08-16 19:33:00'));
		// Bare and unpunctuated, because it is about to be pasted into frontmatter.
		expect(shown).toContain('at: 86400');
		expect(shown).toContain('2031-08-16 19:33:00');
	});

	it('converts back the other way when given seconds', async () => {
		await run('/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles');

		const shown = said(await run('/time at 86400'));
		expect(shown).toContain('at: 86400');
		expect(shown).toContain('2031-08-16 19:33:00');
	});

	it('accepts grouped digits, since that is how /time prints them', async () => {
		expect(said(await run('/time at -26,174,880,000,000,123'))).toContain(
			'at: -26174880000000123',
		);
	});

	it('round-trips the date that would not load as a moment', async () => {
		// The real case: a vault holding `at: "2036-08-15 02:30:00"` fails to
		// load, and this is what turns it into something that does.
		await run('/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles');

		const converted = said(await run('/time at 2036-08-15 02:30:00'));
		const seconds = /at: (-?\d+)/.exec(converted)?.[1];
		expect(seconds).toBeDefined();

		await moment('inannas-first-memory', seconds!);
		expect(context.project!.vault.issues).toEqual([]);
		expect(said(await run('/time'))).toContain('2036-08-15 02:30:00');
	});

	it('says what it wanted when the date is unreadable', async () => {
		await run('/time gregorian 2031-08-15T19:33:00-07:00');
		const shown = said(await run('/time at last Tuesday'));

		expect(shown).toContain('cannot read');
		expect(shown).toContain('try 2036-08-15');
	});

	it('names the missing calendar when nothing is bound', async () => {
		const shown = said(await run('/time at 2036-08-15 02:30:00'));

		expect(shown).toContain('no calendar is bound');
		expect(shown).toContain('/time gregorian <epoch> [zone]');
	});

	it('nudges from /time itself, not only when a date is refused', async () => {
		await run('/time origin Inanna’s Birthday');
		const shown = said(await run('/time'));

		expect(shown).toContain('no calendar bound');
		expect(shown).toContain('/time gregorian');
	});

	it('asks for something to convert when given nothing', async () => {
		expect(said(await run('/time at'))).toContain('usage:');
	});

	it('reads seconds as themselves when no calendar is bound', async () => {
		const shown = said(await run('/time at 86400'));
		expect(shown).toContain('at: 86400');
		expect(shown).toContain('86,400s');
		expect(shown).toContain('1d');
	});
});

describe('a calendar the author wrote', () => {
	/** Ten months of thirty-two days — nothing Gregorian can express. */
	const CALENDAR = `
\`\`\`js id=calendar
(seconds) => {
  const DAY = 86400n;
  const YEAR = DAY * 320n;
  const year = seconds / YEAR;
  const day = (seconds % YEAR) / DAY;
  return \`Year \${year}, day \${day + 1n}\`;
}
\`\`\`
`;

	async function withCustomCalendar() {
		await writeFile(resolve(root, VAULT.formulas), `# Formulas\n${CALENDAR}`, 'utf8');
		await writeFile(
			resolve(root, VAULT.time),
			'---\ncalendar: custom\norigin: The Bootstrapping\n---\n',
			'utf8',
		);
		await refresh();
		// Formulas are code, so nothing runs until the author consents by hash.
		await refresh(context.project!.formulaHash);
	}

	it('formats instants through the sandboxed formula', async () => {
		await moment('the-breach', '0');
		await moment('much-later', String(86_400 * 320 * 3 + 86_400 * 5));
		await withCustomCalendar();

		const {calendar, note} = calendarFor(context.project!.vault.time, {
			formatted: context.project!.calendarText,
		});

		expect(note).toBeUndefined();
		expect(calendar.format(0n)).toBe('Year 0, day 1');
		expect(calendar.format(BigInt(86_400 * 320 * 3 + 86_400 * 5))).toBe('Year 3, day 6');
	});

	it('receives the instant as a BigInt, at full precision', async () => {
		// A double would round this; the formula returns the year it computed
		// from the exact value, so a wrong year here means precision was lost
		// crossing into the isolate.
		await moment('deep', '-26174880000000123');
		await withCustomCalendar();

		const {calendar} = calendarFor(context.project!.vault.time, {
			formatted: context.project!.calendarText,
		});
		const expected = -26_174_880_000_000_123n / (86_400n * 320n);
		expect(calendar.format(-26_174_880_000_000_123n)).toBe(
			`Year ${expected}, day ${(-26_174_880_000_000_123n % (86_400n * 320n)) / 86_400n + 1n}`,
		);
	});

	it('says a calendar formula cannot read dates back', async () => {
		await moment('the-breach', '0');
		await withCustomCalendar();

		const shown = said(await run('/time at Year 3, day 6'));
		expect(shown).toContain('cannot read them back');
		expect(shown).toContain('one-way');
	});

	it('still converts seconds while a custom calendar is bound', async () => {
		await moment('the-breach', '0');
		await withCustomCalendar();

		expect(said(await run('/time at 0'))).toContain('at: 0');
	});

	it('falls back to seconds, and says why, when formulas are not consented', async () => {
		await moment('the-breach', '0');
		await writeFile(resolve(root, VAULT.formulas), `# Formulas\n${CALENDAR}`, 'utf8');
		await writeFile(resolve(root, VAULT.time), '---\ncalendar: custom\n---\n', 'utf8');
		await refresh(); // no consent

		const {calendar, note} = calendarFor(context.project!.vault.time, {
			formatted: context.project!.calendarText,
		});
		expect(calendar.id).toBe('seconds');
		expect(note).toContain('/consent');
	});
});

describe('the wiki reads the clock through the calendar', () => {
	it('shows a moment as a date once one is bound', async () => {
		await moment('the-breach', '0');
		await run('/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles');

		const page = buildWiki(context.project!).pages.find(
			p => p.kind === 'moment' && p.id === 'the-breach',
		);
		expect(page?.body).toContain('2031-08-15 19:33:00');
	});

	it('still shows the raw seconds beside it', async () => {
		await moment('deep', '-26174880000000123');
		await run('/time gregorian 2031-08-15T19:33:00-07:00');

		const page = buildWiki(context.project!).pages.find(
			p => p.kind === 'moment' && p.id === 'deep',
		);
		// The number is the truth; the date is a reading of it.
		expect(page?.body).toContain('-26,174,880,000,000,123');
	});
});
