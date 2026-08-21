# The wiki

LitRPG readers build wikis ([genre reference](./litrpg.md) §4). `/wiki build` builds the
author's: one page per character, place, faction, skill, item, arc, and theme,
computed from the corpus **and** the replayed ledger — the reference you cannot
hold in your head.

```
Carl
  Currently level 1, xp 300.
  Level and XP trajectory
  | step    | level | xp  |
  | seed    | 1     | 0   |
  | sit-901 | 1     | 300 |
```

Derived in the same sense `ledger/state.md` is: regenerated wholesale, never
hand-edited, never the source of truth for a fact it states. `wiki/` is in
`FORBIDDEN_PREFIXES`, so no model proposal can write there.

## What extraction writes

The interviewer is told to start with meaning and reach mechanics late, so most
transcripts are mostly meaning — what the System costs, what it forbids, who can
see it, what breaks it. **That has to have somewhere to land.**

For a while it did not. The extractor's targets were `stats.md`, `skills.md`,
`curves.md`, and `formulas.md`, so an interview establishing that levelling
costs memory, that only the indebted see the numbers, and that debt can be
transferred without consent produced **zero writes** — none of it is a stat, a
skill, a curve, or a formula. The two halves of one feature disagreed: the
interviewer asked for meaning and the extractor could only record mechanics.

`setting/setting.md` is now the primary target for `/system`. Its body is the
prose record of the System — purpose, cost, ceiling, exploit, who sees it, who
runs it — and its frontmatter carries the three descriptors the base brief
interviews for (`system_origin`, `system_visibility`, `system_agency`). Arc
files likewise get a body for what the arc is _about_. The extractor is told
plainly that returning nothing because nothing was numeric throws the author's
work away, and told not to invent mechanics to fill a schema.

It is also told to preserve the existing `idiom` value, since a whole-file
rewrite of `setting/setting.md` would otherwise reset the vault's vocabulary.

## And the wiki has to show it

Writing prose to disk is only half the trip. The derived pages read the author's
own body from the corpus file they annotate — `setting/setting.md`,
`corpus/characters/<id>.md`, `corpus/arcs/<id>.md`, `corpus/themes/<id>.md` — and put it
above the computed sections under a `## From <path>` heading.

That was missing at first, and it produced the same symptom one layer along: an
interview landed correctly on disk and still appeared nowhere, because the
System page read only that file's frontmatter. Computed facts are the
_annotation_; what the author established is the page.

## At a glance

Every page `/ingest` proposes carries a generated summary at the top — the two
or three things a reader wants before the prose:

```markdown
<!-- litrpg:summary -->

**Wants** — to be believed, and cannot say so out loud.
**Leverage** — her brother, who does not know he has any.
<!-- /litrpg:summary -->
```

What those points are depends on the kind, and they mirror what that kind's
interview presses hardest on — the brief asks the question, the summary records
the answer. A character's are what they want and who has leverage over them; a
faction's are what they say they want against what they do instead; an
artifact's are what it achieves and what using it costs.

In the wiki the block is lifted out and rendered as its own **At a glance**
section above the prose, with the markers stripped. A block of HTML comments
buried mid-paragraph is exactly as useful as no summary at all.

Three things follow from it being a generated region:

- **It is regenerated whole on every ingest**, and nothing outside the markers
  is touched. Your prose in the same file is safe.
- **`/reviewer` cannot edit it.** The structural guard compares generated
  regions before and after and refuses a proposal that changed one — a
  spelling pass has no business rewriting a summary.
- **A point the notes do not answer is left out.** Not guessed, not hedged, and
  not written as "unknown". A missing line is the correct output for something
  you have not decided, and `/questions` is where it surfaces instead.

## When an interview produces nothing

The interview → extraction → review → disk chain can end without writing in
three legitimate ways: extraction fails, the model proposes nothing, or the
author cancels the gate. All three used to be silent — the transcript sat in
`raw/interviews/` holding real answers while the corpus stayed unchanged.

`/lint` and `/wiki build` now say so, first thing:

```
interviews that produced nothing
  system — 5 exchanges saved, but nothing under setting/ or
           corpus/systems/ has changed since
    /ingest interview files it, through the same review gate
```

**The signal is timestamps, not emptiness.** `/init` seeds `corpus/systems/<id>.md`
from the profile's archetype stats, so "the corpus is empty" is never true in a
scaffolded vault and a check built on it would never fire for anybody. What is
true is that a successful extraction writes its target _after_ the interview
that produced it, so a transcript newer than everything its kind writes to is an
interview that went nowhere.

`/ingest interview` reads the saved transcript and sends proposals to the
review gate — the interview half is skipped, since the answers already exist. A
transcript is a source like any other, and it is the only one that can touch
several kinds at once: a system interview establishes a system, and names three
characters and a turning point on the way. The transcript is never rewritten, so
a failed pass costs nothing and can be run again. It is deliberately not part of `/wiki build`:
that command regenerates derived files and stays free, offline, and
deterministic.

`/system show` renders the System as it currently stands. Bare `/system` starts
an interview, which left no way to see what one produced.

## The agents read it too

The computed cross-reference is appended to the existing grounding for the
interviews and `/reviewer` — **added, never substituted**. The corpus carries the
author's own words and a summary must not stand in for how they actually wrote a
scene; what the wiki adds is the half prose cannot say, like which step a skill
was acquired at. It is budgeted separately from the corpus so neither category
can crowd out the other, and it states how many entries were withheld, because
an agent that believes it has seen the whole cast will assert things about a
character it was never shown.

## Serving it

`/wiki serve` runs `wiki/serve.mjs` in a worker thread. That script is written
into the vault by `/wiki build`, and it is the **only** server implementation —
what litfire runs and what you run by hand are the same file:

```bash
node wiki/serve.mjs 7392          # loopback, like /wiki serve
node wiki/serve.mjs 7392 lan      # every interface
```

`/wiki serve [port] [lan|<addr>]` takes its two arguments in either order —
whichever is all digits is the port, anything else names an interface. `lan`,
`all`, `any`, and `0.0.0.0` are synonyms; a literal address binds just that one.

It is standalone on `node:` builtins plus `marked`, whose absolute path is baked
in when the script is written (a vault has no `node_modules`). Everything is read
off disk per request, so after a `/wiki build` — or a hand edit in Obsidian — a
browser refresh is all it takes. Nothing is cached or pre-rendered.

The worker is tied to the session: `/wiki stop`, a project switch, and `/quit`
all take it down, so no orphan is left holding a port.

**Security**, because this serves an unpublished manuscript:

- **Loopback by default; every interface only when asked.** `/wiki serve lan`
  binds `0.0.0.0`, which puts the vault in reach of anything on the network with
  no password and no auth. That is a real change in who can read an unpublished
  manuscript, so it is opt-in, stated plainly in the output, and never the
  default. The reported URL is then the machine's actual LAN address, because
  `http://0.0.0.0:7391` is not a link another device can use.
- **Canonical path containment, decoded before validation.** The WHATWG URL
  parser collapses a literal `..` on its own but leaves `%2e%2e%2f` alone, so
  the two spellings would otherwise take different routes; the query is stripped
  and the path decoded by hand so both hit the same check. Both return 403.
- **`.md` files only**, and raw HTML in author markdown is escaped rather than
  passed to the browser — corpus text can be pasted from anywhere.
