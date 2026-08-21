# Committed decisions

Resolves §14 "Open decisions" of the Slice 1 requirements. Each entry records the
choice and the reason, so a later reader does not have to re-litigate it.

## D1 — Marker syntax for generated regions

**Committed:** exactly the form given in §11.

```
<!-- litrpg:status char=carl at=sit-042 -->
...generated block...
<!-- /litrpg:status -->
```

Rules: HTML comments so Obsidian renders nothing. `litrpg:` prefix namespaces the
tool. Attributes are `key=value`, space separated, unquoted, no spaces in values.
The close tag repeats the block name only.

§11 calls this a permanent format commitment, so it is frozen here and parsed by a
single module (`source/vault/markers.ts`). Nothing else may hand-roll the syntax.

## D2 — Authority of `state.md`

**Committed:** the `.litrpg/` cache is authoritative for computation; `state.md` is
a rendered projection carrying `generated: true`.

This follows the spec's own recommendation. It bends P1 ("the filesystem is the
API") slightly, but DoD 11 only requires that deleting `.litrpg/` loses nothing but
cache — which holds, because the cache is derived from markdown by a pure replay.
Hand-edits to `state.md` are detected and regeneration wins.

## D3 — Intra-arc `order` collisions

**Committed:** sparse integers, step 10 (10, 20, 30 …).

Fractional reindexing avoids rewrites but produces `order: 10.0009765625` in
frontmatter that an author has to look at in Obsidian, which loses on P2. Sparse
integers keep the file human-readable; a collision inserts at the midpoint, and
only when no gap remains does the arc renumber. Collisions are not errors — ties
break by filename so replay stays deterministic regardless.

## D4 — `/situation new` external open

**Superseded by D7** — `/situation new` now opens the native buffer. The rest of
this entry still describes how `$EDITOR` is resolved where it is still used.

**Committed:** `$EDITOR` by default, Obsidian URI when configured.

`.litrpg/config.json` carries `editor: "$EDITOR" | "obsidian"`. `$EDITOR` is the
portable default and works over SSH; the Obsidian URI scheme requires a registered
vault name and fails opaquely when absent.

## D5 — Node and the formula sandbox

**Committed:** `isolated-vm@^6.2.0`, pinned below 7.

`isolated-vm@7` requires Node >= 24; this project targets Node >= 22 because that
is Ink 7's floor. 6.2.0 supports >= 22 and enforces the CPU timeout. The caret must
not be widened to `^7` without also raising the engines floor.

Verified on Node 22: `fetch`, `process`, and `require` are already absent inside an
isolate, but **`Math.random` and `Date.now` are present** and must be explicitly
removed to satisfy the determinism requirement in §6.4.

## D6 — `$EDITOR` and the reviewer

**Committed:** `$EDITOR` is the program; `/reviewer` is the agent. One word, one
meaning.

The two collided. `$EDITOR` (D4) is what `/situation new` shells out to and what
`^e` reaches from the prose buffer — the program the author writes in. `/editor`
was also the model that reads the finished corpus and proposes corrections. Every
sentence about either one had to say which was meant, and the shared conversation
screen defaulted its speaker to `editor`, which is how `/curator` came to greet
authors under the wrong name.

The agent is now `/reviewer`, and `source/reviewer/` holds it. `source/editor/`
keeps only `buffer.ts`, the in-app prose buffer, because that genuinely is an
editor. The conversation types moved to `source/conversation/types.ts` with the
role `agent` rather than `editor`, so `/curator` no longer imports a type named
after the other agent, and the screen's `speaker` prop is required — a shared
screen that can default to a name is a screen that will eventually show the wrong
one.

The reviewer is still described as a literary editor in its persona and summary.
That is the craft it practises, and it was never the ambiguous part.

## D7 — Writing a situation

**Committed:** the native prose buffer, replacing the `$EDITOR` hand-off in D4.

