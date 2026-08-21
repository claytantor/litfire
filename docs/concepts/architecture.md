# Architecture

```
source/
  domain/schema.ts      zod schemas — the whole data model
  vault/                markdown I/O, layout, scaffold, generated-region markers
  system/               formula extraction + the isolated-vm sandbox
  ledger/               replay, deterministic checks, derived-file projections
  themes/coverage.ts    leaf-level coverage
  core/project.ts       load → replay → check → coverage
  llm/                  provider catalog, credentials, adapters
  commands/             command registry and views (plain data, not Ink nodes)
  components/           Ink: composer, footer, pager, line renderer
```

## The vault

Three top-level directories say who owns what, which is the whole reason they
are named the way they are.

```
raw/          you write this — freeform, no schema, one folder per primitive
  arcs/ artifacts/ chapters/ characters/ factions/
  moments/ places/ situations/ systems/ themes/
  interviews/                 transcripts, timestamped

corpus/       derived from raw/ — typed, linked, validated, regenerable
  arcs/ artifacts/ chapters/ characters/ factions/
  moments/ places/ situations/ systems/ themes/

setting/      how this vault reads, as opposed to what is in it
  setting.md                  descriptors and the idiom reference
  idiom.md                    per-vault vocabulary override
  formulas.md                 unscoped formulas, reachable from every system
  time.md                     the clock binding

ledger/       computed on every load — state, open questions
wiki/         computed by /wiki build
index.md · log.md · manuscript.md
```

`raw/` and `corpus/` mirror each other exactly, one folder per primitive with
the same name, so `raw/moments/the-breach.md` and `corpus/moments/the-breach.md`
are obviously the same thing at two stages. `/init` seeds both, and the corpus
page carries `source` and `source_hash` naming the note it came from — which is
what makes the corpus safe to delete and rebuild.

**Every path a previous layout used is still read.** `LEGACY_DIRECTORIES` and
`LEGACY_FILES` in `source/vault/paths.ts` map each old home to its new one, and
`loadKind` walks the canonical home first so a page you have already moved wins
over the copy left behind. Nothing writes to an old home, and `/lint` reports
each one it read — once per directory, not once per page, because a half-moved
vault has both copies of everything by definition.

## Replay

Replay is a pure function of `(system, timeline, situations)`. It recomputes in
full on every change — at novel scale that is milliseconds, and a pure function is
much easier to trust than a cache.

Command handlers return `Line[]` rather than Ink elements, so they are unit
testable without a renderer.
