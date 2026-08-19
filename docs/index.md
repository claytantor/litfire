---
layout: home

hero:
  name: litfire
  text: Write the scene. The tool keeps the numbers straight.
  tagline: >
    A LitRPG authoring tool. The author writes freeform situations; the tool
    tracks game state deterministically and records contradictions as open
    questions that never block writing.
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: Commands
      link: /guide/commands
    - theme: alt
      text: View on GitHub
      link: https://github.com/claytantor/litfire

features:
  - title: Arithmetic is checked, not hoped over
    details: >
      A large fraction of LitRPG consistency is arithmetic, not judgment. Levels,
      XP, stat derivations and skill prerequisites are checkable by code, so they
      are checked by code — never handed to a model and hoped over.
  - title: The filesystem is the API
    details: >
      Everything is markdown on disk, and Obsidian is a first-class peer. Open
      the vault whenever you like, edit anything, and the TUI reflects it. A
      feature that only works through the TUI is the wrong shape.
  - title: Nothing lands without a decision
    details: >
      Every model-proposed write goes through a review gate as a diff you accept
      or reject, one at a time. Derived state is regenerated and never edited;
      raw/ is your own record and the tool never writes to it.
  - title: Report, never block
    details: >
      A contradiction becomes an open question, not an error. The tool does not
      refuse to load a vault because something is unfinished, and it never
      resolves a contradiction on your behalf.
---