D4 sent `/situation new` to `$EDITOR` because writing a whole scene looked like
a real editor's job. In practice it is the wrong shape: the tool loses the
terminal to another process, the author comes back to a prompt that has
forgotten what they were doing, and on a host with no `$EDITOR` set the command
did nothing but print advice.

`/situation new` and `/situation edit <id>` now open the scene in the buffer
that already existed for the review gate. It gained undo/redo, word and page
motions, and a confirm-before-discard that the review gate does not use — a
rejected proposal costs nothing to lose, a half-written scene costs everything.

Only the body is editable. Frontmatter is re-serialised from what was parsed at
open, so a save can normalise its formatting but cannot change its meaning; the
fields there belong to `/situation place`, extraction, and the ledger. Editing
frontmatter means Obsidian or any other editor, which the filesystem-is-the-API
principle already guarantees.

`$EDITOR` is not gone: `^e` still reaches it from the review gate, and
`vault/editor.ts` still resolves it. How an external editor gets wired to a
situation is left open rather than decided badly.

## D8 — Documentation publishing

**Committed:** VitePress in `docs/`, deployed to GitHub Pages by Actions.

The README had reached 1,095 lines across 21 sections — a manual rendered on a
landing page, with no navigation, no search, and five supporting documents
reachable only from a table near the bottom. It is now ~124 lines: what litfire
is, install, the command table, and links into the site.

Source stays markdown in `docs/`; the site is a derived artifact and is never
edited by hand. That is the same rule the tool applies to `wiki/` and
`manuscript.md` inside a vault, and a docs pipeline that broke it would have the
project contradicting its own first principle in public.

Three choices worth recording:

- **Build is split from deploy.** Pull requests build without deploying, which
  makes the build a link checker — VitePress fails on a dead relative link, so a
  renamed section becomes a CI failure instead of silent rot. Only the `deploy`
  job holds `pages: write`; the build job, which runs third-party dependency
  code, gets `contents: read` and nothing else.
- **`base: '/litfire/'`.** Project pages are served from a subpath, and the
  default `/` builds a site whose every asset 404s — while still working
  locally, which is how that reaches production. A custom domain would change
  this, and changing it later invalidates every published link.
- **Root documents are included, never copied.** `CONTRIBUTING.md` and
  `SECURITY.md` stay at the repository root, where GitHub's pull-request and
  security tabs look for them, and the site pulls them in with `@include`. One
  source of truth per document. The one cost: a relative link between two root
  files does not resolve once included, so `CONTRIBUTING.md`'s link to
  `SECURITY.md` is absolute.

`pnpm check` deliberately does **not** run `docs:build` — CI covers it, and the
check runs on every commit.

Repository settings must have Pages source set to "GitHub Actions". No workflow
can set it, and it is the most common reason a correct workflow deploys nothing.

## D9 — The situation is the hub

**Committed:** every world link hangs off a situation, and every link has a verb.

A vault could hold characters, places, moments and artifacts and still build an
almost empty wiki. Place pages are derived from `situation.place`, character
appearances are the scenes they are cast in, and a moment's scenes are the ones
anchored to it — so a vault whose only situation named nothing produced a wiki
with no places, no arcs and no scenes, which read as the wiki being broken
rather than as the scene being unlinked.

Nothing set those links. `situation.moment` had existed since character state
landed with no command to write it, `characters:` and `place:` could only be
reached by hand-editing frontmatter or by extraction, and no command created an
arc at all — so `/situation place <id> <arc>` could never succeed in a fresh
vault, because there was never an arc to place onto.

Four decisions:

- **`arc` and `place` are separate verbs.** `/situation <id> place <arc>` used
  to mean "put this on an arc" while `place:` in the same file meant "where it
  happens". One word for a narrative position and a location made the workflow
  impossible to write down. `arc:` and `place:` are now each set by a verb of
  the same name.
- **Structural links are checked; descriptive ones are not.** A moment or an arc
  must exist, because a typo would silently move a scene on the clock or in the
  replay order. A place or a character need not: places have no schema at all,
  and naming someone before writing their page is a normal order to work in. The
  link is made and the gap is reported (P4).
