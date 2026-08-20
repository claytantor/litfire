# Moments

A moment is a point on the in-world clock where the terms of the world change —
not a scene, but a turning point scenes hang off. It is the
[primitive](../concepts/primitives.md) that gives everything else a position in
time.

```
/moment new The Substrate Patch
```

Slugs the name into an id, writes `timeline/moments/the-substrate-patch.md`, and
opens the [buffer](./writing-a-scene.md) so you can describe what changes there.

It starts **undated** on purpose. A moment you have just thought of usually has
no date yet, and demanding one at creation would either block the thought or
make you invent a number.

| Form                       | Does                                    |
| -------------------------- | --------------------------------------- |
| `/moment`                  | Every moment, dated ones in clock order |
| `/moment <id>`             | One moment, and what hangs off it       |
| `/moment <id> at <when>`   | Set or change its time                  |
| `/moment <id> edit`        | Write its description                   |
| `/moment <id> name <text>` | Rename it                               |
| `/moment new <name>`       | Create one, and open the buffer         |

The verb may come before or after the id.

## Putting one on the clock

```
/moment the-substrate-patch at -26174880000000123
/moment inannas-first-memory at 2036-08-15 02:30:00
```

`at` takes either notation — whole seconds, or a date the bound calendar reads —
and reports back what it understood, so a misread date is visible immediately
rather than three commands later:

```
inannas-first-memory at 157,791,420
reads as 2036-08-15 02:30:00 · ~5 years from origin
```

Dates need a calendar. Until one is bound, a time has to be whole seconds and
the tool says so; see [the in-world clock](../reference/time.md) for binding
Earth/Sol time or writing your own calendar.

Changing the time never touches the description, and renaming never touches the
time: every verb rewrites frontmatter and writes the body back byte-identical.

## Undated moments are real

A moment with no `at` is **recorded but not placed**. It does not enter the
replay sequence, so nothing it carries reaches the ledger, and a scene anchored
to it still has no clock position.

That is a valid permanent state, not an error. An author often knows a thing
happened long before knowing when. `/moment` lists them separately and `/lint`
reports them, so they are never silently inert.

## What hangs off a moment

```
/moment the-substrate-patch
```

Shows its time three ways, what it changes in the ledger, and the two things
that point at it:

- **Scenes anchored here** — situations with `moment: the-substrate-patch`.
- **Arcs starting after it** — arcs with `starts_after: the-substrate-patch`.

Both are listed because re-dating or removing a moment moves everything hanging
off it, and that should never be a surprise.

The arc link is the load-bearing one and the easiest to miss: an arc with no
`starts_after` replays with every moment flushed to the end of the sequence, so
its situations have nothing on the clock before them and every character state
in them reads as unplaced. If your cast shows no state, this is almost always
why — see [populating a situation](./populating-a-situation.md).

## Where they come from

Besides `/moment new`, moments arrive from the [timeline
interview](./interviews.md), which draws out the turning points by asking what
becomes possible that was not before. Extraction writes them as pages, and
spillover creates one when another interview mentions an event in passing.

A moment created by spillover is marked `stub: true` and undated — it is a note
that something exists, not a claim about when.
