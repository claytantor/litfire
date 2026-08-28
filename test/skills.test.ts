import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {computeProject} from '../source/core/project.js';
import {INGEST, INGEST_KINDS} from '../source/ingest/index.js';
import {stringifyDocument} from '../source/vault/frontmatter.js';
import {loadVault} from '../source/vault/load.js';
import {RAW_KINDS, resolve, VAULT} from '../source/vault/paths.js';
import {scaffoldVault} from '../source/vault/scaffold.js';
import {buildWiki} from '../source/wiki/build.js';

let root = '';

const put = async (relative: string, data: Record<string, unknown>, body = '\n') => {
	const file = resolve(root, relative);
	await mkdir(path.dirname(file), {recursive: true});
	await writeFile(file, stringifyDocument({data, body}), 'utf8');
};

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-skills-'));
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

describe('a skill is a primitive the author writes', () => {
	it('has a raw folder, a corpus home and an ingest route between them', () => {
		expect(RAW_KINDS).toContain('skills');
		expect(INGEST_KINDS).toContain('skill');
		expect(INGEST.skill.from).toBe(`${VAULT.raw}/skills`);
		expect(INGEST.skill.to).toBe(VAULT.skills);
	});

	it('creates raw/skills/ so there is somewhere to write one', async () => {
		await scaffoldVault(root, 'arcane');
		const vault = await loadVault(root);
		expect(vault.issues).toEqual([]);
		// Both halves: the author's folder and the derived one it ingests into.
		await expect(
			mkdir(resolve(root, `${VAULT.raw}/skills`), {recursive: false}),
		).rejects.toThrow(/EEXIST/);
		await expect(mkdir(resolve(root, VAULT.skills), {recursive: false})).rejects.toThrow(
			/EEXIST/,
		);
	});

	it('loads a skill page into the vault', async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.skills, 'ember-bolt.md'), {
			id: 'ember-bolt',
			name: 'Ember Bolt',
		});

		const vault = await loadVault(root);
		expect(vault.issues).toEqual([]);
		expect(vault.skills.map(skill => skill.id)).toEqual(['ember-bolt']);
	});
});

