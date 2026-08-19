# Assembly

`buildSequence` already produces the canonical reading order — arcs by order,
scenes by sparse integer, world events interleaved by clock. So **a chapter is a
cut in that sequence, not a list of scenes**:

```yaml
# chapters/ch-001.md
id: ch-001
title: The Descent
order: 10
starts_at: sit-901 # runs until the next chapter opens
```

Membership is derived on every render, never stored. That is what stops a scene
being claimed by two chapters or by none, and it means a scene inserted mid-arc
lands in the right chapter without anyone editing a manifest.

```
› /chapter
  ch-001  The Descent  2 scenes  sit-901 → sit-902
  ch-002  Collection   1 scene   sit-903 → sit-903

  seams: 1 arc · 2 cast · 1 chapter · 1 elapsed · 1 place
```

## Seams

`/chapter <id>` shows what changes between adjacent scenes, printed between the
two scenes it sits between rather than as a list somewhere else:

```
  sit-901  The Door
      ⌇ the scene relocates — place changes from 'threshold' to 'ledger-room'
      ⌇ who is present changes — donut enters
  sit-902  The Ledger
```

Five kinds, all deterministic from frontmatter and the sequence: `chapter`,
`arc`, `elapsed` (a world event falls between them), `place`, `cast`. Nothing
here blocks anything (P4) — a seam is a place a reader may need help, not an
error.

## Transitions

Connective text lives in the **chapter** file, never between the scenes it
joins, because scenes are author-owned files the tool must not touch. Position
comes from the D1 marker syntax `vault/markers.ts` already committed to:

```markdown
<!-- litrpg:transition after=sit-901 -->

The stairs gave onto a room that smelled of burnt copper.
<!-- /litrpg:transition -->
```

That makes a transition an ordinary reviewable file write when the LLM pass
lands, rather than a new format nothing else understands.

## Export

`/export [path]` assembles `manuscript.md`. Scene prose is copied byte for byte
— P6 holds through assembly, and the manuscript is derived in the same sense
`ledger/state.md` is: regenerated wholesale, never the source of truth for a
word it contains.

- **`manuscript.md` is in `FORBIDDEN_PREFIXES`.** A model proposing into it would
  be editing output instead of source, and the change would vanish on the next
  export.
- **Export refuses to write onto any corpus directory.** A mistyped
  `/export situations/sit-014.md` would otherwise replace a scene with a
  manuscript containing it, and that scene file is the only copy of that prose.
- **Unclaimed scenes are appended under their own heading**, not dropped. A scene
  that no chapter opened early enough to claim is exactly the silent loss
  assembly exists to prevent.
- A placed scene with no prose yet renders as `_[title — not written yet]_`, so
  an author assembling a draft can see the holes.
