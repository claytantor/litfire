# litfire

[![check](https://github.com/claytantor/litfire/actions/workflows/ci.yml/badge.svg)](https://github.com/claytantor/litfire/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

A LitRPG authoring tool. The author writes freeform situations; the tool tracks
game state deterministically and records contradictions as open questions that
never block writing.

The bet, from the requirements: **a large fraction of LitRPG consistency is
arithmetic, not judgment.** Levels, XP, stat derivations, and skill prerequisites
are checkable by code, so they are checked by code — not handed to a model and
hoped over.

Everything is markdown on disk. Obsidian is a first-class peer: open the vault at
any time, edit anything, and the TUI reflects it.

## Requirements

- Node.js >= 22 (Ink 7's floor; also the floor for `isolated-vm@6`)
- pnpm
- A C++ toolchain for `isolated-vm` (`g++`, `make`, `python3`)

## Getting started

```bash
pnpm install
pnpm dev              # current directory as the vault
pnpm dev ~/my-novel   # or point it somewhere
```

Then, in the TUI:

```
/init        scaffold the vault
/consent     allow this vault's formulas to execute
/sheet carl  see replayed state
```

## Commands

| Command                       | Behaviour                                        |
| ----------------------------- | ------------------------------------------------ |
| `/init [idiom] [path]`        | Scaffold a vault; asks the idiom if omitted      |
| `/project [path]`             | Switch vaults, or list recent ones               |
| `/consent`                    | Allow this vault's formulas to execute           |
| `/sheet <character> [at]`     | Replayed state, optionally at a point in the run |
| `/status <character> [at]`    | The same state as an in-world status block       |
| `/status write <char> <sit>`  | Place that block inside a situation              |
| `/pacing`                     | Planned vs actual level by arc                   |
| `/timeline`                   | Structural view; world events, arcs, inbox       |
| `/themes`                     | Leaf-level coverage with upward rollup           |
| `/<kind> show`                | What that interview has produced so far          |
| `/<kind> resume`              | Continue the saved interview                     |
| `/<kind> extract`             | Re-run extraction over its saved transcript      |
| `/chapter [id\|new\|move]`    | Cut the sequence into chapters; show the seams   |
| `/export [path]`              | Assemble the chapters into a manuscript          |
| `/wiki [build\|serve\|stop]`  | Derived cross-reference, browsable over http     |
| `/editor`                     | Literary editor over the whole corpus            |
| `/lint`                       | Deterministic checks                             |
| `/questions`                  | Open question queue                              |
| `/provider`                   | Choose an LLM provider, key, and model           |
| `/provider status`            | Show configured providers and masked keys        |
| `/provider clear <id>`        | Remove a stored key                              |
| `/situation new [title]`      | Scaffold a situation and open `$EDITOR`          |
| `/situation place <id> <arc>` | Move a situation out of the inbox                |
| `/help`, `/quit`              |                                                  |

Output taller than the viewport opens a windowed pager (`↑↓`, space, `g`/`G`, `q`).

`↑`/`↓` in the composer walk command history, shell-style: back through what you
have run, forward again, and past the newest entry your half-typed line comes
back rather than an empty box. Consecutive duplicates collapse, so running
`/lint` four times costs one slot.

History lives in `.litrpg/history.json`, per vault — `/character carl` means
nothing in another book, so switching projects swaps the list rather than mixing
two manuscripts together. Deleting `.litrpg/` costs only convenience (DoD 11).

## Architecture

```
source/
  domain/schema.ts      zod schemas — the whole data model
  vault/                markdown I/O, layout, scaffold, generated-region markers
  system/               formula extraction + the isolated-vm sandbox
  ledger/               replay, deterministic checks, derived-file projections
  themes/coverage.ts    leaf-level coverage
  core/project.ts       load → replay → check → coverage
  llm/                  provider catalog, credentials, adapters
  commands/             command registry and views (plain data, not Ink nodes)
  components/           Ink: composer, footer, pager, line renderer
```

Replay is a pure function of `(system, timeline, situations)`. It recomputes in
full on every change — at novel scale that is milliseconds, and a pure function is
much easier to trust than a cache.

Command handlers return `Line[]` rather than Ink elements, so they are unit
testable without a renderer.

## The formula sandbox

`system/formulas.md` holds fenced `js` blocks with an id:

````markdown
```js id=xp-for-level
level => (level <= 10 ? 100 * level ** 2 : 150 * level ** 2);
```
````

These are author-supplied executable code, so they run in `isolated-vm` — a real
V8 isolate, not `node:vm`, which shares a heap with the host and is not a security
boundary.

- No `fetch`, `process`, `require`, or module loaders (absent from a fresh isolate).
- `Math.random`, `Date.now`, and `Date` are **explicitly removed** — they exist in a
  fresh isolate and would break deterministic replay. A formula touching them throws.
- 100 ms CPU timeout, 16 MB memory cap, enforced per call.
- Formulas are hashed. Opening a vault you did not create leaves them disabled
  until you run `/consent`, because a shared corpus is executable code.

Everything except the formula curve works with formulas disabled.

## Model providers

`/provider` walks you through selecting a provider, entering a key, verifying the
connection, and picking a model from the list that provider returns.

Keys resolve in this order, and `/provider status` always names the winner:

1. the env var itself, e.g. `KIMI_CODE_API_KEY`
2. the file it names, e.g. `KIMI_CODE_API_KEY_FILE=~/.local/secrets/kimi-api-key`
3. the key stored by `/provider`, in `~/.config/litfire/credentials.json` (0600)

Every provider's env var has a `…_FILE` companion. The secret then never enters
the environment, never reaches shell history, and never shows up in `ps` — and
rotating the file is enough, because it is read fresh on every resolve. A leading
`~` is expanded, since a value set in a config file never passes through a shell.
A path that cannot be read is reported rather than silently treated as no key,
and a key file readable by other users earns a `chmod 600` nudge.

| Provider            | API                         | Env var             |
| ------------------- | --------------------------- | ------------------- |
| Anthropic Claude    | Messages API (official SDK) | `ANTHROPIC_API_KEY` |
| OpenAI              | OpenAI chat completions     | `OPENAI_API_KEY`    |
| Together AI         | OpenAI-compatible           | `TOGETHER_API_KEY`  |
| Kimi (Moonshot)     | OpenAI-compatible           | `MOONSHOT_API_KEY`  |
| Kimi Code (kimi.ai) | OpenAI-compatible           | `KIMI_CODE_API_KEY` |

## Artifacts

An _artifact_ is something a character uses to achieve an outcome. Under an
arcane idiom that is a spell, a suit of armour, a relic; under a technological
one it is an M1A rifle, a mass spectrometer, an iPad. The engine holds none of
that vocabulary — the profile lexicon supplies the word (`relic`, `device`),
exactly as it already does for `ability`.

```
artifacts/
  m1a-rifle.md      id, name, kind, outcome, requires_skills, requires_level
characters/
  inanna.md         artifacts: [m1a-rifle]      ← where she starts
```

A character may carry many, so ownership lives in the ledger rather than on the
page: `artifacts:` is where they start, and `acquire_artifact`, `lose_artifact`
and `use_artifact` are what happen afterwards. That is the shape skills already
have, for the same reason — the story is _when_.

**`use_artifact` is the verb that makes it an artifact.** Acquiring a rifle is
inventory; firing it is a scene. A use changes no state — it is a fact about a
situation — but it is what lets the wiki say what a thing has actually been for,
and what lets `runChecks` notice someone using what they are not carrying.

Prerequisites are checked at _use_, never at acquisition: being handed a rifle
before you can shoot it is a story, not an error. `outcome` is asked for and
never required, on the same standard as a faction's `goal` — a page that failed
to parse would take the thing out of the ledger entirely.

**Artifacts are not items.** A ledger item has no page and exists only as a
running count from `item_gain`/`item_lose`. Five potions are an item; the rifle
carried through the whole book is an artifact. The difference is `outcome`: an
item is a quantity, an artifact is a means to an end.

## Character systems

A _character system_ is the thing that tracks and manages a character's stats. A
vault may hold several — a Seed that grants power and a Custodian that audits it
are two systems, not one with two moods — and **a character is under exactly one
at a time**.

That single constraint is what keeps `level`, `xp`, and `stats` flat scalars
rather than maps keyed by system: there is only ever one answer to "what is their
vitality". Moving between systems is a `port` event, never a silent frontmatter
edit, so the moment it happens sits in the ledger where the story can see it.

```
systems/
  seed.md          id, name, stats, skills, curves + formulas in the body
  custodian.md
characters/
  inanna.md        system: seed
```

A port re-seeds any stat the new system declares and the character lacks, keeps
the ones it does not declare rather than discarding them, and re-derives the
level from the XP already earned under the new curve — the same experience is
worth a different standing under different rules. All of it is reported as a
`system_port` finding.

Formulas defined in a system page's body are scoped to that system; the shared
`system/formulas.md` stays global and is the fallback. This matters immediately,
because every system's curve defaults to the id `xp-for-level` — without scoping,
two systems would silently level their characters by one curve.

Naming a system on a character is optional when the vault has one. With several
it is required, and leaving it out raises `character_system_unset` rather than a
guess: choosing a system for someone decides what every number on their sheet
means.

**Vaults written before this need no migration.** The original `system/stats.md`,
`system/skills.md`, and `system/curves.md` load as one system with the id
`system`, and a character that names none is placed in it.

### The two Kimi products are not interchangeable

`api.moonshot.ai` (pay-per-token platform) and `api.kimi.ai/coding/v1` (a
subscription from kimi.ai) are separate services. A key for one is rejected by
the other with `401 invalid_authentication_error`, and the same model carries a
different id on each:

|             | Kimi (Moonshot)      | Kimi Code (kimi.ai)     |
| ----------- | -------------------- | ----------------------- |
| Host        | `api.moonshot.ai/v1` | `api.kimi.ai/coding/v1` |
| Key prefix  | `sk-…`               | `sk-kimi-…`             |
| K3 model id | `kimi-k3`            | `k3`                    |
| Billing     | per token            | subscription            |

**kimi.ai is the host to use.** `api.kimi.com` answers identically — it is the
same service behind a different front door — but kimi.com is the mainland-China
site, so litfire defaults to `api.kimi.ai` and nothing points you at the other
one. If you do need it, `LITFIRE_KIMI_CODE_BASE_URL` overrides the host.

`kimi-k3` is also accepted on a subscription as an alias for `k3`, but it is
absent from that host's `/models` response, so `/provider` will not offer it.
Pick `k3`.

Subscription models are **thinking-only**: reasoning tokens come out of the same
budget as the answer, so a small `max_tokens` returns an empty `content` with
`finish_reason: "length"`. Each provider therefore carries its own
`maxOutputTokens` in the catalog, and Kimi Code's is the largest — extracting a
30-exchange interview spent 50k characters on reasoning before writing 18k of
answer. A reply that is cut off raises a named error rather than being parsed:
truncation is not a shorter answer, it is a broken one, and it used to surface
as an "unterminated JSON object" that blamed the parser.
A subscription exposes `k3` (1M context), `k3-256k`, `kimi-for-coding`, and
`kimi-for-coding-highspeed`.

Anthropic is **not** routed through the OpenAI-compatible adapter. Its endpoint
(`/v1/messages`), auth header (`x-api-key`, not a bearer token), required
`anthropic-version` header, and request shape all differ, and Anthropic's own
guidance is to use the SDK rather than a compatibility shim. The other three
share one adapter; only the base URL differs.

**Connection tests cost nothing.** Verification lists models — an authenticated
`GET` — so it proves the key, the network path, and the base URL without
spending a token. The same call supplies the model picker.

### Where keys live

**API keys are never written into the vault.** They go to
`$XDG_CONFIG_HOME/litfire/credentials.json` (default `~/.config/litfire/`) at
mode `0600`; the vault's `.litrpg/config.json` records only the selected
provider and model.

This is deliberate. P1 makes the filesystem the API, but that governs corpus
content, not secrets — and P2 makes the vault an Obsidian folder people sync and
share, while section 6.4 already anticipates shared corpora. A key in `.litrpg/`
would ride along with any of that.

An environment variable always wins over a stored key, and a key supplied by the
environment is never written to disk.

### Custom and local endpoints

Section 9 calls for "any local OpenAI-compatible endpoint". Every provider's host
is overridable via `LITFIRE_<PROVIDER>_BASE_URL`:

```bash
LITFIRE_OPENAI_BASE_URL=http://localhost:11434/v1 litfire   # a local server
LITFIRE_KIMI_BASE_URL=https://api.moonshot.cn/v1 litfire    # Kimi's .cn host
```

## Interview agent

`/system`, `/timeline`, `/character`, and `/themes` are conversational interviews
that surface the world, not forms that collect fields.

**Conversation and extraction are separate calls.** This is the load-bearing
decision: an interviewer responsible for filling typed fields becomes a form, and
asks "what is your XP formula?" instead of "what does a level-up feel like in the
body?". So the interviewer never mentions schema; a second pass reads the
transcript and proposes structured writes.

```
author ⟷ interviewer   creative, unstructured, grounded in the corpus
              ↓ transcript → raw/interviews/
          extractor        structured proposal + open questions
              ↓
          diff gate → disk
```

The system prompt is composed from four layers at runtime — a shared persona, a
per-command brief, the setting overlay, and corpus grounding (`index.md` plus
the pages relevant to that interview). Grounding is what makes the second
interview better than the first: an interviewer that has read the vault never
re-asks and can push on contradictions.

The persona and briefs encode [`docs/LITRPG.md`](docs/LITRPG.md) — meaning
before mechanics, cost and limit and exploit, surface contradictions but never
adjudicate them, assume an expert reader, never reach for the genre default.
They carry no setting idiom at all; that comes from the profile overlay and
only from there.

**Scaffold placeholders are withheld.** `/init` seeds a small connected world so
the vault opens as a graph in Obsidian (DoD 1), but that content is marked
`example: true` and never reaches the interviewer. Without the filter it reads
the seeds as established fact and interviews the author about a character they
never invented. The interviewer is told the placeholders exist, told not to use
any name from them, and told to say "your protagonist" until the author names
one. Delete `example: true` from a page and it becomes real corpus immediately.

```
source/interview/
  prompts.ts     persona + the four briefs + composition
  grounding.ts   corpus context, relevance-ordered, budget-bounded
  session.ts     turn loop, minimum viable set, exit ramp, metrics
  transcript.ts  markdown persistence to raw/interviews/
  extract.ts     extraction prompt, tolerant JSON parsing, zod validation
```

**Transcripts are corpus, not cache.** They are saved as markdown under
`raw/interviews/` — readable in Obsidian, surviving `.litrpg/` deletion, and
re-extractable for free after the schema evolves.

**The exit ramp is a requirement.** Each interview declares a minimum viable set;
below it the interview continues, at or above it the session reports that it is
fair to stop. Two short answers in a row after the minimum is treated as the
spec's "shorter and flatter" signal.

**Prompt quality is the product**, so it is tuned with evidence: each answer's
length is logged against the question that earned it, in
`.litrpg/interview-metrics.jsonl`.

## Review gate

Every LLM write lands as a unified diff before it touches disk (P3: the tool
proposes, the author disposes). Built generic and UI-free in `source/review/`
because §9 says the Slice 2 spinner reuses it wholesale.

```
review — system                          1/2 · 0✔ 0✖ 2•
system/stats.md                               • pending
+4 −8 · confidence: low
Memory named as the cost of levelling; range inferred.

@@ -3,16 +3,12 @@
   - id: strength
-    min: 0
+  - id: memory
+    name: Memory

a accept · r reject · e edit · A accept-all · ←→ item · ↑↓ scroll
```

- **Nothing pending is ever written.** A proposal reaches disk only on an
  explicit accept. `enter` applies once every item is settled; `ctrl+s` applies
  whenever you like, and is the way out mid-review — with everything settled
  `enter` is quicker, but with items still pending it is a silent no-op, which
  is exactly when an author wants to save what they have.
- **`ctrl+s` confirms before it writes.** It states the counts — how many will
  be written, how many rejected and still-pending will be skipped — and needs a
  second `ctrl+s`; any other key backs out. While the prompt is up no other key
  reaches the review, so a stray `a` cannot quietly accept something behind it.
  An accepted item whose path the vault would refuse blocks the save and is
  named, rather than being reported as a failure after the fact.
- **Edit opens an inline buffer.** `e` edits the proposal in place — gutter,
  block cursor, `ctrl+s` to save, `esc` to discard. `ctrl+e` hands off to
  `$EDITOR` for anything too large to fix comfortably in a pane, and
  `/situation new` still goes straight there, because writing a whole scene is
  a real editor's job.
- **Proposal paths are untrusted.** They come from a model, so every path is
  resolved canonically and must land inside the vault and end in `.md`.
  `.litrpg/` (tool cache), `ledger/` (derived), and `raw/` (author input) are
  refused. A bad path fails that one item; the rest of the batch still applies.

## Interviews

`/system` and `/character <name>` run the interview; `/timeline interview` and
`/themes interview` do the same for those (bare `/timeline` and `/themes` keep
their structural views). Each needs a provider — run `/provider` first.

The flow is interview → transcript → extraction → review gate → disk. The
transcript is written to `raw/interviews/` **before** extraction runs, so a
failed extraction never costs the author their interview — and re-running
extraction later is free.

Answer in your own words; `/done` wraps up, `/skip` rerolls the question, `esc`
pauses.

### Interviews are resumable

An interview runs 8–15 exchanges, so losing one to a stray `esc` or a crash
would be the worst failure in the app. **The transcript is written after every
exchange**, not only at `/done` — pausing, quitting, or crashing costs at most
the question you were mid-way through answering.

Starting an interview that has an unfinished transcript offers a choice rather
than guessing:

```
unfinished system interview
  3 exchanges, started 2026-08-15 11:29
  last question: A bill, not a warning — who sent it, and what happens if…

  /system resume   continue where you left off
  /system new      start over (the old transcript is kept)
```

Resuming replays the prior exchanges to the model, so it continues the
conversation rather than reopening it, and keeps writing the same transcript
file. Unfinished interviews are matched on kind _and_ focus, so an abandoned
`/character nyx` never offers itself when you start `/character vale`.

The offer above is deliberately strict; `/system resume` is deliberately not.
Typed by name it reopens the most recent transcript **even if you wrapped it
up**, because "there is no interview to resume" is a lie when one is sitting in
`raw/interviews/` with your answers in it. Reopening is announced, appends to
the same file, and makes it live again. The same reasoning applies to a
transcript with no `status` field: it predates the field and is treated as
unfinished, since offering a resume you decline costs a keystroke while refusing
one costs the interview.

`/done` does **not** seal the transcript on its own. It stays unfinished on disk
until extraction actually returns something, so a failed, hung, or cancelled
extraction leaves the interview reopenable rather than stranding it as complete
with nothing to show for it. `esc` cancels a stalled extraction — the transcript
is already saved by then.

## Assembly

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

### Seams

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

### Transitions

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

### Export

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

## The wiki

LitRPG readers build wikis (`docs/LITRPG.md` §4). `/wiki build` builds the
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

### What extraction writes

The interviewer is told to start with meaning and reach mechanics late, so most
transcripts are mostly meaning — what the System costs, what it forbids, who can
see it, what breaks it. **That has to have somewhere to land.**

For a while it did not. The extractor's targets were `stats.md`, `skills.md`,
`curves.md`, and `formulas.md`, so an interview establishing that levelling
costs memory, that only the indebted see the numbers, and that debt can be
transferred without consent produced **zero writes** — none of it is a stat, a
skill, a curve, or a formula. The two halves of one feature disagreed: the
interviewer asked for meaning and the extractor could only record mechanics.

`system/system.md` is now the primary target for `/system`. Its body is the
prose record of the System — purpose, cost, ceiling, exploit, who sees it, who
runs it — and its frontmatter carries the three descriptors the base brief
interviews for (`system_origin`, `system_visibility`, `system_agency`). Arc
files likewise get a body for what the arc is _about_. The extractor is told
plainly that returning nothing because nothing was numeric throws the author's
work away, and told not to invent mechanics to fill a schema.

It is also told to preserve the existing `idiom` value, since a whole-file
rewrite of `system/system.md` would otherwise reset the vault's vocabulary.

### And the wiki has to show it

Writing prose to disk is only half the trip. The derived pages read the author's
own body from the corpus file they annotate — `system/system.md`,
`characters/<id>.md`, `timeline/arcs/<id>.md`, `themes/<id>.md` — and put it
above the computed sections under a `## From <path>` heading.

That was missing at first, and it produced the same symptom one layer along: an
interview landed correctly on disk and still appeared nowhere, because the
System page read only that file's frontmatter. Computed facts are the
_annotation_; what the author established is the page.

### When an interview produces nothing

The interview → extraction → review → disk chain can end without writing in
three legitimate ways: extraction fails, the model proposes nothing, or the
author cancels the gate. All three used to be silent — the transcript sat in
`raw/interviews/` holding real answers while the corpus stayed unchanged.

`/lint` and `/wiki build` now say so, first thing:

```
interviews that produced nothing
  system — 5 exchanges saved, but nothing under system/ has changed since
    /system extract to re-run extraction
```

**The signal is timestamps, not emptiness.** `/init` seeds `system/stats.md`
from the profile's archetype stats, so "the corpus is empty" is never true in a
scaffolded vault and a check built on it would never fire for anybody. What is
true is that a successful extraction writes its target _after_ the interview
that produced it, so a transcript newer than everything its kind writes to is an
interview that went nowhere.

`/<kind> extract` re-runs extraction over the saved transcript and sends
proposals to the review gate — the interview half is skipped, since the answers
already exist. The transcript is never rewritten, so a failed re-extract costs
nothing and can be run again. It is deliberately not part of `/wiki build`:
that command regenerates derived files and stays free, offline, and
deterministic.

`/system show` renders the System as it currently stands. Bare `/system` starts
an interview, which left no way to see what one produced.

### The agents read it too

The computed cross-reference is appended to the existing grounding for the
interviews and `/editor` — **added, never substituted**. The corpus carries the
author's own words and a summary must not stand in for how they actually wrote a
scene; what the wiki adds is the half prose cannot say, like which step a skill
was acquired at. It is budgeted separately from the corpus so neither category
can crowd out the other, and it states how many entries were withheld, because
an agent that believes it has seen the whole cast will assert things about a
character it was never shown.

### Serving it

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

## The editor

`/editor` opens a chat with a literary editor that has read the corpus. Unlike
an interview, the author drives: ask about structure, pacing, a character's
arc, whether a theme is actually landing, or where two scenes disagree.

```
› /editor
  editor — ask anything about the corpus
  `fix <id|arc|everything>` proofreads; corrections are spelling and
  grammar only, and every one still goes through review

▸ you      does the ledger room appear anywhere before arc-02?
◂ editor   Twice. sit-014 puts it on the third floor; sit-031 has Carl
           taking stairs *down* to it. Both call it the same room. I have
           not decided which is right — that is yours.
```

**Conversation is wide; writing is narrow.** The editor will discuss anything
and is asked to be direct rather than encouraging. The only change it can
propose is spelling, punctuation, and grammar.

### The guard

"Grammar and spelling only" is enforced structurally, not requested in a prompt
— a prompt is a request, and one sloppy generation separates "fix my typos"
from "improve my prose". Every proposal is checked in `source/editor/guard.ts`
**before** it reaches the review queue:

| Rule                               | Rejects                           |
| ---------------------------------- | --------------------------------- |
| Frontmatter byte-identical         | any data, event, or ledger change |
| Numbers preserved                  | `40 gold` → `50 gold`             |
| Wikilink targets preserved         | rewiring the graph                |
| Generated marker regions identical | editing a `litrpg:status` block   |
| Line count unchanged               | an added or deleted sentence      |
| Per-word alignment                 | `walked` → `sauntered`            |
| Insertions from a closed class     | `the steps` → `the cold steps`    |

The word-level check is the interesting one. A single swapped word inside a long
paragraph barely moves a whole-line similarity score, so a line-level test would
wave through exactly the edit that must not pass. Aligning word by word
separates "this word became a similar word" from "this word became a different
word", which is the actual distinction between a correction and a style edit.

Word comparison is Damerau-Levenshtein rather than plain Levenshtein, because a
transposition costs two edits under plain Levenshtein — which refuses `teh` →
`the`, the most common typo there is.

The insertion rule came out of probing the guard with realistic prose rather
than from the original design: counting inserted words allows one, and one
inserted word is `the cold steps`. Grammar fixes insert closed-class words —
articles, prepositions, auxiliaries — and writing inserts everything else, so
only the closed class is permitted. Deletions additionally allow any repeated
word, which is the doubled-word fix.

**What it cannot catch**, stated precisely: `isCorrection` always admits an edit
distance of 1, because without that escape it would refuse `a` → `an`. So a
one-character substitution that changes meaning — `cold` → `bold`, `he` → `she`
— reads as a typo fix and passes. Numbers and links have their own rules;
single-character prose swaps do not. The review gate is the backstop, which is
why the guard narrows what reaches the author rather than replacing their
judgement. Refusals are reported into the conversation rather than dropped, so
an editor that oversteps is visible instead of looking like it found nothing.

### Grounding

A novel does not fit in a context window. Every turn ships a compact **corpus
map** — one line per file, plus open questions — and then the full text of only
the files a deterministic keyword match associates with the question. No
embeddings, no index to rebuild. Grounding is recomputed per question, so the
fifth question is not answered with the files that mattered to the first.

### Fixing

`fix <id>`, `fix <arc>`, or `fix <path>` proofreads that target. `fix everything`
covers the corpus but warns what it will cost first, because a whole-corpus pass
on a real novel is a large request and a long review queue. A target that
matches nothing returns nothing rather than guessing — silently proofreading the
wrong forty scenes is the expensive failure here.

Contradictions are surfaced, never resolved (§8). The editor reports what each
side claims and where; which one is true is the author's call, and a
contradiction is never a spelling error.

## Projects

litfire works on one vault at a time, and switches without restarting.

```bash
litfire ~/novels/starfall       # open that vault
litfire .                       # open the current directory
litfire                         # reopen the vault you worked in last

/project                        # current vault + recent ones
/project ../other-book          # relative paths work like cd
/project ~/novels/starfall      # ~ is expanded by the TUI
/init technological ../sf-book  # scaffold elsewhere and switch there
```

A path argument always wins, `.` included — that is how you say "this directory,
not wherever I was last". Only a bare `litfire` consults the remembered project,
and it says so in the banner, because opening a directory other than the one you
are standing in is a surprise otherwise. If the remembered vault has been deleted
or moved, litfire opens the launch directory and names what went missing rather
than failing to start.

The footer shows the active project name. Switching re-keys everything that is
scoped to a vault — recompute, the file watcher, grounding, the active
character — and clears any open pager, review, or interview, because those
belong to the vault you just left.

Switching to an **empty directory is allowed**, because that is how a new book
starts; litfire says it is not a vault yet and points at `/init`. A path that
does not exist, or that is a file, is refused.

A directory counts as a vault when it has `system/` or `index.md` — written only
by `/init`. Deliberately **not** `.litrpg/`: that appears wherever litfire has
merely been run, because `/provider` and interview metrics create it.

### `~/.litfire`

The last-opened project and the recents list live in `~/.litfire/state.json`,
outside every vault. This is cross-project state, and a list of your other book
paths does not belong in a folder you might share or sync. `LITFIRE_HOME`
overrides the directory.

```json
{
  "version": 1,
  "lastProject": "/home/you/novels/starfall",
  "projects": ["/home/you/novels/starfall", "/home/you/novels/inanna"]
}
```

`lastProject` only advances for an actual **vault**. Running litfire in a plain
directory — to `/init` it, or by accident — still lists that directory under
`/project`, but never makes it the thing a bare `litfire` reopens tomorrow.

An older `$XDG_CONFIG_HOME/litfire/recent.json` is inherited on first run, minus
any path that no longer exists. **API keys were not moved** and still live in
`$XDG_CONFIG_HOME/litfire/credentials.json` at mode 0600 — key material does not
get relocated as a side effect of a convenience feature.

## Multi-genre: setting profiles

litfire is **one engine with pluggable setting profiles**. A profile supplies
vocabulary, interview overlays, and starting archetypes. It supplies no logic —
everything a profile controls is data.

The reasoning is Clarke's Third Law as an argument against forking: a mana pool
and a power budget are the same ledger primitive, a skill tree and an augment
graph are the same prerequisite DAG, a dungeon floor and a derelict deck are the
same bounded arc. The differences are lexical and tonal, not structural.

```bash
/init                  # asks: base · arcane · technological
/init technological
/idiom                 # profile, descriptors, and resolved vocabulary
```

| Profile         | Resource             | Ability  | Space   | Threat    |
| --------------- | -------------------- | -------- | ------- | --------- |
| `arcane`        | mana                 | spell    | dungeon | monster   |
| `technological` | charge               | protocol | deck    | construct |
| `base`          | _(no substitutions)_ |          |         |           |

`base` is a first-class third option, not a fallthrough — declining to choose a
genre stays a supported path.

### What a profile controls

Lexicon, interview overlays, starting archetypes, register. **Not** ledger
semantics, event types, the formula sandbox, the timeline model, checks, or file
layout. If a proposed profile feature would change how state is computed, it is
an engine feature that every profile gets.

### Setting descriptors

Three fields on `system/system.md`, deliberately not a genre enum — they
describe the design space better than a binary would, and the interview branches
on them:

- `system_origin` — divine · arcane · technological · simulated · emergent · unexplained
- `system_visibility` — character · universal · privileged · reader-only
- `system_agency` — agent · bureaucracy · physics · unknown

A technological or simulated origin means "it just works" is not available as an
answer, and the interviewer is told so. `unexplained` is a real choice, and the
interviewer is told **not** to press on it.

### Lexicon resolution

Display and prompting only. Canonical keys live on disk; the display term
resolves at render time, so changing a profile re-renders the corpus without
migrating a single file:

```
stored     {{resource}}
arcane   → mana
technological → charge
```

Author prose is never rewritten (P6) — substitution touches generated blocks,
interview language, and TUI chrome only. `/idiom` always shows canonical keys
alongside display terms, so the indirection stays debuggable.

### Overlays

Base briefs stay genre-neutral and remain the primary prompt; a profile
**appends** questions and a register note and never removes a base question.
Live, the same `/system` interview opens differently:

> **arcane** — What did people believe about these rules before anyone could read
> them, and who turned out to be wrong?
>
> **technological** — The System in this world was built — somebody installed it.
> Take me to the day it first came online…

**The traffic runs one way.** Setting words belong in the profile and nowhere
else, because a profile can only append: a fantasy word in a base brief primes
every SF vault's interviewer toward a setting its author never chose, and no
profile can take it back out. A test asserts the persona and all four briefs
name no idiom, with a companion assertion that the profiles _do_ supply one, so
the rule cannot pass by the mechanism being dead.

**An overlay describes its own idiom, never the neighbouring one.** "Technology
degrades; magic usually doesn't" was a live example — a true craft point that
put magic into every SF vault's prompt, which is worse than the base-brief case
rather than better: the author explicitly picked a setting and got told about a
different one. Each register now stands on its own terms, and a test checks both
directions.

The same applies to **form**. LitRPG has at least five (VRMMO, System
Apocalypse, isekai, dungeon core, tower climb), so the base brief asks whether
the System arrived, whether the protagonist entered it, or whether it was always
the case — and says not to assume. "When the System arrived" is a plot the author
did not choose.

Two cross-cutting questions live in the base brief because every idiom needs
them: who can see the numbers, and what the System wants — they drive
`system_visibility` and `system_agency`. They were previously carried in the
overlay, which meant a vault that chose no profile silently lost both.

### Blends

`extends` accepts a list with later entries winning, so science-fantasy is data:

```yaml
extends: [arcane, technological] # charge and decks, but gold and enchantments
```

Post-MVP profiles (`cultivation`, `superhero`, `corporate-dystopian`) are
data-only additions.

### Editing the lexicon

`/idiom set <key> <term>` and `/idiom unset <key>` write the per-vault override
at `system/idiom.md`, where author edits win over the shipped profile (§3.2):

```
› /idiom set resource essence
  resource  mana → essence
  written to system/idiom.md · display only, nothing on disk changed
```

Reported as `before → after` rather than as the file change, because unsetting
resolves back through the `extends` chain and the word you will actually see is
the useful thing to print. Clearing the last term removes the `lexicon` key
outright — `loadSetting` treats the mere presence of that key as a declaration,
so an empty one would strand the vault on an `<idiom>-local` profile that
overrides nothing.

### Status blocks

A profile's `status_template` finally renders. `/status <character> [at]` builds
the in-world block; `/status write <character> <situation>` upserts it into that
situation between `<!-- litrpg:status -->` markers, so it can be regenerated
without touching the prose around it.

```
arcane / sheet          technological / hud
> **Carl** — level 7    Carl — iteration 7, xp 4120
> | mana | 40 |         charge 40
> school: ember-bolt
```

- **The write path uses the replay snapshot at that situation**, not current
  state. A status screen in chapter three showing end-of-book numbers is the
  contradiction this tool exists to catch, not to introduce. An unplaced
  situation has no point in time, so it is refused rather than given the latest.
- **Nothing invents a maximum.** `CharacterState` is a flat current-value map
  with no ceilings anywhere in the ledger, so no template renders `40 / 40`, a
  bar, or a percentage — there is nothing to divide by, and the denominator
  would be a number the author never wrote.
- **This is the one place display terms reach disk.** Elsewhere the lexicon is
  render-time only. A marked region is exempt because it is regenerated
  wholesale and never parsed back into state, so its words never become a second
  source of truth competing with the canonical keys.

## Local story vaults

Test vaults live under `vaults/`, which is gitignored. Create one:

```bash
pnpm vault:new my-story     # creates vaults/my-story, then opens litfire
```

Then run `/init` inside litfire to scaffold it. The script asks **git itself**
whether the path is ignored (`git check-ignore`) and refuses to create the vault
if it isn't — so a broken `.gitignore` fails loudly at creation rather than
silently at commit time.

Nothing under `vaults/` is ever committed, so real prose and real experiments are
safe there.

### Keeping credentials and vaults out of commits

Three layers, because `.gitignore` alone is not enough — it does nothing against
`git add -f`, and nothing for a file that is already tracked.

1. **Keys live outside the repo by default** — `~/.config/litfire/credentials.json`
   at mode `0600`. The vault stores only the provider id and model.
2. **`.gitignore`** covers `vaults/`, `.litrpg/` anywhere, `credentials.json`,
   `.env*`, and private-key extensions. The vault-shaped patterns
   (`/system/`, `/themes/`, `/ledger/` …) are **root-anchored on purpose**:
   unanchored, they would silently stop tracking `source/system/`,
   `source/themes/`, and `source/ledger/`.
3. **A pre-commit hook** — opt in once:

   ```bash
   pnpm hooks:install     # sets core.hooksPath to .githooks
   ```

   It blocks any commit containing a credentials file, `.litrpg/` content,
   anything under `vaults/`, private key material, or a live-looking API key
   (`sk-ant-…`, `sk-proj-…`, long `sk-…`, `AKIA…`) in any file. Run the same
   check by hand over the whole tree with `pnpm check:secrets`.

   The same install also adds a `commit-msg` hook that blocks **AI attribution**
   — co-author trailers naming an assistant, "generated with" notices, robot
   emoji, and assistant noreply addresses — from commit messages, trailers, and
   file contents. Commits here are the author's work and are recorded that way.

   A legitimate human co-author trailer is unaffected, and references to the
   Anthropic API (`@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`) are not attribution
   and never trip it: the patterns match attribution _forms_, not the vendor
   name. Check by hand with `pnpm check:attribution`.

   The exact patterns live in `scripts/check-attribution.sh` — deliberately not
   reproduced here, so this document does not trip its own guard.

   Thresholds are set above the short placeholder keys the test suite uses, so
   the test files do not trip it.

## Scripts

| Command              | What it does                                   |
| -------------------- | ---------------------------------------------- |
| `pnpm dev`           | Run the TUI from source via `tsx`              |
| `pnpm build`         | Bundle to `dist/cli.js`                        |
| `pnpm typecheck`     | `tsc --noEmit` (TypeScript 7, native compiler) |
| `pnpm lint`          | `oxlint`                                       |
| `pnpm test`          | Vitest + `ink-testing-library`                 |
| `pnpm check`         | typecheck + lint + format check + test         |
| `pnpm vault:new`     | Create an ignored local story vault            |
| `pnpm check:secrets` | Scan tracked files for credentials             |
| `pnpm hooks:install` | Install the pre-commit secret guard            |

`typescript-eslint` still peers at `typescript <6.1.0` and cannot see TypeScript 7,
which is why linting is oxlint. The trade-off is no type-aware lint rules.

## Documentation

|                                          |                                                         |
| ---------------------------------------- | ------------------------------------------------------- |
| [`docs/LITRPG.md`](docs/LITRPG.md)       | The genre, and what this tool assumes about it          |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why the architecture is the way it is                   |
| [`docs/STATUS.md`](docs/STATUS.md)       | Progress against the original definition of done        |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)     | Setting up, the principles, and how to send a change    |
| [`SECURITY.md`](SECURITY.md)             | Credential handling, the formula sandbox, and reporting |
| [`CHANGELOG.md`](CHANGELOG.md)           | What changed, and any vault-format migrations           |

## License

MIT — see [LICENSE](LICENSE).
