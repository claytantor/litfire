# Getting started

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

::: warning `pnpm dev` does not watch
It is `tsx source/cli.tsx` — the modules are loaded once at startup. A change to
anything under `source/` is invisible until you `/quit` and start it again, and
a long-lived session on a fast-moving branch will quietly be running code from
whenever you launched it. Deliberate: hot-reloading a full-screen TUI mid-write
would be worse than restarting it.
:::

Then, in the TUI:

```
/init        scaffold the vault
/consent     allow this vault's formulas to execute
/sheet carl  see replayed state
```