describe('a skill page and a system declaration are both legal', () => {
	/**
	 * The regression this whole primitive exists around: before it, a skill the
	 * author had written a page for was still `unknown_skill` at the moment it
	 * was acquired, because only a system's frontmatter counted as declaring one.
	 */
	it('a page alone is enough to acquire it', async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.skills, 'ember-bolt.md'), {
			id: 'ember-bolt',
			name: 'Ember Bolt',
		});
		await put(path.join(VAULT.characters, 'mage.md'), {id: 'mage'});
		await put(path.join(VAULT.situations, 'sit-900.md'), {
			id: 'sit-900',
			arc: 'arc-01',
			order: 20,
			title: 'The first bolt',
			characters: ['mage'],
			events: [{actor: 'mage', type: 'acquire_skill', skill: 'ember-bolt'}],
		});

		const project = await computeProject(root);
		expect(project.questions.filter(q => q.kind === 'unknown_skill')).toEqual([]);
	});

	it('still reports a skill nothing defines', async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.characters, 'mage.md'), {id: 'mage'});
		await put(path.join(VAULT.situations, 'sit-900.md'), {
			id: 'sit-900',
			arc: 'arc-01',
			order: 20,
			title: 'The first bolt',
			characters: ['mage'],
			events: [{actor: 'mage', type: 'acquire_skill', skill: 'ember-bolt'}],
		});

		const project = await computeProject(root);
		expect(project.questions.map(q => q.kind)).toContain('unknown_skill');
	});

	it("a page's prerequisites are enforced like a system's", async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.skills, 'kindling.md'), {id: 'kindling'});
		await put(path.join(VAULT.skills, 'ember-bolt.md'), {
			id: 'ember-bolt',
			requires_skills: ['kindling'],
		});
		await put(path.join(VAULT.characters, 'mage.md'), {id: 'mage'});
		await put(path.join(VAULT.situations, 'sit-900.md'), {
			id: 'sit-900',
			arc: 'arc-01',
			order: 20,
			title: 'Skipping ahead',
			characters: ['mage'],
			events: [{actor: 'mage', type: 'acquire_skill', skill: 'ember-bolt'}],
		});

		const project = await computeProject(root);
		expect(project.questions.map(q => q.kind)).toContain('skill_before_prerequisite');
	});

	it('scopes a page to one system when it names one', async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.systems, 'the-seed.md'), {id: 'the-seed'});
		await put(path.join(VAULT.systems, 'the-mesh.md'), {id: 'the-mesh'});
		await put(path.join(VAULT.skills, 'ember-bolt.md'), {
			id: 'ember-bolt',
			system: 'the-seed',
		});
		await put(path.join(VAULT.characters, 'mage.md'), {
			id: 'mage',
			system: 'the-mesh',
		});
		await put(path.join(VAULT.situations, 'sit-900.md'), {
			id: 'sit-900',
			arc: 'arc-01',
			order: 20,
			title: 'Wrong system',
			characters: ['mage'],
			events: [{actor: 'mage', type: 'acquire_skill', skill: 'ember-bolt'}],
		});

		const project = await computeProject(root);
		// The Mesh does not grant it, so acquiring it under the Mesh is exactly
		// the mistake `system:` exists to catch.
		expect(project.questions.map(q => q.kind)).toContain('unknown_skill');
	});

	it('reports a page granted by a system that does not exist', async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.skills, 'ember-bolt.md'), {
			id: 'ember-bolt',
			system: 'the-nonexistent',
		});

		const project = await computeProject(root);
		const broken = project.questions.filter(q => q.kind === 'broken_reference');
		expect(broken.map(q => q.detail).join('\n')).toMatch(/the-nonexistent/);
	});

	it('reports a prerequisite nothing defines', async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.skills, 'ember-bolt.md'), {
			id: 'ember-bolt',
			requires_skills: ['kindling'],
		});

		const project = await computeProject(root);
		const broken = project.questions.filter(q => q.kind === 'broken_reference');
		expect(broken.map(q => q.detail).join('\n')).toMatch(/kindling/);
	});
});

describe('the wiki page for a skill', () => {
	it("renders the author's prose and what the page declares", async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.systems, 'the-seed.md'), {id: 'the-seed'});
		await put(
			path.join(VAULT.skills, 'ember-bolt.md'),
			{id: 'ember-bolt', name: 'Ember Bolt', system: 'the-seed', requires_level: 3},
			'\nA thrown coal that does not go out.\n',
		);

		const project = await computeProject(root);
		const page = buildWiki(project).pages.find(one => one.id === 'ember-bolt');

		expect(page?.title).toBe('Ember Bolt');
		expect(page?.body).toContain('A thrown coal that does not go out.');
		expect(page?.body).toContain('[[the-seed]]');
		expect(page?.body).toContain('Requires level **3**');
	});

	it('gets a page as soon as it is written, before anyone acquires it', async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.skills, 'ember-bolt.md'), {id: 'ember-bolt'});

		const project = await computeProject(root);
		const page = buildWiki(project).pages.find(one => one.id === 'ember-bolt');
		expect(page?.body).toContain('_Nobody yet._');
		// The "only seen in events" line is for a typo, and a written page is not
		// one — saying it here would call the author's own file undeclared.
		expect(page?.body).not.toContain('only seen in events');
	});

	it('still says so when a skill exists only because an event named it', async () => {
		await scaffoldVault(root, 'arcane');
		await put(path.join(VAULT.characters, 'mage.md'), {id: 'mage'});
		await put(path.join(VAULT.situations, 'sit-900.md'), {
			id: 'sit-900',
			arc: 'arc-01',
			order: 20,
			title: 'The first bolt',
			characters: ['mage'],
			events: [{actor: 'mage', type: 'acquire_skill', skill: 'ember-bolt'}],
		});

		const project = await computeProject(root);
		const page = buildWiki(project).pages.find(one => one.id === 'ember-bolt');
		expect(page?.body).toContain('only seen in events');
	});
});
