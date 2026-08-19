# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/claytantor/litfire/security/advisories/new)
rather than opening a public issue. You should get an acknowledgement within a
week.

## What this tool does with your credentials

Provider API keys are **never written into a vault**. A vault is a folder people
sync, share, and open in Obsidian, so a key stored there would ride along with
all of that. Keys live in `~/.config/litfire/credentials.json` at mode `0600`,
created with those permissions rather than tightened afterwards.

Three sources are consulted, in order — the env var, the file its `…_FILE`
variant names, then the stored key. `/provider status` always names which one
supplied the key, so a stale value cannot win silently. Nothing masks a key on
its way to a provider, and nothing logs one: `maskKey` is the only rendering
path, and it is what `/provider status` and the wizard both use.

## Author-supplied formulas run in an isolate

`system/formulas.md` holds executable JavaScript. It is evaluated in
[`isolated-vm`](https://github.com/laverdet/isolated-vm) — a separate V8 isolate
with its own heap, a 16 MB memory cap, and a 100 ms CPU timeout per call.
`node:vm` is deliberately not used: it shares a heap with the host and is not a
security boundary.

A vault you did not write does not evaluate its formulas until you say so.
`computeProject` compares a hash of the formula sources against the consent
recorded in config, and runs with formulas disabled when they differ. That is
what `/consent` records.

The isolate also has `Math.random`, `Date.now`, `Date.parse`, `Date`, and the
timer functions removed before any author code runs — required for deterministic
replay, and it narrows the surface as a side effect.

## Paths a proposal may never target

Every model-proposed write passes `resolveInsideVault`, which compares canonical
paths rather than testing for `..`. It refuses absolute paths, null bytes,
anything escaping the vault, anything that is not markdown, and anything under
`.litrpg/`, `ledger/`, `raw/`, `wiki/`, or `manuscript.md`.
