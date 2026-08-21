# Creating primitives

A primitive is one of the ten kinds of thing a vault holds. Each has a folder
under `raw/` where you write about it, and a matching folder under `corpus/`
where the typed page ends up.

| Kind          | Is                                     | You write in      |
| ------------- | -------------------------------------- | ----------------- |
| **system**    | The rules a character is tracked by    | `raw/systems/`    |
| **character** | A person the ledger tracks             | `raw/characters/` |
| **moment**    | A point where the world's terms change | `raw/moments/`    |
| **arc**       | The span between two moments           | `raw/arcs/`       |
| **place**     | Somewhere a scene happens              | `raw/places/`     |
| **situation** | A scene                                | `raw/situations/` |
| **faction**   | A group working toward a goal          | `raw/factions/`   |
| **artifact**  | A thing used to achieve an outcome     | `raw/artifacts/`  |
| **theme**     | What the book argues about             | `raw/themes/`     |
| **chapter**   | A cut in the sequence, for a reader    | `raw/chapters/`   |

## Three ways to make one

### 1. Write the file

The most direct, and the one Obsidian is for.

```
raw/factions/the-sufi.md
```

Freeform. No frontmatter needed, no format to learn. Then:

```
/ingest faction
```

It reads every note in `raw/factions/`, skips the ones it has already seen
unchanged, and proposes a typed page for the rest. You accept the diffs.

::: tip The filename is the id
`raw/factions/the-sufi.md` becomes the faction `the-sufi`. Name the file after
the thing, in lowercase with hyphens, and nothing else — no title, no date, no
number. That is what lets everything else refer to it.
:::

### 2. Ask the tool for one

```
/place new Oz Farm
/moment new The Breach
/situation new The Ledger Room
/arc new The Long Descent
```

Scaffolds the file and, for the kinds with a body worth writing, opens
[the native buffer](./writing-a-scene.md) on it. The id is slugged from the
title you gave: `Oz Farm` becomes `oz-farm`.

::: warning `new` still writes the derived page
`/place new` currently creates `corpus/places/oz-farm.md` rather than the note
in `raw/`. Everything that _edits_ it afterwards adopts it into `raw/` on the
first touch, so this resolves itself the moment you change anything — but it is
the one place the tool does not yet do what this guide says it does, and it is
being fixed. If it matters to you, write the file yourself (method 1).
:::

### 3. Be interviewed

```
/questions faction
/questions place oz-farm
```

An interview about that kind, opening on whatever the deterministic checks have
found unresolved — so it starts where your vault is actually thin rather than
from a generic script. Answers are saved to `raw/interviews/` as you go, and:

```
/ingest interview
```

files what you said across every kind the conversation touched. One system
interview will often establish a system, three characters and a turning point,
and each goes where it belongs.

See [Interviews](./interviews.md) for how a session runs, and what `/done`,
`/skip` and `esc` do.

## Linking them together

Making a primitive is half of it. A vault can hold characters, places, moments
and artifacts and still produce an almost empty wiki, because **a situation is
what ties them together**: a place has a page because a scene happens there, a
character's appearances _are_ the scenes they are cast in.

```
/situation sit-001 cast linh-tran sebastian-weber
/situation sit-001 place oz-farm
/situation sit-001 moment inannas-first-memory
/situation sit-001 arc arc-01
```

Each of these edits your note in `raw/situations/sit-001.md` and carries the
change onto the derived page. [Populating a situation](./populating-a-situation.md)
walks through the whole set and the order they want to be done in.

## Editing one you already have

```
/moment the-breach at 2036-08-15      set a typed field
/place oz-farm name The Farm          rename it
/situation sit-001 edit               open the prose in the buffer
```

All of these write your copy in `raw/`, adopting the page there if that is where
it is not yet:

```
adopted into raw/moments/the-breach.md — your copy lives there now
```

You see that line once, the first time a given page moves. After that it is
simply where the thing lives.

## Seeing what you have

```
/primitives              every id in the vault, grouped by kind
/primitives character    just one kind
/lint                    what the deterministic checks found
/questions               everything unresolved, as questions
```

`/questions` is worth running when you are not sure what to work on. It lists
the things the tool has noticed and is not allowed to decide for you — a faction
with no goal, a moment with no position on the clock, a scene naming someone who
has no page. None of it blocks writing; it is a list of decisions waiting for
you, and `/questions <kind>` will interview you about any of them.

## What a page must never be

**Two files with one id.** The filename is the id, so two files claiming the
same one is two things pretending to be one thing, and everything that resolves
it silently picks whichever loaded first. `/lint` reports it as `duplicate_id`
and names both paths. Rename or delete one; the tool will not choose for you.

**Invented.** Nothing in litfire will make up a proper noun, a number or a date
on your behalf. If an interview does not know when something happened, it leaves
`at:` out and the checks report the moment as undated — which is a normal state
to be in, and a great deal better than a plausible wrong date sitting in your
ledger being computed with.