- **Situations are a wiki kind.** The page lists what is still unlinked, with
  the command that fixes each gap, rather than rendering a tidy stub that looks
  finished.
- **Linking never touches the body.** Every verb goes through one patch helper
  that rewrites frontmatter and writes the body back byte-identical, so P6 holds
  by construction rather than by each verb remembering.

Two bugs surfaced while verifying the flow end to end. `readAuthorBody` looked
only for `<directory>/<id>.md`, so a scene stored as `sit-002-the-ledger-room.md`
never showed its own prose on its own wiki page; it now finds a page by
frontmatter id, and looks in the inbox for scenes that are still unplaced. And
`/arc new` numbered arcs with D3's sparse step, producing `arc-02` at order 11 —
arcs now count 1, 2, 3, since D3's reasoning is about inserting a scene between
two others _within_ an arc.

The whole flow is documented in `docs/guide/populating-a-situation.md` and
verified end to end in `test/situation-workflow.test.ts`.

## D10 — The in-world clock is a bigint

**Committed:** every instant is `bigint` seconds from the origin, ±1 trillion
years; calendars are a presentation layer chosen per vault.

`at` was a JavaScript number, exact only to ±9,007,199,254,740,991 — about ±285
million years in seconds. A vault dating the formation of a world before a
present-day origin passes that immediately, and past it the arithmetic does not
fail: it silently rounds, and two moments a minute apart compare equal.

The rounding is invisible in round numbers, which is what makes it dangerous.
`-26174880000000000` survives a round trip through a double intact;
`-26174880000000123` comes back as `...124`. A format that is lossless for the
values used in testing and lossy for the ones used in writing is found years
later, in someone's book. A real vault was already past the bound.

Decisions inside that:

- **The widening is exactly as broad as the clock.** Frontmatter is parsed with
  `intAsBigInt` so `at` never passes through a double, then every other integer
  is narrowed back to a number. Levels, xp, stats and orders are small by nature
  and read by arithmetic all over the codebase; promoting them wholesale would
  be a large change for no gain, and mixing the two silently is how `1n + 1`
  becomes a TypeError in production.
- **A damaged number is refused, not adopted.** A `number` outside the safe
  range has already been rounded by the parser. Taking it would bake the damage
  in, so it becomes a load issue instead.
- **Calendars are presentation, never storage.** A vault holds seconds and
  nothing else; `timeline/time.md` decides how they are _read_. Changing the
  calendar never rewrites a moment.
- **A custom calendar is a formula, not a schema.** Ten months of thirty-five
  days with four moons on different cycles is a function, and a declarative
  format covering it would be a worse programming language than the one already
  in the vault. It runs in the existing consent-gated isolate, receives a
  `BigInt`, and returns a string.
- **Formatting happens during `computeProject`.** The isolate is async and the
  runner is disposed before the project is returned, so every displayed instant
  is rendered once while it is alive and read from a map afterwards. The
  alternative would be running author code on the main thread, which is the one
  thing the sandbox exists to prevent.
- **Gregorian says when it cannot answer.** `Date` spans ±273,790 years and the
  clock spans ±1 trillion. Beyond its horizon the calendar returns "beyond this
  calendar"; clamping would report a date wrong by geological ages, and throwing
  would take the timeline down over a display concern (P4).

`clock_beyond_exact_range` is gone — the condition it warned about can no longer
occur. `clock_collision` remains for two moments genuinely written at the same
second.

Documented in `docs/reference/time.md`.

## D11 — Proposals may remove a file

**Committed:** `Proposal.remove`, through the review gate, under the same path
rules as a write.

Corpus is generated, and generation makes duplicates. Extraction run twice over
one interview slugged the same event two ways and left `inannas-first-memory`
and `the-first-memory` — distinct ids, one name, one moment. The curator could
see it and could not fix it: a `Proposal` was `{path, contents}` with no way to
say "this should not exist", and its prompt said so outright — _"you cannot
delete"_. The tool could create the mess and not clear it up.

