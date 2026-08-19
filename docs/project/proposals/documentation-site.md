# Proposal — automatic documentation publishing

**Status:** accepted — phases 1 and 2 implemented (D8). Phase 3 is out of scope
and would need its own proposal.
**Scope:** the project's own documentation
**Deploys to:** `https://claytantor.github.io/litfire/`

## Summary

Publish the project documentation as a VitePress site, built and deployed to
GitHub Pages by GitHub Actions on every push to `main`. Source stays markdown in
the repository; the site is a derived artifact and is never edited by hand.

That last sentence is deliberate. It is the same rule the tool applies to
`wiki/` and `manuscript.md` inside a vault, and a documentation pipeline that
broke it — a site with content that exists only in the built output — would be
the project contradicting its own first principle in public.

## Why now

The README is **1,095 lines across 21 top-level sections**. It carries the
command table, the architecture, the formula sandbox, provider setup, the review
gate, artifacts, character systems, interviews, assembly, the wiki, the buffer,
the reviewer, projects, genre profiles, and vault layout.

That is not a README. It is a manual that happens to be rendered on the
repository landing page, where it has no navigation, no search, and no way to
link to a section without counting anchors.

Three concrete costs:

- **Nobody reads position 800.** Provider setup is at line 128 and genre
  profiles at line 854; a reader looking for the second has to know it exists.
- **There is no search.** GitHub's in-page find is the only tool, and it does
  not reach `docs/DECISIONS.md`, `CONTRIBUTING.md`, or `SECURITY.md`.
- **Cross-references are unchecked.** Nothing today catches a link to a section
  that has been renamed. VitePress fails the build on a dead relative link,
  which converts a class of silent rot into a CI failure.

The supporting documents are already split out and already good — `LITRPG.md`,
`DECISIONS.md`, `STATUS.md`, `CONTRIBUTING.md`, `SECURITY.md`. They are simply
invisible: reaching them requires scrolling to line 1082 of the README, where a
table lists them.

## What this proposal is not

**It does not publish anyone's vault.** A vault holds an unpublished novel.
Vaults are gitignored, must never enter this repository, and nothing in this
pipeline reads one. Publishing a vault's generated wiki is a genuinely
interesting feature and it is sketched in Phase 3 below — as a separate track,
in the author's own repository, on their explicit instruction.

## Proposed architecture

### Where content lives

VitePress takes over `docs/`, which already holds three of the five documents.

```
docs/
  .vitepress/
    config.ts          site config, nav, sidebar, base path
  index.md             landing page (hero + what it is)
  guide/
    getting-started.md  ← README "Requirements" + "Getting started"
    commands.md         ← README "Commands"
    writing-a-scene.md  ← README "Writing a scene"
    interviews.md       ← README "Interviews" + "Interview agent"
    review-gate.md      ← README "Review gate"
    reviewer.md         ← README "The reviewer"
    projects.md         ← README "Projects" + "Local story vaults"
  concepts/
    architecture.md     ← README "Architecture"
    character-systems.md ← README "Character systems"
    artifacts.md        ← README "Artifacts"
    assembly.md         ← README "Assembly"
    the-wiki.md         ← README "The wiki"
    genre-profiles.md   ← README "Multi-genre: setting profiles"
    litrpg.md           ← docs/LITRPG.md (moved)
  reference/
    providers.md        ← README "Model providers"
    formula-sandbox.md  ← README "The formula sandbox"
    scripts.md          ← README "Scripts"
  project/
    decisions.md        ← docs/DECISIONS.md (moved)
    status.md           ← docs/STATUS.md (moved)
    contributing.md     ← CONTRIBUTING.md (see below)
    security.md         ← SECURITY.md (see below)
    changelog.md        ← CHANGELOG.md (see below)
```

### The README problem

Four files must keep working at their current paths, because GitHub itself reads
them: `README.md`, `CONTRIBUTING.md` (linked from the PR form), `SECURITY.md`
(linked from the security tab), and `LICENSE`.

**Recommendation:** the README becomes a real landing page of roughly 120 lines —
what litfire is, a 30-second install, the command table, and links into the site.
Everything longer moves. `CONTRIBUTING.md` and `SECURITY.md` stay at the root and
are surfaced in the site by a one-line include rather than a copy, so there is
one source of truth per document.

The alternative — leave the README whole and have the site render it as one long
page — is less work and buys almost nothing, since the reason to have a site is
that a 1,095-line page is unnavigable. It is listed as an option below because it
is a legitimate smaller first step.

### The pipeline

Two workflows, deliberately separate from `ci.yml`:

- **On pull request:** build the docs. Do not deploy. This is the link checker.
- **On push to `main`:** build and deploy to Pages.

Splitting the build from the deploy is what keeps a broken link from reaching the
site and keeps a docs-only change from needing the full `pnpm check` matrix to
pass before it can be previewed.

