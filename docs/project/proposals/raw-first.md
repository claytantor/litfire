# Proposal — raw is the only thing you write

**Status:** proposed, not accepted
**Supersedes:** the authored corpus
**Pattern:** [karpathy's LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

## Summary

The author writes into `raw/`, one folder per primitive, by hand or through
litfire's editor or Obsidian. Everything else in the vault is derived from it.
`/ingest` is the LLM pass that reads a source and produces the typed page, doing
the formatting, linking and categorising. Re-running it when nothing changed
produces nothing.

## Why

litfire currently has two authored layers and they collide. A situation could be
written by hand into `situations/`, scaffolded by `/situation new`, proposed by
`/ingest`, or spilled from an interview — four writers, one file, no agreement
about who owns it. That produced a scene existing as two files under one id
(D19), a cast linked on one copy and invisible through the other, and an ingest
that could see the duplicate and not name it.

Fixing each collision individually keeps working. The pattern underneath does
not: **two writers on one file is the bug**, and litfire has several.

karpathy's wiki pattern resolves it by ownership. Sources are immutable and
yours. The generated layer belongs entirely to the LLM. Nothing is written by
both.

## The layers

karpathy has three. litfire needs four, because it does arithmetic a prose wiki
cannot.

```
raw/                    YOU write this. Prose, notes, transcripts.
  characters/             One folder per primitive.
  moments/
  situations/  …

characters/             INGEST writes this. Typed, schema-validated pages.
timeline/moments/       The LLM's layer: ids, links, categories, frontmatter.
situations/  …

ledger/                 REPLAY writes this. Pure arithmetic, no model.
wiki/                   BUILD writes this. Cross-reference, no model.
```

The middle layer is where litfire departs from the pattern and it is the whole
point of the tool. karpathy's wiki is prose with links; litfire's corpus is
**schema-validated data a replay engine consumes**. That is what makes levels,
xp and prerequisites checkable by code rather than asserted by a model.

So the division of labour is strict, and it is the founding bet of the project:

| The model does                         | Code does                             |
| -------------------------------------- | ------------------------------------- |
| Read prose and understand what it says | Validate every field against a schema |
| Choose links and categories            | Replay the ledger                     |
| Write the summary and the page body    | Build the wiki and the index          |
| Notice a contradiction and say so      | Every check in `/lint`                |

**The model never does arithmetic the code can do.** It is a formatter and a
librarian, not a calculator.

## Where an id comes from

The filename. Always.

```
raw/characters/sebastian-weber.md  →  characters/sebastian-weber.md
raw/places/oz-farm.md              →  places/oz-farm.md
```

This extends D19 across the layers and it removes the single largest source of
churn: **the model never chooses an id.** Two ingests of the same source produce
the same page at the same path, because the path was never a decision.

`/lint` already reports `file_name_not_id`. Under this proposal the rule holds
from `raw/` all the way to `wiki/`.

### Compendium sources

One note often describes many things — `raw/moments/all_moments_ordered.md` is
nine moments. That breaks 1:1, so it is handled explicitly rather than silently:

- A source whose stem matches no single primitive produces **many** pages, each
  recording `source: raw/moments/all_moments_ordered.md`.
- Ingest may **offer to split it**: propose nine `raw/moments/<id>.md` files and
  the deletion of the compendium, as diffs through the gate.

Splitting is recommended and never forced. A compendium is a fine way to think
and a poor way to store.

## Idempotency

The word is doing real work here. Re-running `/ingest` must converge, and must
be cheap enough to run habitually.

Every generated page records where it came from and what that source said:

```yaml
---
id: sebastian-weber
name: Sebastian Weber
source: raw/characters/sebastian-weber.md
source_hash: 9f2a1c…
---
```

Ingest then:

1. Hashes each source.
2. **Skips** any source whose hash matches what the corpus already records. No
   model call, no proposal, no diff.
3. Proposes only for sources that are new, changed, or gone.

A source that has not changed costs nothing. That is what makes it safe to run
`/ingest` after every writing session rather than as a ceremony.

::: tip This also fixes cost
A first ingest of nine kinds is many model calls. Every subsequent one is
proportional to what you actually edited.
:::

## Who owns which file

| Layer     | Written by              | Author edits?                   |
| --------- | ----------------------- | ------------------------------- |
| `raw/`    | You, and `/curator`\*   | Yes — this is the only one      |
| corpus    | `/ingest`, via the gate | No; edits are lost on re-ingest |
| `ledger/` | replay                  | No — enforced                   |
| `wiki/`   | `/wiki build`           | No — enforced                   |

\* `/curator` may propose raw corrections (D15) when the error is _in the
record_. That stays.

Corpus joins `ledger/` and `wiki/` as derived. `resolveInsideVault` gains it as
a forbidden prefix for everything except ingest's own batch, the same way
`allowRaw` works today (D15).

**This is the biggest loss in the proposal** and it should be stated plainly: you
can no longer hand-edit `characters/inanna.md`. The answer is that you edit
`raw/characters/inanna.md` instead and re-ingest — but for anyone used to
tweaking a corpus page directly, that is a real change in feel.

## What happens to the linking commands

`/situation sit-001 cast carl` writes typed frontmatter. Under a derived corpus
that edit dies at the next ingest, so the commands have to move.

**They edit raw frontmatter instead.** A raw file may carry optional
frontmatter, which ingest treats as authoritative:

```yaml
---
moment: inannas-first-memory
cast: [inanna, linh-tran, sebastian-weber]
place: oz-farm
---
Inanna was woken suddenly, she could feel afraid and alarm like any
five-year-old would…
```

This is not new. Your notes already do it informally:

```
Moment: [[inanna-first-memory]]
Cast: [[inanna-tran-weber]], [[linh-tran]], [[sebastian-weber]]
```

Formalising it as YAML costs nothing and makes the assertion machine-readable.
Ingest merges: **author frontmatter wins, ingest fills the gaps.** So a link you
set by command or by hand survives every re-ingest, and one you never set is the
model's to infer.

## Commands

| Command                | Becomes                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `/init`                | Creates `raw/<kind>/` for all nine primitives, each with a README |
| `/<kind> new <name>`   | Creates `raw/<kind>/<slug>.md`, opens the buffer                  |
| `/<kind> <id> <verb>`  | Edits raw frontmatter                                             |
| `/<kind> <id> edit`    | Opens the raw file                                                |
| `/ingest [kind] [id]`  | Raw → corpus, skipping unchanged sources                          |
| `/wiki build`, `/lint` | Unchanged                                                         |

`/ingest` with no arguments becomes meaningful: sweep everything, skip what has
not changed.

## Migration

Existing vaults have an authored corpus with no `source:`. They must not break.

- A corpus page **without** `source:` is author-owned. Ingest never touches it.
- `/lint` reports it as `unadopted`, with the count and the command.
- `/ingest adopt [kind]` proposes, for each such page, a `raw/<kind>/<id>.md`
  written from it — then the page becomes ingest-owned on the next pass.

Adoption is per-kind and reviewable. A vault can sit half-adopted indefinitely.

## The schema layer

karpathy's third layer is a config document defining conventions. litfire's
equivalent is mostly code — the zod schemas — and that is deliberate: a schema
that is checked beats a schema that is described.

What it lacks is a place for the conventions _an author_ wants to steer:
preferred id style, what belongs in a place page versus a situation, house
vocabulary. Proposal: an optional `raw/CONVENTIONS.md`, appended to every ingest
instruction. Absent, nothing changes.

## Risks

| Risk                                        | Mitigation                                                          |
| ------------------------------------------- | ------------------------------------------------------------------- |
| Losing hand-editable corpus pages           | The stated cost. `/ingest adopt` and raw frontmatter soften it      |
| A first full ingest is expensive            | Hashing makes every later run proportional to real edits            |
| The model rewrites a page worse than it was | Every proposal is a diff you accept; unchanged sources never re-run |
| Author frontmatter and prose disagree       | Frontmatter wins, and the disagreement becomes an open question     |
| Compendium sources produce unstable ids     | Prefer 1:1; splitting is offered explicitly                         |

## Open questions

1. **Does the gate stay for every ingest?** P3 says nothing lands without an
   explicit decision. Idempotency makes the gate quiet, but a first adopt of 40
   pages is 40 diffs. Batch-accept per kind?
2. **Does `situations/` stay a corpus directory at all**, or do situations
   become raw-only, with the ledger reading raw directly? They are the one
   primitive that is mostly prose.
3. **`raw/interviews/` is not a primitive folder.** Transcripts already ingest
   via extraction. Do they stay a separate path, or become sources like any
   other?
4. **What owns `log.md`?** karpathy appends every ingest, query and lint. litfire
   has the file and barely writes it.

## Sequencing

1. `/init` scaffolds `raw/<kind>/`. Harmless on its own, and useful immediately.
2. `source:` and `source_hash` on ingested pages; skip unchanged. Idempotency
   before anything depends on it.
3. Raw frontmatter, and the linking commands move to it.
4. `/<kind> new` writes raw.
5. Corpus becomes forbidden to author writes; `/ingest adopt` lands with it.

Each step is useful alone and the order never requires backing up. Step 5 is the
irreversible one and should not be taken until 1–4 have been lived with.
