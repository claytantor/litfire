# Ingesting your own notes

The interviews go one way: the tool asks, you answer, extraction reads the
transcript. `/ingest` is the other way. You already know your world, you write
it into `raw/characters/` and `raw/moments/`, and this turns those notes into
typed pages.

```
/ingest character                    # every note in raw/characters/
/ingest character sebastian-weber    # just that one
```

## Where notes live

One directory per kind, under `raw/`:

| Kind        | Notes in          | Pages proposed to   |
| ----------- | ----------------- | ------------------- |
| `character` | `raw/characters/` | `characters/`       |
| `moment`    | `raw/moments/`    | `timeline/moments/` |
| `place`     | `raw/places/`     | `places/`           |
| `situation` | `raw/situations/` | `situations/`       |
| `system`    | `raw/systems/`    | `systems/`          |
| `arc`       | `raw/arcs/`       | `timeline/arcs/`    |
| `faction`   | `raw/factions/`   | `factions/`         |
| `artifact`  | `raw/artifacts/`  | `artifacts/`        |
| `theme`     | `raw/themes/`     | `themes/`           |

Notes are freeform. There is no format to learn — headings, bullets, a wall of
prose, a table you pasted from somewhere. Naming a file after the thing it
describes helps, because that is what `/ingest <kind> <document>` matches, but
nothing requires it.

## Saying what you already know

A note may carry frontmatter. Those fields are **decisions**, not hints:

```yaml
---
moment: inannas-first-memory
cast: [inanna, linh-tran, sebastian-weber]
place: oz-farm
---
Inanna was woken suddenly, she could feel afraid and alarm like any
five-year-old would.
```

Ingest is told to carry every one of them onto the page unchanged, including
ones it would have chosen differently, and to fill in only what you left out.
It is also **enforced in code**: your fields go back on after the model returns,
so a link you set does not depend on a model remembering it.

Two limits, both deliberate:

- It applies to the page the note is _about_ — a note named `sit-001.md` speaks
  for `sit-001`. A compendium that produces nine pages says nothing in
  particular about any one of them.
- `source` and `source_hash` are the tool's bookkeeping. A note cannot set them,
  so it cannot forge its own provenance.

If a field you set contradicts your own prose, the field wins and ingest says so
in its notes. Which one is right is yours to settle.

## What happens

Your notes and the pages that already exist go to the structural pass, which
proposes the corpus that should exist beside them. Every proposal reaches you as
a diff in the [review gate](./review-gate.md), one at a time. Nothing is written
until you accept it.

Three things it is told, which are the ones that matter:

- **One note may hold several things.** An ordered list of nine moments is nine
  pages, not one.
- **Update rather than duplicate.** It is shown every existing page of that
  kind, and told to fold new material into one that already exists rather than
  minting a second under a different id. This is what stops `/ingest` producing
  the `duplicate_name` findings it was meant to resolve.
- **Never invent.** A field the notes do not answer is left out, and the checks
  raise it as an open question. A plausible guess nobody wrote is worse than a
  gap.

## Editing brings a page across

A vault written before this had pages in the corpus and nothing in `raw/`. There
is no migration to schedule: **the first time you edit a page, it moves.**

```
› /moment the-breach at 86400
  the-breach at 86,400
  reads as 86,400s · 1d from origin
  adopted into raw/moments/the-breach.md — your copy lives there now
```

The whole page is copied — frontmatter and prose — so the note is a complete
record rather than a stub. From then on, that note is the one being edited, and
the said-once line does not come back.

The derived page is updated at the same time, **without a model call**. Setting
a field you stated is a copy, not an inference, and `/ingest` would do nothing
cleverer with it. The page is re-stamped with the note's new hash, so the next
`/ingest` correctly skips it.

Prose changes still need a pass. Those genuinely need reading.

## Your notes are not touched

`/ingest` reads `raw/` and proposes elsewhere. The notes stay exactly as you
wrote them — they are the record the corpus is derived _from_, and the tool
having rewritten them would make that record worthless.

::: tip The one exception
`/curator` may propose changes to `raw/` when the error is in the record
itself — a name spelled two ways, a link that no longer resolves. That is a
different job, done deliberately, and still only as a diff you accept.
:::

## When it goes wrong

Ingest proposes; it does not verify. Read the diffs, then run `/lint`.

Two failures are worth watching for, and the checks catch both:

- **A second page for something that already exists**, under a different id or
  in a different directory. `/lint` reports `duplicate_id` when two files
  declare one id and `duplicate_name` when two ids share a name. The pass is
  shown every existing page _by path_ precisely so it can propose removing the
  lesser copy rather than adding a third.
- **A link to something that is not there.** Notes reference ids the corpus may
  not have — `[[inanna-first-memory]]` where the vault settled on
  `inannas-first-memory`, or a cast member whose page was never written. Ingest
  copies what the notes say rather than guessing, and `broken_reference` names
  each one.

Neither is resolved for you. `/curator` can propose the merge or the rename;
you accept it in the gate.

If a proposal is nearly right, press `e` and fix it there rather than rejecting
and re-running: the buffer edits what will be written.
