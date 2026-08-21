# Interviews

## Interviews

`/questions <kind>` interviews you about any primitive — `moment`, `place`,
`faction`, `artifact`, `situation`, `chapter`, `arc`, `character`, `system` or
`theme`. Add an id to narrow it to one thing:

```
/questions faction              about your factions
/questions place oz-farm        about that one place
/questions moment resume        continue where you left off
```

It opens on whatever the deterministic checks found unresolved for that kind, so
the interview starts where your vault is actually thin. When the checks are
happy there is no agenda, and it says so and offers anyway rather than deciding
for you:

```
› /questions theme
no open questions about themes.
begin interview anyway? y/N
```

The default is no, so `return` declines — which makes `/questions <kind>` safe
to type when you only wanted to know whether anything was outstanding.

The older commands still work and do the same thing: `/system`,
`/character <name>`, `/timeline interview` and `/themes interview` (bare
`/timeline` and `/themes` keep their structural views). Each needs a provider —
run `/provider` first.

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

The persona and briefs encode [the genre reference](../concepts/litrpg.md) — meaning
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
