import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {stringifyDocument} from '../source/vault/frontmatter.js';
import {loadVault} from '../source/vault/load.js';
import {VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

describe('chapters vault plumbing', () => {
	it('scaffolds a chapters/ directory whose seed chapter loads', async () => {
		await scaffoldVault(root);
		const vault = await loadVault(root);

		expect(vault.issues).toEqual([]);
		expect(vault.chapters.some(chapter => chapter.id === 'ch-01')).toBe(true);
	});

	it('marks the seed chapter as an example, same as the seed situation', async () => {
		await scaffoldVault(root);
		const seed = await readFile(path.join(root, VAULT.chapters, 'ch-01.md'), 'utf8');

		expect(seed).toContain('example: true');
	});

	it('round-trips a valid chapter through the loader', async () => {
		await scaffoldVault(root);
		await writeFile(
			path.join(root, VAULT.chapters, 'ch-901.md'),
			stringifyDocument({
				data: {id: 'ch-901', title: 'Loose Ends', order: 900, starts_at: 'sit-901'},
				body: '# Loose Ends\n',
			}),
			'utf8',
		);

		const vault = await loadVault(root);
		const chapter = vault.chapters.find(c => c.id === 'ch-901');

		expect(chapter).toEqual({
			id: 'ch-901',
			title: 'Loose Ends',
			order: 900,
			starts_at: 'sit-901',
		});
	});

	it('records an issue for a malformed chapter without throwing, and still loads the rest', async () => {
		await scaffoldVault(root);
		await writeFile(
			path.join(root, VAULT.chapters, 'broken.md'),
			'---\nid: 123-NOT-VALID\norder: "not a number"\n---\n',
			'utf8',
		);
		await writeFile(
			path.join(root, VAULT.chapters, 'ch-902.md'),
			stringifyDocument({
				data: {id: 'ch-902', order: 901, starts_at: 'sit-901'},
				body: '# Fine\n',
			}),
			'utf8',
		);

		const vault = await loadVault(root);

		expect(vault.issues.length).toBeGreaterThan(0);
		expect(vault.chapters.some(chapter => chapter.id === 'ch-902')).toBe(true);
		expect(vault.chapters.some(chapter => chapter.id === 'ch-01')).toBe(true);
	});

	it('links the chapters section from index.md', async () => {
		await scaffoldVault(root);
		const index = await readFile(path.join(root, VAULT.index), 'utf8');

		expect(index).toContain('[[ch-01]]');
	});
});
