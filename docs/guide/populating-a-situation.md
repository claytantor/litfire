# Populating a situation

A situation is the hub. Almost everything in the wiki hangs off what a scene
names: a place has a page **because a situation happens there**, a character's
appearances **are** the scenes they are cast in, and a moment's scenes are the
ones anchored to it.

That has a consequence worth stating up front, because it surprises people: a
vault can hold characters, places, moments and artifacts and still produce an
almost empty wiki, if no situation links them together. Writing scenes is what
populates the world.

## The five links

A fully populated situation carries five things. Four are links to something
else; the fifth is the prose, which is yours.

| Link      | Frontmatter   | Set with                          | Without it                                    |
| --------- | ------------- | --------------------------------- | --------------------------------------------- |
| Narrative | `arc:`        | `/situation <id> arc <arc>`       | Unplaced — contributes no state to replay     |
| Clock     | `moment:`     | `/situation <id> moment <moment>` | Character states are unplaced                 |
| Location  | `place:`      | `/situation <id> place <place>`   | No place page in the wiki                     |
| Cast      | `characters:` | `/situation <id> cast <name>…`    | Nobody appears in it; no character back-links |
| The scene | the body      | `/situation <id> edit`            | An empty page                                 |

Every verb takes the id on either side, so `/situation sit-002 cast carl` and
`/situation cast sit-002 carl` are the same command.

## The order that works

The dependencies run one way, so this order never makes you back up.

### 1. A moment to hang the clock on

```
/moment new The Breach
/moment the-breach at 2036-08-15 02:30:00
```

`/moment new` opens the buffer so you can describe what changes there; `at`
takes whole seconds or a date, once a calendar is bound. The timeline interview
produces them too:

```
/timeline interview
```

`/moment` lists what exists. See [the in-world clock](../reference/time.md) for
the calendar and the units.

::: tip Undated moments are real
A moment with no `at:` is recorded but not placed. It will not enter the replay
sequence, so a scene anchored to it still has no clock position. That is not a
bug — an author often knows a thing happened before knowing when.
:::

### 2. An arc, anchored to that moment

```
/arc new The Long Descent
/arc arc-02 after the-breach
```

`/arc` alone lists every arc with its order, anchor, and how many scenes it
holds. `/arc <id>` shows one.

**`after` is the load-bearing step, and the easiest to skip.** An arc with no
`starts_after` replays with every moment flushed to the end of the sequence,
which means its situations have nothing on the clock before them — and every
character state in them reads as unplaced. If your cast shows no state, this is
almost always why.

### 3. The scene

```
/situation new The Ledger Room
```

Scaffolds `situations/inbox/` and opens the [native buffer](./writing-a-scene.md)
so you can write. Scenes start in the inbox: an unplaced situation is a valid
permanent state, not a staging error.

### 3b. Somewhere for it to happen

```
/place new The Ledger Room
```

Writes `places/the-ledger-room.md` and opens the buffer. Places are almost all
prose — what a room is like is writing, not data — so the schema is only an id
and a name.

`/place` lists everywhere, and tells the two kinds of unfinished apart: a page
with no scene is somewhere you have built and not yet used; a scene naming
somewhere with no page is the reverse. Both get a wiki page, and both are
legitimate.

### 4. Link it

```
/situation sit-002 arc arc-02          # moves it out of the inbox
/situation sit-002 moment the-breach   # anchors it on the clock
/situation sit-002 place the-atrium    # where it happens
/situation sit-002 cast carl donut     # who is in it
```

`cast` adds rather than replaces, so you can build a cast up over several
passes.

Naming something that does not exist yet is handled two different ways, on
purpose:

- **A moment or an arc must exist.** They carry structure — an arc decides
  replay order, a moment decides the clock — so a typo would silently move the
  scene somewhere you did not mean. The command refuses and tells you what
  creates one.
- **A place or a character need not.** A place has no schema at all, and naming
  someone before writing their page is a normal order to work in. The link is
  made, a note says the page is missing, and `/lint` keeps asking.

### 5. Check it

```
/situation sit-002
```

Shows the cast: the shared moment, then each character's stats and artifacts
laid out separately. This is the view to write from — what makes a scene
writable is seeing that one of them has the artifact and the other does not.

```
/wiki build
/wiki serve
```

`wiki/situations/sit-002.md` now exists, and the scene's own prose appears on
it. So do the place and arc pages, which exist because this scene named them.

## Character state

"A character with state" is not something you set on the situation. State is
**derived** — replayed from the events in the sequence up to that point — and a
character state is one character at one moment, addressed as
`character@moment`. `/primitives state` lists them all.

For a cast member to have state, three things must hold:

1. **They have a character page** — `characters/<id>.md`. Casting someone
   without one links fine and reports the gap.
2. **They are under a system** — `system:` on their page, or the vault has
   exactly one system and they resolve into it implicitly.
3. **The scene sits on the clock** — via steps 1 and 2 above. Otherwise their
   state exists but is unplaced.

What _changes_ state is ledger events on the situation: `xp`, `stat`,
`acquire_skill`, `acquire_artifact`, `use_artifact`, and the rest. Those are
written by extraction from an interview, or by hand in the scene's frontmatter.
The buffer deliberately cannot touch them — it edits the body only.

```
/sheet carl the-breach     # state at that moment
/status carl the-breach    # the same, as an in-world block
```

## When the wiki looks empty

| Symptom                             | Cause                                         |
| ----------------------------------- | --------------------------------------------- |
| No place pages                      | No situation names a `place:`                 |
| No arc pages                        | No arcs exist — `/arc new` creates one        |
| No situation pages                  | No situations exist                           |
| Cast shows "no state at this point" | The character has no page, or no system       |
| Scene reads "unplaced"              | No arc, or the arc has no `starts_after`      |
| Character has no appearances        | They are not in any situation's `characters:` |

Each situation page lists what it is still missing under **Not linked yet**,
with the command that fixes it. A scene that names nothing renders as a page
saying so, rather than a tidy stub that looks finished.

## The whole thing, once

```
/timeline interview                     # produce moments
/arc new The Long Descent
/arc arc-02 after the-breach
/situation new The Ledger Room          # opens the buffer; write the scene
/situation sit-002 arc arc-02
/situation sit-002 moment the-breach
/situation sit-002 place the-atrium
/situation sit-002 cast carl donut
/situation sit-002                      # read the cast back
/wiki build
```
