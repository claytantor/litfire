# Projects and vaults

## Projects

litfire works on one vault at a time, and switches without restarting.

```bash
litfire ~/novels/starfall       # open that vault
litfire .                       # open the current directory
litfire                         # reopen the vault you worked in last

/project                        # current vault + recent ones
/project ../other-book          # relative paths work like cd
/project ~/novels/starfall      # ~ is expanded by the TUI
/init technological ../sf-book  # scaffold elsewhere and switch there
```

A path argument always wins, `.` included — that is how you say "this directory,
not wherever I was last". Only a bare `litfire` consults the remembered project,
and it says so in the banner, because opening a directory other than the one you
are standing in is a surprise otherwise. If the remembered vault has been deleted
or moved, litfire opens the launch directory and names what went missing rather
than failing to start.

The footer shows the active project name. Switching re-keys everything that is
scoped to a vault — recompute, the file watcher, grounding, the active
character — and clears any open pager, review, or interview, because those
belong to the vault you just left.

Switching to an **empty directory is allowed**, because that is how a new book
starts; litfire says it is not a vault yet and points at `/init`. A path that
does not exist, or that is a file, is refused.

A directory counts as a vault when it has `system/` or `index.md` — written only
by `/init`. Deliberately **not** `.litrpg/`: that appears wherever litfire has
merely been run, because `/provider` and interview metrics create it.

### `~/.litfire`

The last-opened project and the recents list live in `~/.litfire/state.json`,
outside every vault. This is cross-project state, and a list of your other book
paths does not belong in a folder you might share or sync. `LITFIRE_HOME`
overrides the directory.

```json
{
  "version": 1,
  "lastProject": "/home/you/novels/starfall",
  "projects": ["/home/you/novels/starfall", "/home/you/novels/inanna"]
}
```

`lastProject` only advances for an actual **vault**. Running litfire in a plain
directory — to `/init` it, or by accident — still lists that directory under
`/project`, but never makes it the thing a bare `litfire` reopens tomorrow.

An older `$XDG_CONFIG_HOME/litfire/recent.json` is inherited on first run, minus
any path that no longer exists. **API keys were not moved** and still live in
`$XDG_CONFIG_HOME/litfire/credentials.json` at mode 0600 — key material does not
get relocated as a side effect of a convenience feature.

## Local story vaults

Test vaults live under `vaults/`, which is gitignored. Create one:

```bash
pnpm vault:new my-story     # creates vaults/my-story, then opens litfire
```

Then run `/init` inside litfire to scaffold it. The script asks **git itself**
whether the path is ignored (`git check-ignore`) and refuses to create the vault
if it isn't — so a broken `.gitignore` fails loudly at creation rather than
silently at commit time.

Nothing under `vaults/` is ever committed, so real prose and real experiments are
safe there.

### Keeping credentials and vaults out of commits

Three layers, because `.gitignore` alone is not enough — it does nothing against
`git add -f`, and nothing for a file that is already tracked.

1. **Keys live outside the repo by default** — `~/.config/litfire/credentials.json`
   at mode `0600`. The vault stores only the provider id and model.
2. **`.gitignore`** covers `vaults/`, `.litrpg/` anywhere, `credentials.json`,
   `.env*`, and private-key extensions. The vault-shaped patterns
   (`/system/`, `/themes/`, `/ledger/` …) are **root-anchored on purpose**:
   unanchored, they would silently stop tracking `source/system/`,
   `source/themes/`, and `source/ledger/`.
3. **A pre-commit hook** — opt in once:

   ```bash
   pnpm hooks:install     # sets core.hooksPath to .githooks
   ```

   It blocks any commit containing a credentials file, `.litrpg/` content,
   anything under `vaults/`, private key material, or a live-looking API key
   (`sk-ant-…`, `sk-proj-…`, long `sk-…`, `AKIA…`) in any file. Run the same
   check by hand over the whole tree with `pnpm check:secrets`.

   The same install also adds a `commit-msg` hook that blocks **AI attribution**
   — co-author trailers naming an assistant, "generated with" notices, robot
   emoji, and assistant noreply addresses — from commit messages, trailers, and
   file contents. Commits here are the author's work and are recorded that way.

   A legitimate human co-author trailer is unaffected, and references to the
   Anthropic API (`@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`) are not attribution
   and never trip it: the patterns match attribution _forms_, not the vendor
   name. Check by hand with `pnpm check:attribution`.

   The exact patterns live in `scripts/check-attribution.sh` — deliberately not
   reproduced here, so this document does not trip its own guard.

   Thresholds are set above the short placeholder keys the test suite uses, so
   the test files do not trip it.
