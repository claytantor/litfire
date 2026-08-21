import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject} from '../source/core/project.js';
import {resolveDates} from '../source/ingest/dates.js';
import {buildIngest, readRaw} from '../source/ingest/index.js';
import {calendarFor} from '../source/time/binding.js';
import {rawSeconds} from '../source/time/calendar.js';
import {parseDocument} from '../source/vault/frontmatter.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-dates-'));
	await scaffoldVault(root, 'arcane');
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

/** The binding from a real vault: an anchor, a calendar, a zone that has DST. */
async function bindGregorian() {
	await writeFile(
		path.join(root, VAULT.time),
		[
			'---',
			"origin: Inanna's Birthday",
			'calendar: gregorian',
			'epoch: 2031-08-15T19:33:00-07:00',
			'timezone: America/Los_Angeles',
			'---',
			'',
			'Why the clock starts there.',
			'',
		].join('\n'),
		'utf8',
	);
	const project = await computeProject(root);
	return calendarFor(project.vault.time).calendar;
}

const page = (at: string) =>
	`---\nid: the-breach\nname: The Breach\nat: ${at}\n---\n\nIt broke.\n`;

describe('a date the note stated becomes a position on the clock', () => {
	it('converts through the vault’s own calendar and zone', async () => {
		const calendar = await bindGregorian();
		const {contents} = resolveDates(page('2031-08-16 19:33:00'), calendar);

		// Exactly one day after the epoch — the same answer the author's own
		// throwaway script gave, computed against the binding rather than a
		// hardcoded constant.
		expect(parseDocument(contents).data['at']).toBe(86_400n);
	});

	it('says what it read, so the author can check it before accepting', async () => {
		const calendar = await bindGregorian();
		const {notes} = resolveDates(page('2031-08-16 19:33:00'), calendar);

		expect(notes[0]).toContain("read '2031-08-16 19:33:00'");
		expect(notes[0]).toContain('86400');
	});

	it('leaves a number exactly alone', async () => {
		const calendar = await bindGregorian();
		const {contents, notes} = resolveDates(page('86400'), calendar);

		// Already an instant: it came from the author or a previous pass, and
		// re-reading it through a calendar could only ever change it.
		expect(parseDocument(contents).data['at']).toBe(86_400n);
		expect(notes).toEqual([]);
	});
});

describe('what it refuses to guess', () => {
	it('drops a value the calendar cannot read, rather than writing a page that will not parse', async () => {
		const calendar = await bindGregorian();
		const {contents, notes} = resolveDates(page('some time before the war'), calendar);

		expect(parseDocument(contents).data['at']).toBeUndefined();
		expect(notes[0]).toContain('left undated');
	});

	/**
	 * Not kept as a string. A page whose `at` will not satisfy the schema loads
	 * as an issue and takes the moment off the clock anyway — honestly undated
	 * beats a page that will not parse, and `moment_undated` already says so.
	 */
	it('drops a date no calendar could read, whatever is bound', () => {
		const {contents, notes} = resolveDates(page('2031-08-16'), rawSeconds);

		expect(parseDocument(contents).data['at']).toBeUndefined();
		expect(notes[0]).toContain('left undated');
	});

	it('leaves an out-of-range instant to the schema, which already refuses it', async () => {
		const calendar = await bindGregorian();
		// `readWhen` cannot return one: `toInstant` and every shipped calendar's
		// `parse` refuse ±1 trillion years and return undefined instead.
		const {notes} = resolveDates(page("'-31557600000000000001'"), calendar);

		expect(notes[0]).toContain('left undated');
	});
});

describe('what the model is told', () => {
	it('is offered the date format when a calendar can read one', async () => {
		await bindGregorian();
		const project = await computeProject(root);
		const {documents} = await readRaw(root, 'moment');
		const {instruction} = await buildIngest(root, project, 'moment', documents);

		expect(instruction).toContain('## Dates');
		expect(instruction).toContain('Never do that arithmetic yourself');
	});

	it('is not offered it on a vault that reads raw seconds', async () => {
		const project = await computeProject(root);
		const {documents} = await readRaw(root, 'moment');
		const {instruction} = await buildIngest(root, project, 'moment', documents);

		expect(instruction).not.toContain('## Dates');
	});

	it('is not offered it for a kind that has no clock position', async () => {
		await bindGregorian();
		const project = await computeProject(root);
		const {documents} = await readRaw(root, 'place');
		const {instruction} = await buildIngest(root, project, 'place', documents);

		expect(instruction).not.toContain('## Dates');
	});
});
