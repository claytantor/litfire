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