A removal is a proposal like any other. It reaches the author as a diff showing
the whole file coming out, is accepted or rejected one at a time (P3), and
passes the same `resolveInsideVault` check as a write — `raw/`, `ledger/`,
`wiki/` and anything outside the vault are refused, which matters more for a
removal than for a write.

Three details:

- **The diff shows an emptying, not an empty panel.** Whatever contents came
  with the proposal are discarded at batch creation, because what is being
  decided is the deletion.
- **`e` is not offered on a removal.** The buffer would accept edits that
  `applyAccepted` then ignores, since it deletes on the proposal's say-so rather
  than on the contents.
- **A removal that finds nothing there fails rather than reporting success.**
  `rm` without `force`: a deletion that did not happen has not done what it said.

Detection came with it, since neither case was checked at all:

- `duplicate_id` — two pages declaring one id. Everything that resolves it sees
  only one, and the other is invisible while still on disk.
- `duplicate_name` — different ids, one name. This is the case that actually
  occurs, and no id check would ever catch it. Matched case-insensitively on
  trimmed text; unnamed pages are not treated as sharing a name.

Neither is resolved automatically. Which of two pages is the real one is the
author's call every time (P4).

## D12 — Places are a primitive

**Committed:** `placeSchema` of `{id, name}` and nothing else; wiki place ids
come from pages _and_ situations.

Places were the one kind with no schema — free prose in a directory — and that
was mostly right. What a room is like is writing, not data, and no field was
going to capture it.

What it cost was addressability. A place had no name of its own, the wiki
derived place ids from `situation.place` alone, and `/primitives` read the
directory and could report nothing but the stem. So a place an author had
written and not yet used was invisible everywhere: no wiki page, no name, no
command to see it. A vault with two written places showed none.

The schema is deliberately the thinnest in the vault: an id and an optional
name. The body stays prose.

Wiki ids are now the union of both sources. Deriving them from situations alone
hid a place that had been written; deriving them from the directory alone would
drop a place a scene names but nobody has written up yet, which is the more
common half of the same mistake. Both are legitimate states and `/place` names
them apart — "no scenes" against "no page yet".

`renderPrimitives` loses its `places` parameter, since there is no longer a kind
the caller has to read off disk on the view's behalf.

## D13 — Streaming repaints are coalesced

**Committed:** at most one repaint per 50ms while a reply streams.

Every streaming screen — interview, reviewer, curator — accumulated a reply
delta by delta and set state on each one. A provider delivers a reply as
hundreds or thousands of deltas, so that is hundreds or thousands of React
renders per reply, each one asking Ink to rebuild the tree.

`ConversationScreen` made it quadratic. Its `speakers` record was rebuilt on
every render and sat in the dependency array of the memo that wraps the _entire_
conversation, so every token re-wrapped every turn that had ever been said. A
long curator session therefore did more string work per token the longer it
ran, while the terminal was at its busiest.

Both are fixed: the record is memoised on the speaker, and `streamPainter`
coalesces deltas into repaints at 50ms — twenty frames a second, which is faster
than anyone reads. Nothing is dropped; `flush()` is mandatory because the last
tokens almost always arrive inside the final interval.

This was found after a `RuntimeError: memory access out of bounds` inside
`yoga-layout`'s WASM, thrown from Ink's debounced renderer during a curator
reply. The render storm is a plausible contributor and not a proven cause — the
fault is inside Ink's layout, and a single stack trace does not establish which
pressure produced it. What is certain is that the work removed here was waste:
Ink debounces its own render, so almost every frame those renders produced was
computed and discarded.

## D14 — The curator can open a file

**Committed:** a `READ:` round in the conversation, a `read` field in the plan,
both read-only and both allowed into `raw/`.

The curator is given a map of the whole corpus and the full text of whatever
scored highest against the question. That selection is a guess made before it
has read anything, and it is routinely wrong in a specific way: a page it needs
to rewrite is listed in the map and not in front of it.

