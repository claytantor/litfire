# Proposal — the interface is the specification

**Status:** proposed, not accepted
**Wants:** two capabilities — generating a stats model, and executing it per scene

## The idea, restated

An author designs the **interface**: the status screen a character sees, in the
voice of their world. From that, the tool derives what stats must exist and how
each one is computed, as sandboxed code. Replay then executes that model at
every situation, so each scene can show every character in it exactly as the
world would show them.

The inversion is the good part. The author writes the fiction-facing artifact —
the thing a reader will actually see on the page — and the machinery is derived
from it, rather than the author being asked to specify a data model and hope a
readable screen falls out.

## What is already here

More than it looks, and one piece is stranded.

|                      |                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Stats                | Declared per system: `id`, `name`, `min`, `max`, `default`, `allow_negative`                           |
| How they change      | Ledger events only — `{type: stat, stat: x, delta: n}` during replay                                   |
| Formulas             | ` ```js id=… ` blocks, extracted and run in **isolated-vm** — 16 MB, 100 ms CPU, consent-gated by hash |
| What calls a formula | **`xp_for_level`. That is the entire list.**                                                           |
| The interface        | Three hard-coded templates — `sheet`, `hud`, `inline` — chosen by the _genre profile_, not the author  |
| Per-scene state      | `castOf(replay, clock, situation)` already returns every character in a scene, with their state at it  |

Two things stand out.

**The scaffold ships a formula nothing consumes.** `/init` writes
`max-hp: ({constitution, level}) => 50 + constitution * 8 + level * 12` into
`setting/formulas.md`, and no code anywhere reads it. The sandbox, the
extraction, the consent gate and the memory-safe call path are all built and
tested — for one caller. **Derived stats are half-implemented already**, and
the shipped example is a promise the tool does not keep.

**The interface is not the author's.** `status_template` comes from the genre
profile, so an arcane vault gets `sheet` and a technological one gets `hud`.
The author cannot say what their System's screen looks like, which is precisely
what this proposal needs them to say.

## Capability one — a stats model derived from the interface

### The interface, as the author writes it

A block on the system's page, in the world's own voice, with the values marked:

````markdown
```interface
    ┌─ THE LATHE ─────────────────────────────┐
    │  {name}                    TIER {level} │
    │                                         │
    │  COHERENCE   {coherence}/{max_coherence}│
    │  RESONANCE   {resonance}/10             │
    │  FLUX        {flux}                     │
    │                                         │
    │  {skills}                               │
    └─────────────────────────────────────────┘
```
````

That is a specification and a rendering at once. `coherence` must exist.
`max_coherence` must exist and is plainly derived rather than accumulated.
`resonance` has a ceiling of 10 stated in the interface itself.

### What `/system generate stats` does

Reads the interface, the system's existing stats, and the prose on the system's
page, and proposes:

- **stat declarations** for every placeholder that has none, with the `min` and
  `max` the interface implies;
- **a formula per derived stat**, as a ` ```js id=… ` block;
- **a worked table** — see below — and nothing else.

Every one of those is a diff through the review gate, like every other write.

### Derived stats need one schema field

```yaml
stats:
  - id: max_coherence
    name: Max Coherence
    formula: max-coherence # ← the whole change
```

A stat with a `formula` is computed; a stat without one is accumulated by
events. That mirrors `curves.xp_for_level` exactly, which is the pattern the
codebase already uses for "a schema field naming a formula", and it means the
sandbox contract does not change at all.

## Capability two — executing it, per scene, per character

Replay already produces state at every step, and `castOf` already returns the
cast of a situation with that state. What is missing is the evaluation pass and
the rendering:

1. After the accumulated stats are known at a step, evaluate the derived ones in
   dependency order.
2. Render the interface for each character in the scene, substituting values.
3. Offer it where the author wants it — `/situation <id> sheet`, a block written
   into the scene by `/status write`, and a section on the wiki page.

