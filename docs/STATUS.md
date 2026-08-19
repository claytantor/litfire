# Build status against the requirements

Where the implementation stands against the definition of done in the
original requirements. Kept out of the README because it is a record of
progress rather than something a new reader needs.

## Slice 1 status

Implemented — the deterministic core, which the requirements state must stand
alone as a useful product:

| Definition of done                          | State                                   |
| ------------------------------------------- | --------------------------------------- |
| 1. `/init` → connected Obsidian graph       | done                                    |
| 2. Stat system with an evaluated formula    | done                                    |
| 3. Timeline of world events and arcs        | done (schema, views, and interview)     |
| 4. Situations placed and in inbox, watched  | done (chokidar, 300 ms debounce)        |
| 5. `/sheet` correct at any point            | done (per-step snapshots)               |
| 6. Skill-before-acquisition → open question | done                                    |
| 7. Milestone drift → open question          | done                                    |
| 8. `/pacing` planned vs actual              | done                                    |
| 9. `/ingest` → reviewable proposals         | provider layer done; ingest not started |
| 10. Theme coverage at leaf level            | done                                    |
| 11. Deleting `.litrpg/` loses only cache    | done                                    |
| 12. Whole flow with no API key              | done                                    |

The provider abstraction from §9 is done — `/provider`, four providers, and a
streaming `complete()`. The four interviews and the review diff gate are done
too; the requirements call the gate reusable by Slice 2, so it was built generic
and UI-free in `source/review/` rather than bolted onto the interview flow.

## Slice 1.5 status

Done — the three deferrals, now landed:

| Deferral                                        | State                                   |
| ----------------------------------------------- | --------------------------------------- |
| Native Ink prose buffer (§10)                   | done; `$EDITOR` is now the escape hatch |
| Status block templates (`sheet`/`hud`/`inline`) | done; `/status` and `/status write`     |
| Lexicon editing from `/idiom`                   | done; `/idiom set` and `/idiom unset`   |

Everything in §12 remains deferred.

## Slice 2 status

Per `docs/LITRPG.md` §6 step 6, Slice 2 is **assembly** — ordering, reconciling,
and connecting situations into chapters while preserving the spirit of each
scene. The deterministic half is done and works with no API key:

| Piece                                | State          |
| ------------------------------------ | -------------- |
| Chapter entity + vault wiring        | done           |
| Partition the sequence into chapters | done           |
| Seam detection (reconcile)           | done — 5 kinds |
| `/chapter`, `/chapter new`, `move`   | done           |
| `/export` → manuscript               | done           |
| LLM boundary + transition proposals  | not started    |

Also outstanding from the Slice 1 list: `/ingest` (which the scaffolded
`raw/README` already advertises) and the LLM lint pass — `/lint` currently runs
deterministic checks only.

Committed answers to the §14 open decisions are in [docs/DECISIONS.md](docs/DECISIONS.md).
