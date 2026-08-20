# Primitives

A vault is made of primitives: the things that have an **id**. The id is the
filename stem, the wikilink target, and what every cross-reference in
frontmatter resolves against. `/primitives` lists all of them.

Everything else — the ledger, the wiki, the manuscript — is derived from these
and regenerated. These files are the vault.

## The map

```
                    timeline/time.md ── how seconds are read
                            │
   moment ─────────────┬────┴──────────── arc
   (a point on         │  starts_after    (narrative order)
    the clock)         │                       │
                       │ moment:               │ arc:
                       └──────► situation ◄────┘
                                 (a scene)
                                    │
              ┌──────────┬──────────┼──────────┬──────────┐
              │ place:   │characters│ themes:  │ events:   │
              ▼          ▼          ▼          ▼           │
            place    character    theme     ledger ────────┘
                         │                    │
                    system: │            artifact, skill, item
                         ▼
                      system
```

**The situation is the hub.** A place has a wiki page partly because a scene
happens there, a character's appearances _are_ the scenes they are cast in, and
a moment's scenes are the ones anchored to it. A vault full of characters and
places with no situations produces an almost empty wiki — see
[populating a situation](../guide/populating-a-situation.md).

## What each one is

| Primitive     | Is                                   | Lives in            |
| ------------- | ------------------------------------ | ------------------- |
| **system**    | What tracks a character's stats      | `systems/`          |
| **moment**    | A point on the in-world clock        | `timeline/moments/` |
| **arc**       | A span of narrative order            | `timeline/arcs/`    |
| **situation** | A scene                              | `situations/`       |
| **place**     | Somewhere a scene happens            | `places/`           |
| **character** | A person the ledger tracks           | `characters/`       |
| **faction**   | A group working toward a goal        | `factions/`         |
| **artifact**  | Something used to achieve an outcome | `artifacts/`        |
| **theme**     | What the book argues about           | `themes/`           |

Two more have ids but no files of their own. **Skills** and **items** are
declared by a system or named by ledger events, and their wiki pages are built
from every use. **Character state** is derived — see below.

## Fields

Only `id` is required anywhere. Everything optional is genuinely optional: a
primitive an interview has established but not finished is a normal state, and
the checks ask about the gaps rather than refusing the file.

| Primitive     | Fields                                                                     |
| ------------- | -------------------------------------------------------------------------- |
| **system**    | `id` `name` `stats` `skills` `curves`                                      |
| **moment**    | `id` `name` `at` `events`                                                  |
| **arc**       | `id` `name` `order` `starts_after` `ends_before` `milestone`               |
| **situation** | `id` `title` `arc` `order` `moment` `characters` `place` `themes` `events` |
| **place**     | `id` `name`                                                                |
| **character** | `id` `name` `level` `xp` `stats` `skills` `items` `artifacts` `system`     |
| **faction**   | `id` `name` `goal` `members`                                               |
| **artifact**  | `id` `name` `kind` `outcome` `requires_skills` `requires_level`            |
| **theme**     | `id` `name` `subthemes`                                                    |

Every one also carries `stub`, set when spillover created the page from another
interview's answer rather than from an interview about it.

**Place is deliberately the thinnest.** What a room is like is writing, not
data, and no field was going to capture it — so a place is an id, a name, and
prose.

## Commands

Every primitive with a command follows the same shape: the verb may come before
or after the id, and `new` leads because everything after it is free text.

| Command                                         | Does                             |
| ----------------------------------------------- | -------------------------------- |
| `/primitives [kind]`                            | Every id in the vault, grouped   |
| [`/moment`](../guide/moments.md)                | Points on the clock              |
| [`/place`](../guide/places.md)                  | Somewhere scenes happen          |
| `/situation`                                    | Scenes, and everything they link |
| `/arc`                                          | Narrative order                  |
| `/character`, `/system`, `/themes`, `/timeline` | Interviews that produce them     |

Characters, factions, artifacts and themes arrive from
[interviews](../guide/interviews.md) and extraction rather than from a create
command — they are drawn out by being asked about, which produces a better
world than a form does.

## Derived, not authored

Some things have ids and no files, because they are computed:

- **Character state** — one character at one moment, addressed as
  `character@moment`, with the stats, skills, items and artifacts they hold
  there. Replayed from the ledger; `/primitives state` lists them.
- **The ledger** — every character's state over the whole sequence.
- **The wiki** and **`manuscript.md`** — regenerated, never edited.

Derived state is an output. Editing it is always the wrong move: the next
recompute overwrites it, and `resolveInsideVault` refuses proposals that name
`ledger/`, `wiki/` or `raw/` at all.

## When two pages are one thing

Corpus is generated, and generation makes duplicates — extraction run twice over
one interview can slug the same event two ways. `/lint` reports both cases:

- **`duplicate_id`** — two pages declaring one id. Everything that resolves it
  sees only one; the other is invisible while still on disk.
- **`duplicate_name`** — different ids, one name. The case that actually
  happens, which no id check would catch.

Neither is resolved for you. Which page is the real one is an author's call —
though `/architect` can propose removing one, and it reaches you as a diff
through the [review gate](../guide/review-gate.md).
