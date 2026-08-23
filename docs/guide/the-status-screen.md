# Drawing your status screen

Every LitRPG has a moment where a character sees their own numbers. What that
looks like is a decision about your world — a brass-edged panel, a cracked
overlay, a voice reading a list — and litfire used to make it for you: the genre
profile picked one of three built-in layouts and that was that.

Now you draw it. Put an `interface` block in your system's note and it becomes
the screen every character under that system is shown.

## A first one

Say your system is called `core`, with the usual suspects on it.

````markdown
```interface
╔══════════════════════════════════════╗
║  {name}                    Lv {level} ║
║                                      ║
║  HP    {hp} / {max-hp}               ║
║  MP    {mp} / {max-mp}               ║
║                                      ║
║  STR {str}   DEX {dex}   INT {int}   ║
║                                      ║
║  Skills: {skills}                    ║
╚══════════════════════════════════════╝
```
````

Anything in `{curly braces}` is filled in for the character being shown.
Everything else is yours and is reproduced exactly — every space, every box
character. Whitespace is content here, and nothing tidies it.

For a character with 34 of 50 HP, that renders:

```
╔══════════════════════════════════════╗
║  Carl                        Lv 4    ║
║                                      ║
║  HP    34 / 50                       ║
║  MP    12 / 20                       ║
║                                      ║
║  STR 14   DEX 9   INT 11             ║
║                                      ║
║  Skills: parry, second-wind          ║
╚══════════════════════════════════════╝
```

::: tip Your alignment will drift, and that is fine
Values have different widths — `9` and `14` are not the same size — so a column
lined up for one character will be a space out for another. Pad in the drawing
where it matters, and accept that a status screen in a novel is prose, not a
table.
:::

## What you can put in braces

**Any stat your system declares**, by its id: `{hp}`, `{str}`, `{max-mp}`.

**Four built-in fields**, which are not stats:

| Field      | Is                                             |
| ---------- | ---------------------------------------------- |
| `{name}`   | The character's name                           |
| `{level}`  | Their level                                    |
| `{xp}`     | Their total XP                                 |
| `{skills}` | Their skills, comma-separated, or `—` for none |

Ids are lowercase and hyphenated — `max-hp`, not `maxHP` or `max_hp` — because
that is what every id in a vault looks like.

## Substitution, and only substitution

A placeholder becomes a value. There are no bars, no percentages, no
conditionals, no formatting.

That is a deliberate limit, and it has a real cost worth knowing before you
design around it. If you draw a bar:

```
HP  ▓▓▓▓▓▓░░░░  {hp}/{max-hp}
```

…those blocks never move. They look the same at 5 HP and at 50, which is worse
than not drawing them, because they look like information. **Say it in numbers
instead** — `34 / 50` is honest and changes as the story does.

The alternative was a small template language, with widths and glyphs and
rounding to learn, document and get wrong. A screen you draw and read literally
is worth more than one you have to debug.

## Where the block goes

**In `raw/systems/<id>.md`** — your own note, the layer you write.

The page under `corpus/` is rebuilt from that note whenever you run
`/ingest system`, so a screen drawn only in the corpus page would eventually be
replaced. Drawn in the note, it is carried onto the page every time, byte for
byte — ingest is explicitly told to reproduce it and never to tidy it.

If you edit through the tool, this happens on its own:

```
/system core edit
```

opens your note, copying it out of the corpus first if that is where it still
lives.

## The screen is a specification

This is the part that does more than it looks.

A placeholder is a claim that something exists. If you draw `{stamina}` and your
system declares no such stat, litfire says so:

```
› /questions

open questions (1)
oq-001  interface_field_unknown
        'core' draws {stamina} on its status screen, and declares no such stat
        at core
```

And on the screen itself, the placeholder is left standing rather than blanked:

```
║  STAMINA  {stamina}                  ║
```

Both halves say the same thing, which is deliberate — a blank would be
indistinguishable from a zero.

So you can design the screen first and let the stats follow. That is exactly
what `/system generate stats` is for: it reads the screen you drew and proposes
the stats it needs, with a formula for each one that is computed rather than
accumulated, and a worked table so you can judge whether the numbers behave.

```
/system core generate stats
```

## Where it shows up

| Command                      | Shows                                               |
| ---------------------------- | --------------------------------------------------- |
| `/status <character>`        | That character's screen, now                        |
| `/status <character> <at>`   | Their screen at a point in the sequence             |
| `/status write <char> <sit>` | Writes the screen into a scene, as a marked block   |
| `/situation <id> sheet`      | **Every character in the scene**, each on their own |

The last one is the one to reach for while writing. `/sheet carl` asks what the
ledger holds about Carl; `/situation sit-004 sheet` asks what everyone standing
in that room would see — which is the question you actually have with the scene
open.

A character whose system draws no screen falls back to the profile's built-in
layout, so a vault renders something before anyone has drawn anything.

## Making the numbers move

A screen is a window onto state. If nothing changes the state, the window shows
the same thing forever — and litfire will tell you so:

```
system_stats_inert: system 'core' declares 6 stat(s) that nothing changes
and none derives — every sheet under it shows defaults
```

### Where a character starts

Before anything moves, a number has to begin somewhere. Two levers, and they do
different jobs:

```
/character carl stat hp 50      # this person starts here
/character carl level 3
```

```yaml
# corpus/systems/core.md — everyone under it starts here
stats:
  - id: hp
    default: 20
```

Replay seeds each stat from the character's own page and falls back to the
system's `default`. Set neither and every stat begins at **0**, which is how a
vault ends up with a status screen that is real, correct, and entirely blank.

### Two things move a number, and you need at least one:

**Events in scenes**, which are what happened:

```yaml
events:
  - {actor: carl, type: stat, stat: hp, delta: -12, note: the stairs}
```

**Formulas**, for anything that follows from the rest:

````markdown
```js id=max-hp
({con, level}) => 50 + con * 8 + level * 12;
```
````

```yaml
stats:
  - id: max-hp
    name: Max HP
    formula: max-hp # ← computed after every scene
```

The tool will write formulas for you. It will never write events — what happens
in a scene is the story, and that is yours.

### Showing a ceiling

A screen that wants `7/10` has two ways to get the 10.

**Write it into the drawing** when it never changes:

```
HP  {hp}/10
```

A stat's `max:` lives in frontmatter and the screen cannot read it, so a fixed
ceiling belongs in the drawing as plain text. A number that never changes is
not state.

**Make it a derived stat** when it does change — which is usually the
interesting case, because a ceiling that rises with level is how a character
grows into a system:

````markdown
```js id=hp-cap
({level}) => 40 + level * 10;
```
````

```yaml
stats:
  - id: hp-cap
    formula: hp-cap
```

```
HP  {hp}/{hp-cap}
```

Now the ceiling moves as they level, and `/system generate stats` will propose
exactly this shape when your screen shows one placeholder over another.

## A worked example, start to finish

```
/system core edit               # draw the block in your note
/ingest system                  # carry it onto the page
/questions                      # every stat the screen names but you lack
/system core generate stats     # propose those stats, with formulas and tables
/consent                        # formulas are sandboxed and hash-gated
/situation sit-001 sheet        # see the scene through it
```

Between steps three and four, decide which stats are **moved by scenes** and
which are **computed**. `hp` goes down because something hit you; `max-hp`
follows from constitution and level. Generation will guess at the split, and
you are better at it than it is.
