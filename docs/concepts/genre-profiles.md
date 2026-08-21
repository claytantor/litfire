# Genre profiles

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

## What a profile controls

Lexicon, interview overlays, starting archetypes, register. **Not** ledger
semantics, event types, the formula sandbox, the timeline model, checks, or file
layout. If a proposed profile feature would change how state is computed, it is
an engine feature that every profile gets.

## Setting descriptors

Three fields on `setting/setting.md`, deliberately not a genre enum — they
describe the design space better than a binary would, and the interview branches
on them:

- `system_origin` — divine · arcane · technological · simulated · emergent · unexplained
- `system_visibility` — character · universal · privileged · reader-only
- `system_agency` — agent · bureaucracy · physics · unknown

A technological or simulated origin means "it just works" is not available as an
answer, and the interviewer is told so. `unexplained` is a real choice, and the
interviewer is told **not** to press on it.

## Lexicon resolution

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

## Overlays

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

## Blends

`extends` accepts a list with later entries winning, so science-fantasy is data:

```yaml
extends: [arcane, technological] # charge and decks, but gold and enchantments
```

Post-MVP profiles (`cultivation`, `superhero`, `corporate-dystopian`) are
data-only additions.

## Editing the lexicon

`/idiom set <key> <term>` and `/idiom unset <key>` write the per-vault override
at `setting/idiom.md`, where author edits win over the shipped profile (§3.2):

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

## Status blocks

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
