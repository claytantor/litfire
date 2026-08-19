# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0`, the on-disk vault format may change between minor versions. Any
change that requires an existing vault to be migrated is called out under
**Vault format** with what to do about it.

## [Unreleased]

### Added

- `/architect` — a conversational agent over the raw interviews _and_ the
  corpus, which proposes structural changes through the review gate. It reads
  `raw/` and never writes to it.
- `/primitives [kind]` — every id in the vault, grouped by kind.
- Artifacts: things a character uses to achieve an outcome, with
  `acquire_artifact`, `lose_artifact` and `use_artifact` ledger events.
- Character systems as a primitive: a vault may hold several, a character is
  under exactly one, and `port` moves them between systems.
- Moments: one page per point where the terms of the world change, replacing the
  single `timeline/world-events.md` list.
- Cross-domain spillover — an interview that establishes something outside its
  own domain now proposes a stub page for it rather than losing it.

### Fixed

- Terminal resize no longer leaves fragments of earlier frames on screen
  ([ink#907](https://github.com/vadimdemedes/ink/issues/907), unfixed upstream;
  carried here as `patches/ink@7.1.1.patch`).
- A replay no longer leaks off-heap memory through `isolated-vm`, and derives a
  level once per replay rather than once per XP event.
- A truncated model response is reported as hitting the output limit rather than
  as malformed JSON.

### Vault format

- `timeline/world-events.md` still loads, as a list of moments. Nothing needs
  migrating; new moments are written to `timeline/moments/<id>.md`.
- `system/stats.md`, `system/skills.md` and `system/curves.md` still load, as one
  system with the id `system`. A character that names no system is placed in it
  when it is the only one.

## [0.1.0]

Initial development. Not yet released.
