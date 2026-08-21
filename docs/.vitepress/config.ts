import {defineConfig} from 'vitepress';

/**
 * The documentation site (D8).
 *
 * Source of truth is the markdown in `docs/`; this file only decides how it is
 * navigated. Nothing here generates content — a page that exists only in the
 * built output would break the same rule the tool applies to `wiki/` and
 * `manuscript.md` inside a vault.
 */
export default defineConfig({
	title: 'litfire',
	description:
		'A LitRPG authoring tool. Freeform situations in, deterministic game state out.',

	/**
	 * Project pages are served from a subpath. The default `/` builds a site
	 * whose every asset 404s — and it works locally, which is how that reaches
	 * production. Changing this invalidates every published link, so it is a
	 * decision, not a default (see the proposal, open question 2).
	 */
	base: '/litfire/',

	/** A dead relative link fails the build rather than the reader. */
	ignoreDeadLinks: false,

	lastUpdated: true,
	cleanUrls: true,

	head: [['meta', {name: 'theme-color', content: '#ff6b35'}]],

	themeConfig: {
		nav: [
			{text: 'Guide', link: '/guide/getting-started'},
			{text: 'Concepts', link: '/concepts/architecture'},
			{text: 'Reference', link: '/reference/providers'},
			{text: 'Project', link: '/project/decisions'},
		],

		sidebar: [
			{
				text: 'Guide',
				items: [
					{text: 'Getting started', link: '/guide/getting-started'},
					{text: 'How litfire works', link: '/guide/how-it-works'},
					{text: 'Creating primitives', link: '/guide/creating-primitives'},
					{text: 'Commands', link: '/guide/commands'},
					{text: 'Writing a scene', link: '/guide/writing-a-scene'},
					{text: 'Populating a situation', link: '/guide/populating-a-situation'},
					{text: 'Moments', link: '/guide/moments'},
					{text: 'Places', link: '/guide/places'},
					{text: 'Interviews', link: '/guide/interviews'},
					{text: 'Ingesting your notes', link: '/guide/ingest'},
					{text: 'Review gate', link: '/guide/review-gate'},
					{text: 'The reviewer', link: '/guide/reviewer'},
					{text: 'Projects and vaults', link: '/guide/projects'},
				],
			},
			{
				text: 'Concepts',
				items: [
					{text: 'Architecture', link: '/concepts/architecture'},
					{text: 'Primitives', link: '/concepts/primitives'},
					{text: 'Character systems', link: '/concepts/character-systems'},
					{text: 'Artifacts', link: '/concepts/artifacts'},
					{text: 'Assembly', link: '/concepts/assembly'},
					{text: 'The wiki', link: '/concepts/the-wiki'},
					{text: 'Genre profiles', link: '/concepts/genre-profiles'},
					{text: 'The LitRPG genre', link: '/concepts/litrpg'},
				],
			},
			{
				text: 'Reference',
				items: [
					{text: 'The in-world clock', link: '/reference/time'},
					{text: 'Model providers', link: '/reference/providers'},
					{text: 'The formula sandbox', link: '/reference/formula-sandbox'},
					{text: 'Scripts', link: '/reference/scripts'},
				],
			},
			{
				text: 'Project',
				items: [
					{text: 'Committed decisions', link: '/project/decisions'},
					{text: 'Build status', link: '/project/status'},
					{text: 'Contributing', link: '/project/contributing'},
					{text: 'Security', link: '/project/security'},
					{text: 'Changelog', link: '/project/changelog'},
					{
						text: 'Proposals',
						collapsed: true,
						items: [
							{
								text: 'Documentation publishing',
								link: '/project/proposals/documentation-site',
							},
							{text: 'Raw-first authoring', link: '/project/proposals/raw-first'},
							{text: 'One verb for asking', link: '/project/proposals/questions'},
						],
					},
				],
			},
		],

		socialLinks: [{icon: 'github', link: 'https://github.com/claytantor/litfire'}],

		search: {provider: 'local'},

		editLink: {
			pattern: 'https://github.com/claytantor/litfire/edit/main/docs/:path',
			text: 'Edit this page on GitHub',
		},

		footer: {
			message: 'Released under the MIT License.',
			copyright: 'Copyright © 2026 claytantor',
		},
	},
});
