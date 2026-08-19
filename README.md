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

Full documentation: **[claytantor.github.io/litfire](https://claytantor.github.io/litfire/)**

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
| `/reviewer`                   | Literary editor over the rendered corpus         |
| `/lint`                       | Deterministic checks                             |
| `/questions`                  | Open question queue                              |
| `/provider`                   | Choose an LLM provider, key, and model           |
| `/provider status`            | Show configured providers and masked keys        |
| `/provider clear <id>`        | Remove a stored key                              |
| `/situation [<id>]`           | A scene’s cast: who is in it, and what they hold |
| `/situation new [title]`      | Scaffold a scene and open it in the buffer       |
| `/situation edit <id>`        | Write a scene in the native buffer               |
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

## Documentation

The README is the short version. Everything below lives on the
[documentation site](https://claytantor.github.io/litfire/), which is built from `docs/` in this repository.

| Guide                                                                         |                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------- |
| [Writing a scene](https://claytantor.github.io/litfire/guide/writing-a-scene) | The native prose buffer                           |
| [Interviews](https://claytantor.github.io/litfire/guide/interviews)           | How the world gets built, and the interview agent |
| [Review gate](https://claytantor.github.io/litfire/guide/review-gate)         | How a model-proposed write reaches disk           |
| [The reviewer](https://claytantor.github.io/litfire/guide/reviewer)           | A literary editor over the rendered corpus        |
| [Projects and vaults](https://claytantor.github.io/litfire/guide/projects)    | Switching vaults, and what a vault holds          |

| Concepts                                                                             |                                                    |
| ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| [Architecture](https://claytantor.github.io/litfire/concepts/architecture)           | How the pieces fit                                 |
| [Character systems](https://claytantor.github.io/litfire/concepts/character-systems) | Stats, skills, curves, and porting between systems |
| [Artifacts](https://claytantor.github.io/litfire/concepts/artifacts)                 | What a character uses to achieve an outcome        |
| [Assembly](https://claytantor.github.io/litfire/concepts/assembly)                   | Situations into chapters into a manuscript         |
| [The wiki](https://claytantor.github.io/litfire/concepts/the-wiki)                   | The generated, Obsidian-compatible world bible     |
| [Genre profiles](https://claytantor.github.io/litfire/concepts/genre-profiles)       | One engine, many idioms                            |
| [The LitRPG genre](https://claytantor.github.io/litfire/concepts/litrpg)             | What this tool assumes about the genre             |

| Reference                                                                             |                                     |
| ------------------------------------------------------------------------------------- | ----------------------------------- |
| [Model providers](https://claytantor.github.io/litfire/reference/providers)           | Choosing a provider, key, and model |
| [The formula sandbox](https://claytantor.github.io/litfire/reference/formula-sandbox) | Why formulas run in an isolate      |
| [Scripts](https://claytantor.github.io/litfire/reference/scripts)                     | What each script in `scripts/` does |

| Project                                                                       |                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------ |
| [Committed decisions](https://claytantor.github.io/litfire/project/decisions) | Why the architecture is the way it is            |
| [Build status](https://claytantor.github.io/litfire/project/status)           | Progress against the definition of done          |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                          | Setting up, the principles, and sending a change |
| [`SECURITY.md`](SECURITY.md)                                                  | Credentials, the sandbox, and reporting          |
| [`CHANGELOG.md`](CHANGELOG.md)                                                | What changed, and any vault-format migrations    |

## License

MIT — see [LICENSE](LICENSE).
