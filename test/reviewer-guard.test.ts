import {describe, expect, it} from 'vitest';
import {guardCorrection} from '../source/reviewer/guard.js';

/**
 * The guard is the whole safety story for `/reviewer`: it is what makes "spelling
 * and grammar only" a constraint rather than a request. These tests are written
 * as the two questions that matter — does it let a real correction through, and
 * does it stop everything else.
 */

const doc = (body: string, front = 'id: sit-901\narc: arc-90\norder: 10') =>
	`---\n${front}\n---\n\n${body}\n`;

const accepts = (before: string, after: string) => guardCorrection(before, after).ok;

const refusalFor = (before: string, after: string) => {
	const verdict = guardCorrection(before, after);
	expect(verdict.ok).toBe(false);
	return verdict.ok ? '' : verdict.reason;
};

describe('corrections it must allow', () => {
	it('a plain misspelling', () => {
		expect(
			accepts(
				doc('The sword lay were he left it.'),
				doc('The sword lay where he left it.'),
			),
		).toBe(true);
	});

	it('a misplaced comma', () => {
		expect(accepts(doc('He turned ,slowly.'), doc('He turned, slowly.'))).toBe(true);
	});

	/** Two-character words are exactly where a similarity ratio alone would fail. */
	it('an article agreement fix', () => {
		expect(accepts(doc('She drew a arrow.'), doc('She drew an arrow.'))).toBe(true);
	});

	it('a capitalisation fix', () => {
		expect(accepts(doc('the door opened.'), doc('The door opened.'))).toBe(true);
	});

	it('a missing word inserted', () => {
		expect(
			accepts(doc('He opened door slowly.'), doc('He opened the door slowly.')),
		).toBe(true);
	});

	it('several typos across several lines', () => {
		expect(
			accepts(
				doc('Teh room was cold.\n\nHe waited their for hours.'),
				doc('The room was cold.\n\nHe waited there for hours.'),
			),
		).toBe(true);
	});

	it('a correction on a line that also contains a number and a link', () => {
		expect(
			accepts(
				doc('He owed 40 gold to [[donut]], and he new it.'),
				doc('He owed 40 gold to [[donut]], and he knew it.'),
			),
		).toBe(true);
	});
});

describe('edits it must refuse', () => {
	it('any frontmatter change', () => {
		expect(
			refusalFor(
				doc('He waited.', 'id: sit-901\norder: 10'),
				doc('He waited.', 'id: sit-901\norder: 20'),
			),
		).toContain('frontmatter changed');
	});

	it('a changed number, which is a story edit', () => {
		expect(refusalFor(doc('He owed 40 gold.'), doc('He owed 50 gold.'))).toContain(
			'a number changed',
		);
	});

	it('a rewired wikilink', () => {
		expect(refusalFor(doc('He found [[donut]].'), doc('He found [[carl]].'))).toContain(
			'wikilink target changed',
		);
	});

	/** The failure this feature is one bad generation away from. */
	it('a word swapped for a better word', () => {
		expect(
			refusalFor(doc('He walked into the room.'), doc('He sauntered into the room.')),
		).toContain('is a rewrite');
	});

	it('a sentence rewritten in place', () => {
		expect(
			refusalFor(
				doc('He opened the door and went inside.'),
				doc('The door yielded, and he stepped through into the dark.'),
			),
		).toBeTruthy();
	});

	it('an added line', () => {
		expect(refusalFor(doc('He waited.'), doc('He waited.\n\nThen he left.'))).toContain(
			'line count changed',
		);
	});

	it('a removed line', () => {
		expect(refusalFor(doc('He waited.\n\nThen he left.'), doc('He waited.'))).toContain(
			'line count changed',
		);
	});

	it('a gutted line, even though the line count holds', () => {
		expect(refusalFor(doc('He waited a long time.'), doc(''))).toBeTruthy();
	});

	it('a change inside a generated block', () => {
		const before = doc(
			'Before.\n\n<!-- litrpg:status char=carl -->\nlevel 7\n<!-- /litrpg:status -->',
		);
		const after = doc(
			'Before.\n\n<!-- litrpg:status char=carl -->\nlevel 8\n<!-- /litrpg:status -->',
		);
		expect(refusalFor(before, after)).toBeTruthy();
	});

	it('creating a file from nothing', () => {
		expect(refusalFor('', doc('A brand new scene.'))).toContain('never creates a file');
	});

	it('a no-op', () => {
		expect(refusalFor(doc('He waited.'), doc('He waited.'))).toContain('nothing changed');
	});

	/**
	 * The gap a probe found that the rules above did not close: one inserted word
	 * is within any sane structural allowance, but `the steps` → `the cold steps`
	 * is writing. Only closed-class words may be added.
	 */
	it('an adjective slipped in, which counting insertions alone would allow', () => {
		expect(
			refusalFor(
				doc('He counted the steps down.'),
				doc('He counted the cold steps down.'),
			),
		).toContain('was added');
	});

	it('a content word quietly removed', () => {
		expect(
			refusalFor(
				doc('He counted the cold steps down.'),
				doc('He counted the steps down.'),
			),
		).toContain('was removed');
	});
});

describe('grammar insertions it must still allow', () => {
	it('a missing article', () => {
		expect(accepts(doc('He opened door.'), doc('He opened the door.'))).toBe(true);
	});

	it('a missing preposition', () => {
		expect(accepts(doc('He listened the door.'), doc('He listened at the door.'))).toBe(
			true,
		);
	});

	/** The removed token can be anything at all when it is a doubled word. */
	it('a doubled word', () => {
		expect(accepts(doc('He counted the the steps.'), doc('He counted the steps.'))).toBe(
			true,
		);
		expect(
			accepts(doc('It was cold cold down there.'), doc('It was cold down there.')),
		).toBe(true);
	});
});

describe('the verdict is debuggable', () => {
	it('names the line a refusal came from', () => {
		const verdict = guardCorrection(
			doc('He waited.\n\nHe walked away.'),
			doc('He waited.\n\nHe departed away.'),
		);

		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? undefined : verdict.line).toBeGreaterThan(0);
	});

	it('counts the lines a correction touched', () => {
		const verdict = guardCorrection(
			doc('Teh room was cold.\n\nHe waited their.'),
			doc('The room was cold.\n\nHe waited there.'),
		);

		expect(verdict.ok ? verdict.changedLines : 0).toBe(2);
	});
});
