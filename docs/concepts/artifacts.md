# Artifacts

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
