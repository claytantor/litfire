import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {artifactSchema, characterSchema} from '../source/domain/schema.js';
import {computeProject} from '../source/core/project.js';
import {resolveProfile, BUILT_IN_PROFILES} from '../source/genre/index.js';
import {loadVault} from '../source/vault/load.js';
import {VAULT} from '../source/vault/paths.js';
import {buildWiki} from '../source/wiki/build.js';

let root = '';

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'litfire-artifact-'));
	await mkdir(path.join(root, VAULT.systems), {recursive: true});
	await writeFile(
		path.join(root, VAULT.systems, 'the-lathe.md'),
		'---\nid: the-lathe\nname: The Lathe\nskills:\n  - {id: marksmanship}\n---\n\n# The Lathe\n',
		'utf8',
	);
});

afterEach(async () => {
	await rm(root, {recursive: true, force: true});
});

async function artifact(id: string, frontmatter: string): Promise<void> {
	await mkdir(path.join(root, VAULT.artifacts), {recursive: true});
	await writeFile(
		path.join(root, VAULT.artifacts, `${id}.md`),
		`---\nid: ${id}\n${frontmatter}---\n\n# ${id}\n`,
		'utf8',
	);
}

async function character(id: string, frontmatter = ''): Promise<void> {
	await mkdir(path.join(root, VAULT.characters), {recursive: true});
	await writeFile(
		path.join(root, VAULT.characters, `${id}.md`),
		`---\nid: ${id}\n${frontmatter}---\n\n# ${id}\n`,
		'utf8',
	);
}

async function situation(events: string): Promise<void> {
	await mkdir(path.join(root, VAULT.arcs), {recursive: true});
	await writeFile(
		path.join(root, VAULT.arcs, 'arc-01.md'),
		'---\nid: arc-01\norder: 1\n---\n\n# arc-01\n',
		'utf8',
	);
	await mkdir(path.join(root, VAULT.situations), {recursive: true});
	await writeFile(
		path.join(root, VAULT.situations, 'sit-a.md'),
		`---\nid: sit-a\narc: arc-01\norder: 1\nevents:\n${events}---\n\n# sit-a\n`,
		'utf8',
	);
}

const RIFLE = [
	'name: M1A Rifle',
	'kind: rifle',
	'outcome: Reaches a target at distance, loudly.',
	'requires_skills: [marksmanship]',
	'',
].join('\n');

describe('artifacts as a primitive', () => {
	it('loads one page per artifact', async () => {
		await artifact('m1a-rifle', RIFLE);
		await artifact(
			'mass-spectrometer',
			'name: Mass Spectrometer\noutcome: Names a substance.\n',
		);

		const vault = await loadVault(root);
		expect(vault.issues).toEqual([]);
		expect(vault.artifacts.map(a => a.id)).toEqual(['m1a-rifle', 'mass-spectrometer']);
		expect(vault.artifacts[0]).toMatchObject({
			name: 'M1A Rifle',
			kind: 'rifle',
			requires_skills: ['marksmanship'],
		});
	});

	it('lets one character carry many', async () => {
		const parsed = characterSchema.parse({
			id: 'inanna',
			artifacts: ['m1a-rifle', 'mass-spectrometer'],
		});
		expect(parsed.artifacts).toEqual(['m1a-rifle', 'mass-spectrometer']);
		expect(characterSchema.parse({id: 'x'}).artifacts).toEqual([]);
	});

	it('needs only an id, so a stub survives', () => {
		const stub = artifactSchema.parse({id: 'the-sky', stub: true});
		expect(stub.outcome).toBeUndefined();
		expect(stub.requires_skills).toEqual([]);
	});
});

describe('the ledger', () => {
	it('carries an artifact from acquisition to loss', async () => {
		await artifact('m1a-rifle', RIFLE);
		await character('inanna', 'system: the-lathe\nskills: [marksmanship]\n');
		await situation(
			[
				'  - {type: acquire_artifact, actor: inanna, artifact: m1a-rifle}',
				'  - {type: use_artifact, actor: inanna, artifact: m1a-rifle}',
				'',
			].join('\n'),
		);

		const project = await computeProject(root);
		expect(project.replay.state.characters['inanna']?.artifacts).toEqual(['m1a-rifle']);
		expect(project.questions.map(q => q.kind)).not.toContain('artifact_used_unheld');
	});

	it('reports using something the character is not carrying', async () => {
		await artifact('m1a-rifle', RIFLE);
		await character('inanna', 'system: the-lathe\nskills: [marksmanship]\n');
		await situation('  - {type: use_artifact, actor: inanna, artifact: m1a-rifle}\n');

		const project = await computeProject(root);
		const finding = project.questions.find(q => q.kind === 'artifact_used_unheld');
		expect(finding?.detail).toContain("uses 'm1a-rifle' without carrying it");
	});

	it('leaves possession untouched when something is merely used', async () => {
		// A use is a fact about a scene, not a transfer.
		await artifact('m1a-rifle', RIFLE);
		await character(
			'inanna',
			'system: the-lathe\nskills: [marksmanship]\nartifacts: [m1a-rifle]\n',
		);
		await situation('  - {type: use_artifact, actor: inanna, artifact: m1a-rifle}\n');

		const project = await computeProject(root);
		expect(project.replay.state.characters['inanna']?.artifacts).toEqual(['m1a-rifle']);
	});

	it('reports an artifact with no page', async () => {
		await character('inanna', 'system: the-lathe\n');
		await situation('  - {type: acquire_artifact, actor: inanna, artifact: nowhere}\n');

		const project = await computeProject(root);
		const finding = project.questions.find(q => q.kind === 'unknown_artifact');
		expect(finding?.detail).toContain('artifacts/');
	});

	it('reports a use without the skill it requires', async () => {
		await artifact('m1a-rifle', RIFLE);
		// No marksmanship.
		await character('inanna', 'system: the-lathe\nartifacts: [m1a-rifle]\n');
		await situation('  - {type: use_artifact, actor: inanna, artifact: m1a-rifle}\n');

		const project = await computeProject(root);
		const finding = project.questions.find(q => q.kind === 'artifact_without_skill');
		expect(finding?.detail).toContain("without 'marksmanship'");
	});

	it('does not object to carrying what you cannot yet work', async () => {
		// Being handed a rifle before you can shoot it is a story, not an error.
		await artifact('m1a-rifle', RIFLE);
		await character('inanna', 'system: the-lathe\n');
		await situation('  - {type: acquire_artifact, actor: inanna, artifact: m1a-rifle}\n');

		const project = await computeProject(root);
		expect(project.questions.map(q => q.kind)).not.toContain('artifact_without_skill');
	});

	it('asks what an artifact is for when nobody has said', async () => {
		await artifact('the-sky', 'name: The Sky\n');
		const project = await computeProject(root);

		const finding = project.questions.find(q => q.kind === 'artifact_outcome_unknown');
		expect(finding?.detail).toContain('what does a character achieve');
	});
});