What it did then was correct and useless. It refused to emit a replacement for a
file it could not see and asked the author to paste it — _"Paste either file and
I'll return it whole with the link fixed."_ Refusing to rewrite unseen prose is
exactly right; making the author be the file system is not.

So it can ask. A conversational reply beginning `READ:` is intercepted rather
than shown, the files are opened, and the question is put again with them
attached. The structural pass asks the same thing through its JSON, returning
`read` and no writes — writes sent alongside a read are discarded, because they
were made blind.

Four details:

- **Reads may enter `raw/`.** `resolveReadable` is deliberately not
  `resolveInsideVault`: the latter forbids `raw/` because the tool never
  _writes_ to the author's record, and reading the transcript beside the corpus
  is the entire reason `/curator` exists. Everything else holds — inside the
  vault, canonically, markdown only, and `.litrpg/` excluded as tool cache.
- **Two rounds.** Enough to read a page and then the one it links. A third is
  nearly always the model circling, and each round costs the whole context.
- **A truncated file is marked as truncated.** A curator rewriting from a
  silently clipped copy would delete whatever was cut.
- **Refusals go back to the curator**, not to nobody. One told "that file does
  not exist" stops asking; one told nothing asks again and burns the round.

**Writing to `raw/` is still forbidden.** Nothing here changes that — `raw/` is
the author's own record and the tool never writes to it.

## D15 — The curator may propose changes to raw, and the gate asks before losing them

**Committed:** `allowRaw` on the batch, not on the proposal; and `q`/`esc` now
confirm when accepted changes have not been written.

### Raw

`raw/` was closed to every agent, because it is the author's own record and the
whole reason it can be trusted is that only they write it. That held until the
curator was asked to reconcile a corpus against the material it came from and
found the error was _in the record_ — a name the transcript spells one way and
the vault another. It could describe the problem and not fix it.

So the curator may propose there, and only the curator: extraction and the
reviewer keep the old rule. The permission belongs to the **batch**, not to a
proposal — a proposal that could grant itself the right to rewrite a transcript
would be no rule at all. `ReviewBatch.create(root, proposals, {allowRaw: true})`
is called in exactly one place.

Nothing else moves. `ledger/`, `wiki/`, `manuscript.md` and `.litrpg/` stay
closed to everyone, including the curator, because they are derived and a
write there is overwritten on the next recompute. A raw proposal is labelled
`(your raw record)` in the gate so it never reads as an ordinary corpus write,
and the persona is explicit that it corrects what is wrong _about_ the record
and never rewrites what the author said.

### The gate

`q` and `esc` called `onCancel` outright. An author who accepted six proposals
and then left the gate lost all six, with `nothing was written` printed after
the fact. Accepting marks a decision and only applying writes it — a distinction
that is invisible until it costs someone their work.

Leaving with accepted changes now asks: `ctrl+s` to write them, the same key
again to discard, anything else to go back. With nothing accepted it still
leaves at once, because a prompt whose answer is always the same is noise.

## D16 — A request is a line, not a prefix

**Committed:** `READ:` is matched per line anywhere in a reply, and everything
after it is taken as paths.

D14 decided whether a reply was a request by testing its first characters, on
the strength of a persona line telling the curator to "reply with nothing but
a READ line". A real model does not do that. It explains itself first:

```
Before I propose the merge, I want to pin provenance — the surviving
page should carry a "Raised in" link to the interview that produced it.

READ: raw/interviews/timeline-2026-08-19T08-51-59.md
```

The prefix test missed that entirely, so the request reached the screen and
nothing opened the files. The author asked three times and got the same refusal
each time, which is the worst possible shape for this failure: the tool looked
like it was being obstinate while it was in fact never hearing the question.

The explanation is worth keeping — it says _why_ a file is wanted — so the
reasoning still streams and only the request is swallowed. Once a request line
appears, nothing more is shown: a request routinely wraps onto a second line,
and half a path list is worse to look at than none of it.