```yaml
# .github/workflows/docs.yml
name: docs

on:
  push:
    branches: [main]
  pull_request:

# Pages allows one deployment at a time, and cancelling a half-finished one
# leaves the site in an undefined state — so unlike ci.yml, this does not
# cancel in progress.
concurrency:
  group: pages
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # VitePress reads git for "last updated"; a shallow clone has no dates.
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm docs:build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs/.vitepress/dist

  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    permissions:
      contents: read
      pages: write
      id-token: write
    steps:
      - id: deploy
        uses: actions/deploy-pages@v4
```

Notes on the choices:

- **`base: '/litfire/'`** in the VitePress config. Project pages are served from
  a subpath; the default `/` produces a site whose every asset 404s, and it
  works locally, which is how it reaches production.
- **`permissions` are per-job.** Only `deploy` gets `pages: write` and
  `id-token: write`. The build job, which is the one running third-party
  dependency code, gets `contents: read` and nothing else.
- **Pages source must be set to "GitHub Actions"** in repository settings once,
  by hand. There is no way to do this from a workflow, and it is the single
  most common reason a correct workflow deploys nothing.
- **pnpm and Node are already pinned** — `pnpm@11.1.0` via `packageManager`,
  Node 22 via `engines`. The workflow inherits both, as `ci.yml` does.

### Repository changes

```
package.json      + devDependency: vitepress
                  + scripts: docs:dev, docs:build, docs:preview
.gitignore        + docs/.vitepress/dist
                  + docs/.vitepress/cache
.github/workflows/docs.yml   new
```

VitePress is a devDependency only, and `package.json` already restricts the
published package to `files: ["dist"]`, so the npm artifact is unaffected.

One interaction to check: `pnpm check` runs `prettier --check .`, which will
start formatting the new markdown and the VitePress config. Either let it — the
site source is repository source — or exclude `docs/.vitepress/dist`, which the
`.gitignore` entry above already handles.

## Sequencing

**Phase 1 — the site exists.** VitePress installed, config with nav and sidebar,
`docs/` restructured, the five existing documents moved in. No README changes
yet; the site's guide section is thin. Deployable and useful on its own.

**Phase 2 — the README is split.** The 21 sections move into the pages mapped
above and the README becomes a landing page. This is the bulk of the work and
almost all of it is cut-and-paste plus fixing the relative links that break —
which the build now catches.

**Phase 3 — publishing a vault (separate track).** Sketched here because it is
the obvious next question, not because it is in scope.

litfire already generates a wiki as markdown. A `/publish` command could
scaffold a VitePress site into a vault's _own_ repository, so an author can
publish a world bible, a character index, or a public changelog for readers.
Three constraints are already known:

- **The wiki emits Obsidian `[[wikilinks]]`,** which VitePress does not
  understand. A transform is needed. There is precedent: `splitWikilink` in
  `source/wiki/serve-script.mjs` already handles the `[[id|Title]]` alias form
  for the local server.
- **It cannot run from this repository.** Vaults are gitignored and stay that
  way. The generated site belongs to the author's vault repository.
- **It must be explicit and selective.** Publishing an unpublished novel's
  internals is not a thing to do by default, and a whole-vault publish would
  leak spoilers, drafts, and `raw/`. Whatever this becomes, it opts in per page.

## Risks

| Risk                                                     | Mitigation                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Docs drift from the code once they are not in the README | The README shrinks to what rarely changes; CI's dead-link check catches structural rot  |
| Pages source not set to Actions → silent no-op deploy    | Named in the runbook; the `deploy` job's `url` output makes a successful deploy visible |
| A dependency bump breaks the docs build and blocks a PR  | Docs build is a separate workflow from `pnpm check`; a red docs job does not gate code  |
| Two copies of `CONTRIBUTING.md`                          | Include, never copy — one source of truth per document                                  |
| VitePress adds a heavy devDependency                     | Dev-only; npm package unaffected by `files: ["dist"]`                                   |

## Open questions

1. **README scope** — split to ~120 lines (recommended), or leave whole and
   render it as one site page (smaller first step)?
2. **Custom domain** — `claytantor.github.io/litfire` needs `base: '/litfire/'`;
   a custom domain does not. Worth deciding before the first deploy, because
   changing it later invalidates every published link.
3. **Versioned docs** — at `0.1.0` there is nothing to version. Assume no, and
   revisit if the vault format gains a migration.
4. **Does `pnpm check` gain `docs:build`?** It would catch dead links before
   push, at the cost of making every `check` slower. Suggest no for now — CI
   covers it.

## Effort

| Phase                                  | Estimate                              |
| -------------------------------------- | ------------------------------------- |
| 1 — site scaffold, config, move 5 docs | ~2 hours                              |
| 2 — split the README into 21 pages     | ~4 hours                              |
| 3 — vault publishing                   | not estimated; needs its own proposal |

## Decision needed

Accept Phase 1 and 2 as described, accept Phase 1 only, or take the smaller
first step in open question 1.