describe('vocabulary and the wiki', () => {
	it('gives each idiom its own word for a thing', () => {
		const arcane = resolveProfile('arcane', BUILT_IN_PROFILES);
		const tech = resolveProfile('technological', BUILT_IN_PROFILES);

		expect(arcane.lexicon.artifact).toBe('relic');
		expect(tech.lexicon.artifact).toBe('device');
		// The engine holds no genre vocabulary of its own.
		expect(resolveProfile('base', BUILT_IN_PROFILES).lexicon.artifact).toBeUndefined();
	});

	it('publishes a page saying what it achieves and who carries it', async () => {
		await artifact('m1a-rifle', RIFLE);
		await character('inanna', 'system: the-lathe\nskills: [marksmanship]\n');
		await situation(
			[
				'  - {type: acquire_artifact, actor: inanna, artifact: m1a-rifle}',
				'  - {type: use_artifact, actor: inanna, artifact: m1a-rifle}',
				'',
			].join('\n'),
		);

		const wiki = buildWiki(await computeProject(root));
		const page = wiki.pages.find(p => p.path === `${VAULT.wiki}/artifacts/m1a-rifle.md`);

		expect(page?.title).toBe('M1A Rifle');
		expect(page?.body).toContain('Reaches a target at distance');
		expect(page?.body).toContain('[[marksmanship]]');
		expect(page?.body).toContain('- [[inanna]]');
		expect(page?.body).toContain('inanna used it');
		expect(page?.summary).toContain('rifle');
	});

	it('lists artifacts in the index under their own heading', async () => {
		await artifact('m1a-rifle', RIFLE);
		const wiki = buildWiki(await computeProject(root));
		const index = wiki.pages.find(page => page.kind === 'index');

		expect(index?.body).toContain('## Artifacts (1)');
		expect(index?.body).toContain('[[m1a-rifle|M1A Rifle]]');
	});
});

const said = (r: {lines: readonly {readonly text: string}[]}) =>
	r.lines.map(l => l.text).join('\n');

describe('/primitives', () => {
	const dispatch = async (args: string[]) => {
		const {findCommand} = await import('../source/commands/registry.js');
		return findCommand('primitives')!.run(args, {
			root,
			project: await computeProject(root),
			activeCharacter: undefined,
			setActiveCharacter: () => {},
			consentFormulas: () => {},
		});
	};

	it('lists every id, grouped by kind', async () => {
		await artifact('m1a-rifle', RIFLE);
		await character('inanna', 'system: the-lathe\n');

		const rendered = said(await dispatch([]));
		expect(rendered).toContain('system (1)');
		expect(rendered).toContain('the-lathe');
		expect(rendered).toContain('character (1)');
		expect(rendered).toContain('inanna');
		expect(rendered).toContain('artifact (1)');
		expect(rendered).toContain('m1a-rifle');
	});

	it('narrows to one kind', async () => {
		await artifact('m1a-rifle', RIFLE);
		await character('inanna', 'system: the-lathe\n');

		const rendered = said(await dispatch(['artifact']));
		expect(rendered).toContain('m1a-rifle');
		expect(rendered).not.toContain('inanna');
	});

	it('says which kinds exist when given one that does not', async () => {
		const rendered = said(await dispatch(['sandwich']));
		expect(rendered).toContain("no kind 'sandwich'");
		expect(rendered).toContain('moment');
	});

	it('reports the system a character actually resolves to', async () => {
		// A single-system vault resolves every character into it without anyone
		// writing it down. Showing the declared field would print "(no system)"
		// beside a system claiming that character — the view disagreeing with
		// itself.
		await character('the-custodian', '');
		const rendered = said(await dispatch(['character']));
		expect(rendered).toContain('the-lathe (inferred)');
	});

	it('answers to its own name and nothing else', async () => {
		const {findCommand} = await import('../source/commands/registry.js');
		expect(findCommand('primitives')?.name).toBe('primitives');
		for (const wrong of ['prototype', 'prototypes', 'primitive', 'ids']) {
			expect(findCommand(wrong), wrong).toBeUndefined();
		}
	});
});