Paths are collected from the whole tail rather than parsed out of one line,
which is what survives the ways a real request is written — wrapped, comma
separated, backticked, or split across two `READ:` lines. Taking a stray path
from prose is the harmless direction to be wrong in; this only ever opens a file
for the model to read.

Two stale pieces of the persona went with it. It still said it may never propose
a write to `raw/`, which D15 changed. And it never mentioned `plan` — so an
curator asked to fix something would reason at length, offer to "hand you the
merged page", and leave the author believing a change had landed when the
conversation writes nothing at all. It now names the command that turns
agreement into diffs.

## D17 — The curator proposes; the gate decides

**Committed:** a `PLAN:` directive the curator ends a reply with, and the
conversation goes into the structural pass as context.

`/curator` split talking from doing: the conversation wrote nothing, and a
proposal only happened when the author typed `plan <instruction>`. The intent
was that a write should sit behind an explicit verb.

It was protecting nothing. **The review gate is what makes a change safe** —
every proposal arrives as a diff the author accepts one at a time (P3) — and
that holds however the pass was started. What the verb actually bought was a
step where the author retypes the curator's own conclusion:

```
If that all looks right, run:

    plan set at on the five undated moments from the author's ordered list:
    bicameral-era -9839232000000, bootstrapping -1009152000000, ...
```

Five timestamps the curator had just computed, handed back for a human to
copy. That is where a digit gets dropped.

Worse, the pass then re-derived them. It received the instruction string and
fresh grounding — never the conversation — so the reasoning that produced those
numbers was thrown away and done again, with nothing guaranteeing the second
answer matched the first. The conversation is now part of the plan's context,
told plainly that figures reached there are what the instruction refers to.

The curator ends a reply with `PLAN: <instruction>` and the pass runs. The
directive is suppressed from the screen the same way `READ:` is, and the
reasoning before it still shows, so the author sees the shape of the change and
then the diffs.

Reading still wins when a reply asks for both: files are what a plan would be
written from.

`plan <instruction>` typed by the author still works. It is now one of two ways
in rather than the only one.

## D18 — Ingest is a plan over the author's notes

**Committed:** `/ingest <kind> [<document>]`, built on the structural pass.

The interviews go one way — ask, transcribe, extract. An author who already
knows their world works the other way: they write it into `raw/characters/` and
`raw/moments/` and want the corpus to catch up. There was no path from a page of
notes to a page in the vault except describing it to the curator in
conversation.

Ingest is not a new agent. It builds an instruction and a context and hands them
to `runPlan`, which already emits whole files, refuses paths outside the vault,
can open a file it needs, and returns proposals to the review gate. Writing a
second pass would have meant re-deriving all of that and then keeping the two in
step.

Three things the instruction is explicit about, each for a failure seen before:

- **One note may hold several things.** `all_moments_ordered.md` is nine moments,
  not one page.
- **Update rather than duplicate.** Every existing page of the kind goes into
  the context by id and name. Without it, ingesting notes about a character the
  vault already knows produces `inanna-tran-weber` beside `inanna` — exactly the
  `duplicate_name` finding D11 added a check for.
- **Never invent.** A field the notes do not answer is left out for the checks
  to raise.

The raw directory is read and never written. `/curator` remains the one agent
that may propose into `raw/` (D15), which is a different job: correcting the
record, not deriving from it.

An empty directory is refused in the command, before any model call. There is
nothing to think about, and a request that costs money should not be spent
discovering there was no input.

## D19 — One id, one file

**Committed:** the filename is the id; `situations/inbox/` is no longer written
to; a page whose stem is not its id is reported.

A situation existed twice: `situations/sit-001.md` and
`situations/inbox/sit-001-inanna-hears-her-parents-argue.md`, both declaring
`id: sit-001`. Everything downstream resolved whichever loaded first, so a cast
linked on one was invisible through the other.

Two decisions made it possible, and both are gone.

