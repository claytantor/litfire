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

| Primitive     | Is                                   | Lives in             |
| ------------- | ------------------------------------ | -------------------- |
| **system**    | What tracks a character's stats      | `corpus/systems/`    |
| **moment**    | A point on the in-world clock        | `corpus/moments/`    |
| **arc**       | A span of narrative order            | `corpus/arcs/`       |
| **situation** | A scene                              | `corpus/situations/` |
| **place**     | Somewhere a scene happens            | `corpus/places/`     |
| **character** | A person the ledger tracks           | `corpus/characters/` |
| **faction**   | A group working toward a goal        | `corpus/factions/`   |
| **artifact**  | Something used to achieve an outcome | `corpus/artifacts/`  |
| **skill**     | Something a character can do         | `corpus/skills/`     |
| **theme**     | What the book argues about           | `corpus/themes/`     |
| **chapter**   | A cut in the replay sequence         | `corpus/chapters/`   |

**Items** have ids but no files of their own: they are named by ledger events,
and their wiki pages are built from every use. **Character state** is derived —
see below.

A **skill** is the one primitive with two legal homes. It can be a page like any
other, and it can also be a row in a system's `skills:` list — the shorthand
that was the only form until skills got pages of their own. Both work at once,
and the page wins where they disagree.

## One id, one file

A primitive lives at `<directory>/<id>.md`. The filename **is** the id, with
nothing appended — the name goes in the frontmatter.

That is not a convention the tool merely prefers. Two files declaring one id
resolve to whichever loads first, and the other becomes invisible while still on
disk, so `/lint` reports:

- **`file_name_not_id`** — a page whose filename does not match its id.
- **`legacy_location`** — a file in a layout litfire has moved on from. A
  situation in `corpus/situations/`, which was a second home for the same thing;
  the `corpus/systems/<id>.md` + `skills.md` + `curves.md` trio, which `corpus/systems/<id>.md`
  replaced; or `timeline/world-events.md`, from before moments were pages. All
  are still read, so no vault breaks — `/init` just stops creating them, and the
  finding names what now replaces each one.
- **`duplicate_id`** — two files declaring one id, named by path.
- **`stat_over_ceiling`** — a stat above the ceiling another stat holds for it.
  For a cap that rises with level, where a constant `max:` cannot express it.
- **`stat_unread`** — a screen shows what the system makes of a stat, and no
  bands say how it reads. The stat is there; nobody has said what it means.
- **`stat_unread`** — a screen shows what the system makes of a stat, and no
  bands say how it reads. The stat is there; nobody has said what it means.
- **`scaffold_unreplaced`** — pages `/init` wrote that you have not replaced.
  One finding with a count; it stops being true a page at a time.
- **`situation_unplaced`** — scenes on no arc. A valid permanent state, and also
  one that keeps them out of every replay, so nothing in them reaches the
  ledger. Reported once with a count rather than once per scene.

A situation with no `arc:` is unplaced. That is a normal, permanent state and it
is said once, in the frontmatter — not also by which directory the file sits in.

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
though `/curator` can propose removing one, and it reaches you as a diff
through the [review gate](../guide/review-gate.md).