Nothing about that needs a model. It is arithmetic and substitution, which is
the half of this tool that is deliberately not a model's job.

## The four hard parts

### 1. TypeScript, or JavaScript?

The request says TypeScript formulas. The sandbox runs **JavaScript**, and the
consent gate hashes the source the author read. Compiling TypeScript would put a
compiler inside the trusted path and make the hashed artifact different from the
audited one, which is the property consent depends on.

**Recommendation: keep the sandbox JavaScript, and make the _contract_ typed.**
The generated block is JS; the shape it receives and returns is a TypeScript
type in the tool, checked at the boundary, and stated in the generation prompt.
The author reads and consents to exactly what runs.

If TypeScript in the block is wanted for its own sake, it should be a separate,
deliberate decision about the consent model, not a side effect of this feature.

### 2. A derived stat must not be accumulable

`{type: stat, stat: max_coherence, delta: 5}` against a computed stat is a
contradiction: replay would apply it and the next evaluation would overwrite it.
The schema cannot express "accumulated or derived, never both" on its own, so
this needs a check — `stat_is_derived`, reported and never silently resolved.

### 3. Derived stats form a graph, and graphs cycle

`max_coherence` may depend on `tier`, which depends on `coherence`. That is a
dependency order and it can be circular. It needs a topological sort and a cycle
check — a cycle is an author error the tool must report rather than hang on.

### 4. Cost, which should be measured rather than guessed

One call per derived stat, per character, per step. A novel with 200 situations,
five characters and six derived stats is 6,000 sandboxed calls. The existing
call path already carries a memory note about `ExternalCopy` accumulating under
exactly this kind of loop. **Measure before designing around it**, and if it
bites, evaluate lazily — a stat nobody displays at a step does not need
computing there.

## The risk nobody has named yet

**A generated formula is a number, and this project's hardest rule is that the
tool never invents one.**

Everywhere else that rule is easy to honour, because an invented fact is legible
as a sentence — an author reads "her brother, who does not know he has any" and
knows whether it is true. Nobody can read `50 + con * 8 + level * 12` and tell
whether it is right for their book. It compiles, it looks plausible, and it is
wrong in a way that only shows up four hundred pages later when a fight is
unlosable.

So the generation pass must not propose a formula alone. It proposes a formula
**and a worked table**:

| constitution | level | max_hp |
| ------------ | ----- | ------ |
| 8            | 1     | 126    |
| 12           | 5     | 206    |
| 12           | 20    | 386    |

The author reviews the _behaviour_, which they can judge, instead of the
_expression_, which they cannot. If the level-20 number looks absurd for their
world, they reject it — and that is a judgement they are qualified to make in a
way that reading arithmetic never is.

This is the same shape as everything else here: the model proposes, the author
decides, and the decision is put in terms the author can actually decide on.

## Sequencing

1. **Derived stats, hand-written.** The `formula:` field, the dependency sort,
   the cycle and accumulation checks. No model involved, and it makes the
   scaffold's stranded `max-hp` mean something.
2. **The author's interface.** The `interface` block on a system page, replacing
   the profile's choice of three templates for vaults that define one.
3. **Per-scene rendering.** `/situation <id> sheet`, the wiki section, and
   `/status write` using the author's interface.
4. **`/system generate stats`.** The model pass, last — it is the only part that
   needs the other three to exist before it can be judged.

Steps 1–3 are useful on their own to an author who wants to write their own
formulas, which is the test of whether the sequence is honest.

## Open questions

1. **Where does the interface live?** A fenced block on the system page reads
   well and is greppable. A separate `setting/interface.md` is easier to render
   from. The block is probably right, because it sits next to the stats it
   refers to.
2. **What renders for a character with a stat the interface does not mention?**
   Silence hides state the ledger is tracking; showing it breaks the author's
   design. Probably silence, with `/sheet` remaining the complete view.
3. **Does the interface vary by character?** A System that shows different
   people different things is a good story idea and a large feature. Out of
   scope here, but the design should not make it impossible.
