# Contributing

Thanks for looking. This is a tool for writing novels, so the bar for a change
is whether it helps somebody finish one.

## Getting set up

```bash
git clone https://github.com/claytantor/litfire.git
cd litfire
pnpm install     # compiles isolated-vm, so you need g++, make and python3
pnpm check       # typecheck → lint → format → test
pnpm dev         # run the TUI against a vault in the current directory
```

`pnpm vault:new <name>` scaffolds a throwaway vault under `vaults/`. That whole
directory is gitignored with no exceptions — a vault is somebody's writing and
never belongs in this repository — and the script refuses to create one unless
git confirms it is ignored, so a broken `.gitignore` fails loudly rather than at
commit time. Put real prose in there if it helps; none of it can be committed.

Never point the tool at a vault you care about while developing.

## What `pnpm check` covers

`tsc --noEmit`, `oxlint`, `prettier --check`, then `vitest run`. It is the one
command CI runs and the floor for any pull request.

Live provider tests are **skipped by default**. They hit real endpoints with a
deliberately invalid key to assert the failure path, and they are opt-in so a
first `pnpm test` never depends on the network:

```bash
LITFIRE_LIVE_TESTS=1 pnpm test
```

Run those before touching anything in `source/llm/`.

## The principles the code is written to

These are not style preferences; several of them are load-bearing and the code
comments will refer to them.

- **The filesystem is the API.** Everything is markdown on disk, and Obsidian is
  a first-class peer. If a feature would only work through the TUI, it is the
  wrong shape.
- **Derived state is regenerated, never edited.** `ledger/`, `wiki/` and
  `manuscript.md` are outputs. `raw/` is the author's own record: only
  `/architect` may propose changes there, on the author's instruction and still
  only as a diff they accept — every other path to disk is closed to it. Both
  rules are enforced in `resolveInsideVault`, not by convention.
- **Nothing lands without an explicit decision.** Every model-proposed write
  goes through the review gate as a diff the author accepts or rejects.
- **Report, never block.** A contradiction becomes an open question. The tool
  does not refuse to load a vault because something is unfinished, and it does
  not resolve a contradiction on the author's behalf.
- **Never invent.** Not a proper noun, not a number, not a date. If the material
  does not answer a field, leave it out and let the checks ask.

## Prompts are product

The interview, extraction, editor and architect prompts in
`source/interview/prompts.ts`, `source/interview/extract.ts`,
`source/editor/prompts.ts` and `source/architect/prompts.ts` are the substance of
this tool, not scaffolding around it. Changing one is a real change. Say what
evidence moved you — a transcript that came out better is worth more than an
argument that it reads better.

## Comments explain why

The codebase leans on comments that explain a decision, especially a
non-obvious one. `// increments the counter` is noise; `// the id is the
filename stem a wikilink resolves against, so renaming one has to rewrite every
reference in the same batch` is the kind that earns its place. If you worked
something out the hard way, leave that in the code so the next person does not.

## Tests

Match the surrounding style: a test name states the behaviour, and a comment
above a non-obvious assertion says what would break without it. Prefer a test
that fails for the real reason over one that pins an implementation detail.

If you are fixing a bug, write the failing test first and make sure it fails for
the reason you think it does.

## Pull requests

- Branch from `main`.
- Keep it to one thing. A refactor bundled with a fix is two reviews.
- Fill in the template, especially the last section — what a reviewer should
  push back on is the most useful thing in it.
- Do not add AI attribution or co-author trailers to commits. A `pre-commit`
  hook enforces this; install the hooks with `pnpm hooks:install`.

## Reporting bugs

Open an issue with the smallest reproduction you can manage. A vault is markdown
on disk, so a short file plus the command usually is one. Security issues go
through [private reporting](https://github.com/claytantor/litfire/blob/main/SECURITY.md)
instead.
