# Committed decisions

Resolves §14 "Open decisions" of the Slice 1 requirements. Each entry records the
choice and the reason, so a later reader does not have to re-litigate it.

## D1 — Marker syntax for generated regions

**Committed:** exactly the form given in §11.

```
<!-- litrpg:status char=carl at=sit-042 -->
...generated block...
<!-- /litrpg:status -->
```

Rules: HTML comments so Obsidian renders nothing. `litrpg:` prefix namespaces the
tool. Attributes are `key=value`, space separated, unquoted, no spaces in values.
The close tag repeats the block name only.

§11 calls this a permanent format commitment, so it is frozen here and parsed by a
single module (`source/vault/markers.ts`). Nothing else may hand-roll the syntax.

## D2 — Authority of `state.md`

**Committed:** the `.litrpg/` cache is authoritative for computation; `state.md` is
a rendered projection carrying `generated: true`.

This follows the spec's own recommendation. It bends P1 ("the filesystem is the
API") slightly, but DoD 11 only requires that deleting `.litrpg/` loses nothing but
cache — which holds, because the cache is derived from markdown by a pure replay.
Hand-edits to `state.md` are detected and regeneration wins.

## D3 — Intra-arc `order` collisions

**Committed:** sparse integers, step 10 (10, 20, 30 …).

Fractional reindexing avoids rewrites but produces `order: 10.0009765625` in
frontmatter that an author has to look at in Obsidian, which loses on P2. Sparse
integers keep the file human-readable; a collision inserts at the midpoint, and
only when no gap remains does the arc renumber. Collisions are not errors — ties
break by filename so replay stays deterministic regardless.

## D4 — `/situation new` external open

**Superseded by D7** — `/situation new` now opens the native buffer. The rest of
this entry still describes how `$EDITOR` is resolved where it is still used.

**Committed:** `$EDITOR` by default, Obsidian URI when configured.

`.litrpg/config.json` carries `editor: "$EDITOR" | "obsidian"`. `$EDITOR` is the
portable default and works over SSH; the Obsidian URI scheme requires a registered
vault name and fails opaquely when absent.

## D5 — Node and the formula sandbox

**Committed:** `isolated-vm@^6.2.0`, pinned below 7.

`isolated-vm@7` requires Node >= 24; this project targets Node >= 22 because that
is Ink 7's floor. 6.2.0 supports >= 22 and enforces the CPU timeout. The caret must
not be widened to `^7` without also raising the engines floor.

Verified on Node 22: `fetch`, `process`, and `require` are already absent inside an
isolate, but **`Math.random` and `Date.now` are present** and must be explicitly
removed to satisfy the determinism requirement in §6.4.

## D6 — `$EDITOR` and the reviewer

**Committed:** `$EDITOR` is the program; `/reviewer` is the agent. One word, one
meaning.

The two collided. `$EDITOR` (D4) is what `/situation new` shells out to and what
`^e` reaches from the prose buffer — the program the author writes in. `/editor`
was also the model that reads the finished corpus and proposes corrections. Every
sentence about either one had to say which was meant, and the shared conversation
screen defaulted its speaker to `editor`, which is how `/architect` came to greet
authors under the wrong name.

The agent is now `/reviewer`, and `source/reviewer/` holds it. `source/editor/`
keeps only `buffer.ts`, the in-app prose buffer, because that genuinely is an
editor. The conversation types moved to `source/conversation/types.ts` with the
role `agent` rather than `editor`, so `/architect` no longer imports a type named
after the other agent, and the screen's `speaker` prop is required — a shared
screen that can default to a name is a screen that will eventually show the wrong
one.

The reviewer is still described as a literary editor in its persona and summary.
That is the craft it practises, and it was never the ambiguous part.

## D7 — Writing a situation

**Committed:** the native prose buffer, replacing the `$EDITOR` hand-off in D4.

D4 sent `/situation new` to `$EDITOR` because writing a whole scene looked like
a real editor's job. In practice it is the wrong shape: the tool loses the
terminal to another process, the author comes back to a prompt that has
forgotten what they were doing, and on a host with no `$EDITOR` set the command
did nothing but print advice.

`/situation new` and `/situation edit <id>` now open the scene in the buffer
that already existed for the review gate. It gained undo/redo, word and page
motions, and a confirm-before-discard that the review gate does not use — a
rejected proposal costs nothing to lose, a half-written scene costs everything.

Only the body is editable. Frontmatter is re-serialised from what was parsed at
open, so a save can normalise its formatting but cannot change its meaning; the
fields there belong to `/situation place`, extraction, and the ledger. Editing
frontmatter means Obsidian or any other editor, which the filesystem-is-the-API
principle already guarantees.

`$EDITOR` is not gone: `^e` still reaches it from the review gate, and
`vault/editor.ts` still resolves it. How an external editor gets wired to a
situation is left open rather than decided badly.

## D8 — Documentation publishing

**Committed:** VitePress in `docs/`, deployed to GitHub Pages by Actions.

The README had reached 1,095 lines across 21 sections — a manual rendered on a
landing page, with no navigation, no search, and five supporting documents
reachable only from a table near the bottom. It is now ~124 lines: what litfire
is, install, the command table, and links into the site.

Source stays markdown in `docs/`; the site is a derived artifact and is never
edited by hand. That is the same rule the tool applies to `wiki/` and
`manuscript.md` inside a vault, and a docs pipeline that broke it would have the
project contradicting its own first principle in public.

Three choices worth recording:

- **Build is split from deploy.** Pull requests build without deploying, which
  makes the build a link checker — VitePress fails on a dead relative link, so a
  renamed section becomes a CI failure instead of silent rot. Only the `deploy`
  job holds `pages: write`; the build job, which runs third-party dependency
  code, gets `contents: read` and nothing else.
- **`base: '/litfire/'`.** Project pages are served from a subpath, and the
  default `/` builds a site whose every asset 404s — while still working
  locally, which is how that reaches production. A custom domain would change
  this, and changing it later invalidates every published link.
- **Root documents are included, never copied.** `CONTRIBUTING.md` and
  `SECURITY.md` stay at the repository root, where GitHub's pull-request and
  security tabs look for them, and the site pulls them in with `@include`. One
  source of truth per document. The one cost: a relative link between two root
  files does not resolve once included, so `CONTRIBUTING.md`'s link to
  `SECURITY.md` is absolute.

`pnpm check` deliberately does **not** run `docs:build` — CI covers it, and the
check runs on every commit.

Repository settings must have Pages source set to "GitHub Actions". No workflow
can set it, and it is the most common reason a correct workflow deploys nothing.
