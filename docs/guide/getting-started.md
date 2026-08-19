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

Then, in the TUI:

```
/init        scaffold the vault
/consent     allow this vault's formulas to execute
/sheet carl  see replayed state
```
