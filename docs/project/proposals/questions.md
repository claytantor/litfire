# Proposal — one verb for asking

**Status:** proposed, not accepted
**Follows:** [raw is the only thing you write](./raw-first.md)

## Summary

Replace the four bespoke interview commands with `/questions <kind> [<id>]`,
which interviews the author about any primitive. Answers land in `raw/` as they
already do; `/ingest` files them as it already does.

Two verbs cover the whole loop:

```
/questions moment          ask me about moments
/ingest moment             file what I said
```

## Yes, and it collapses more than it looks

Today four kinds have interviews — `system`, `timeline`, `character`, `themes` —
because `interviewKindSchema` is a four-member enum. The other five primitives
have none. There is no reason for that asymmetry beyond the order things were
built in: an author can be interviewed about their themes and not about their
places.

One verb over nine kinds removes it, and takes three other things with it:

- **`/<kind> show|resume|extract|all`** — four directives per interview command,
  duplicated four times, each with its own transcript-history handling.
- **The extraction path.** Answers are already written to `raw/interviews/`, and
  `/ingest interview` already reads them. The per-kind `extract` commands exist
  because ingest did not, and now it does.
- **The `InterviewKind` enum**, which is a second list of primitives that has to
  be kept in step with the first.

That last one is why this is worth doing beyond tidiness: litfire currently has
`INGEST_KINDS` (nine) and `InterviewKind` (four) describing the same concept.
Two lists of the same thing is how they drift.

## One thing must not collapse

**An interview is not a questionnaire**, and the difference is the project's
founding claim about its own value. The persona says so in the imperative:

> Ask ONE question at a time. Never stack. Never number a list of questions.
>
> Follow the energy. When an answer gets longer, more detailed, or more
> opinionated, that is the seam. Dig there. Abandon your planned line of
> questioning without hesitation — the plan is a fallback, not a script.

And `interview/prompts.ts` states the thesis outright: _the spec's whole thesis
is that a good interview produces a better world than a good form._

So `/questions <kind>` must **conduct** an interview, not print a list. It is
named for what the author is getting — questions — not for how they arrive. If
it ever generates a numbered set of questions and waits, the command has become
a form and the tool has lost the thing it was built to be.

What becomes per-kind is the **brief**: the territory to cover, which already
exists as `BRIEFS` for four kinds and needs writing for five more. The persona,
which is where the craft lives, stays one text.

## The loop this closes

`/questions` today lists what the deterministic checks found unresolved:

```
open questions (4)
oq-002  moment_undated
        moment 'the-bicameral-era' has no position on the clock
```

That queue is an agenda nobody acts on. Under this proposal `/questions moment`
opens on exactly those gaps — the checks decide what is worth asking about, and
the interview asks it.

That is a genuine unification rather than a rename:

| Today                                     | Becomes                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| Checks find a gap → `/questions` lists it | Checks find a gap → `/questions <kind>` asks about it |
| Interview follows a fixed brief           | Brief, narrowed by what is actually missing           |
| Extraction reports `open_fields`          | Those _are_ the queue                                 |

It also answers the thing that blocked retiring the old extract path. Extraction
returns `writes`, `open_fields` and `contradictions`; ingest returns proposals
only. Under this design `open_fields` has somewhere to go — the check queue —
and `contradictions` becomes what it already should be: an open question the
author settles, never the tool.

## The command model

| Command                    | Does                         |
| -------------------------- | ---------------------------- |
| `/questions`               | The open queue, as now       |
| `/questions <kind>`        | Interview me about that kind |
| `/questions <kind> <id>`   | About that one thing         |
| `/questions <kind> resume` | Continue the saved interview |
| `/ingest <kind>`           | File what I said             |
| `/<kind> extract`          | The same, from the primitive |

`/system`, `/character`, `/timeline` and `/themes` retire. `/timeline` and
`/themes` keep their _view_ — they render a structure, which is a different job
from interviewing about one — and lose only their interview directives.

## What it costs

- **Five briefs to write**, for place, arc, situation, faction and artifact.
  These are product, not scaffolding: a bad brief produces a bad interview, and
  `BRIEFS` is some of the most carefully written text in the repo.
- **`/character carl` becomes `/questions character carl`.** Longer, and the
  muscle memory is real. Worth it only because it is one shape for nine kinds
  rather than four spellings for four.
- **A window where both exist.** The old commands should keep working through a
  release rather than being cut the day the new one lands.

## Decided

**A kind with no gaps says so, and offers anyway.**

```
› /questions theme

no open questions about themes.
begin interview anyway? y/N
```

Not silence, and not an interview that starts without being asked for. The two
sessions are genuinely different work — one fills gaps the checks found, the
other goes deeper into a kind that is already consistent — and the prompt is
what tells the author which one they are about to be in.

The default is **no**. An interview costs a model session and an hour of the
author's evening, so `return` declines. That also makes `/questions <kind>` safe
to type when you only wanted to know whether anything was outstanding, which is
most of the time.

The asymmetry is deliberate: when there _are_ findings, it just begins. There is
a reason to be asking and the author already knows what it is.

**What this costs to build:** a shape the command layer does not have yet. Both
existing confirms — the review gate's, and the buffer's discard — live inside a
full-screen component that owns the keyboard. Nothing today lets a command
return a question to the composer and resume on the answer. That is worth
building properly rather than special-casing, because `/ingest adopt` sweeping
25 pages and `/wiki serve` rebinding a busy port both want the same thing.

## Open questions

1. **Do situations get interviewed at all?** A scene is written, not elicited.
   Perhaps `/questions situation` asks about what a scene _needs_ — cast, place,
   moment — rather than about its content.
2. **What happens to `/timeline` and `/themes` as views?** Keeping the name for
   the view while the interview moves is either obvious or confusing, and I do
   not know which until it is used.

## Sequencing

1. ~~`/questions <kind>` alongside the existing commands, for the four kinds
   that already have briefs. Nothing retires; both work.~~ **Done.**
2. ~~Briefs for the remaining five.~~ **Done** — seven in the end, not five.
   `place`, `situation`, `faction`, `artifact` and `chapter` had nothing, and
   the `timeline` brief split along the seam it always had into `moment` and
   `arc`. Every primitive has one, and a test asserts it, so a kind added
   without a brief fails there rather than in front of an author.
3. ~~The check queue narrows the brief — the loop closes.~~ **Done.** The
   agenda is a layer in the system prompt, between the brief it narrows and the
   grounding that makes it legible. Only findings representing a decision the
   author has not made reach it; a stat out of range or two files claiming one
   id is housekeeping, has an answer that is looked up rather than asked for,
   and goes to `/lint`.
4. The four old commands are removed, and the two vestigial `InterviewKind`
   members — `timeline` and `themes` — with them.
