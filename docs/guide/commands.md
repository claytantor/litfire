# Commands

| Command                        | Behaviour                                        |
| ------------------------------ | ------------------------------------------------ |
| `/init [idiom] [path]`         | Scaffold a vault; asks the idiom if omitted      |
| `/project [path]`              | Switch vaults, or list recent ones               |
| `/consent`                     | Allow this vault's formulas to execute           |
| `/sheet <character> [at]`      | Replayed state, optionally at a point in the run |
| `/status <character> [at]`     | The same state as an in-world status block       |
| `/status write <char> <sit>`   | Place that block inside a situation              |
| `/pacing`                      | Planned vs actual level by arc                   |
| `/timeline`                    | Structural view; world events, arcs, inbox       |
| `/themes`                      | Leaf-level coverage with upward rollup           |
| `/<kind> show`                 | What that interview has produced so far          |
| `/<kind> resume`               | Continue the saved interview                     |
| `/<kind> extract`              | Re-run extraction over its saved transcript      |
| `/chapter [id\|new\|move]`     | Cut the sequence into chapters; show the seams   |
| `/export [path]`               | Assemble the chapters into a manuscript          |
| `/wiki [build\|serve\|stop]`   | Derived cross-reference, browsable over http     |
| `/reviewer`                    | Literary editor over the rendered corpus         |
| `/lint`                        | Deterministic checks                             |
| `/questions`                   | Open question queue                              |
| `/provider`                    | Choose an LLM provider, key, and model           |
| `/provider status`             | Show configured providers and masked keys        |
| `/provider clear <id>`         | Remove a stored key                              |
| `/situation <id>`              | A scene’s cast: who is in it, and what they hold |
| `/situation <id> edit`         | Write a scene in the native buffer               |
| `/situation <id> cast <name>…` | Add characters to the scene                      |
| `/situation <id> place <id>`   | Where the scene happens                          |
| `/situation <id> moment <id>`  | Anchor the scene on the clock                    |
| `/situation <id> arc <id>`     | Place it on an arc, out of the inbox             |
| `/situation new [title]`       | Scaffold a scene and open it in the buffer       |
| `/arc [<id>]`                  | Arcs, or one arc with the scenes on it           |
| `/arc new [title]`             | Create an arc                                    |
| `/arc <id> after <moment>`     | Anchor an arc on the clock                       |
| `/arc <id> order <n>`          | Set its replay order                             |
| `/time`                        | The in-world clock and the calendar it reads by  |
| `/time gregorian <epoch>`      | Bind the clock to Earth/Sol time                 |
| `/time custom`                 | Read it through a calendar formula you wrote     |
| `/time at <date>`              | Convert a date to seconds, or back               |
| `/situation place <id> <arc>`  | Move a situation out of the inbox                |
| `/help`, `/quit`               |                                                  |

Output taller than the viewport opens a windowed pager (`↑↓`, space, `g`/`G`, `q`).

`↑`/`↓` in the composer walk command history, shell-style: back through what you
have run, forward again, and past the newest entry your half-typed line comes
back rather than an empty box. Consecutive duplicates collapse, so running
`/lint` four times costs one slot.

History lives in `.litrpg/history.json`, per vault — `/character carl` means
nothing in another book, so switching projects swaps the list rather than mixing
two manuscripts together. Deleting `.litrpg/` costs only convenience (DoD 11).