**A slug in the filename.** `/situation new` wrote `<id>-<slug>.md` while
everything else wrote `<id>.md`, so nothing that looks at names could tell the
two files were the same page — `findSituationFile` had to open every file and
read its frontmatter to find one. The filename is now the id and nothing else.
The title is in the frontmatter already.

**A second legal home.** `situations/inbox/` meant "no arc", which
`arc: undefined` already says; the loader literally forced it with
`inbox.map(s => ({...s, arc: undefined}))`. Encoding the same fact twice gave
one scene two valid locations, and placing it on an arc _moved the file_ —
which is why the two copies could drift apart. Placing now sets `arc:` and
touches nothing else.

The inbox is still read, so existing vaults keep loading, and reported as
`legacy_location` so it empties rather than persisting. The scaffold's own
`sit-001-the-arrival.md` was renamed: the tool was shipping a violation of its
own rule.

`Vault.sources` records the file each page was read from. Without it every
report was "there are two of these somewhere", which is a fact the author then
has to go hunting for; `duplicate_id` now names both paths, and that is also
what let ingest propose removing the lesser copy (D18).

**Still open:** whether the corpus should be authored at all, or derived wholly
from `raw/`. That is a larger question than this one and is not settled here.

## D20 — /architect becomes /curator

**Committed:** the agent is a curator, and the module, persona and command say so.

`architect` described the wrong job. An architect designs a structure that does
not exist yet. What this agent does is take what fits out of raw material and
place it in a knowledge base that is orderly, linked and cited — which is
curation, and naming it that changes what it reaches for.

The persona changed with the name rather than only the word. It used to open
"you are the architect of a LitRPG vault: a structural editor", which invited
designing. It now opens on the actual job: an author writes down what they know
and it accumulates faster than it organises; take what fits, shelve it in the
kind it belongs to, under an id everything else can resolve, carrying a link to
whatever established it. **The writing is theirs; the shelving is yours.**

`source/curator/`, `CuratorSession`, `CURATOR_PERSONA`, `/curator`. Earlier
decision records are updated to the new name so a reader following a reference
finds a command that exists — the history is what the entry says, not which noun
it used.

`docs/concepts/architecture.md` is unaffected. That is the tool's architecture,
which is a different word doing an honest job.

## D21 — Adopt on edit

**Committed:** a linking command writes the author's copy in `raw/`, adopting
the page there if it is not yet, and carries the change onto the derived page in
code.

The raw-first proposal sequenced this as two steps — move the linking commands,
then move `new` — and they could not be split that way. Both resolve the same
constant: `/moment new` and `/moment <id> at` each write
`timeline/moments/<id>.md`. Change one and not the other and the second reports
`no moment 'the-breach' — /moment new <name> creates one`, which is the
command that had just run.

Adoption resolves it. An edit that finds no note in `raw/` writes one from the
corpus page — frontmatter and prose together, so the note is a complete record
rather than a stub whose body the next ingest would drop — and edits that.
Migration then happens by using the tool, on the pages actually being worked on,
and a vault can sit half-moved indefinitely. It also removes most of what step 6
was going to be: by the time corpus writes are forbidden, everything anyone
touches has already moved itself.

**The derived page is updated too, in code, with no model call.** Setting `at:`
on a moment is a copy, not an inference — the author said the number, and
`/ingest` would do nothing cleverer with it. Requiring a model round trip to
make a typed edit visible would have made the tool worse at the thing it is for.
The page is re-stamped with the note's new hash, so the corpus reflects the note
exactly and the next ingest correctly skips it. Prose changes still need a pass,
because those genuinely need reading.

This is not a second writer. It is one write, performed by the cheaper of two
mechanisms, with the note remaining the source of truth — which is the same
reasoning that stamps `source_hash` in code rather than asking a model for a
digest.

Every kind goes through one helper, so the layer a primitive is authored in is
decided in exactly one place. A refused edit adopts nothing: a value that fails
its schema must not leave a half-migrated page behind.
