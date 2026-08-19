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

Replay is a pure function of `(system, timeline, situations)`. It recomputes in
full on every change — at novel scale that is milliseconds, and a pure function is
much easier to trust than a cache.

Command handlers return `Line[]` rather than Ink elements, so they are unit
testable without a renderer.
