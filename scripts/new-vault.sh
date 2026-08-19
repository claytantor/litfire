#!/usr/bin/env bash
# Create a local story vault that git will never track.
#
# The safety property is not "we put it in a folder we believe is ignored" —
# it's that we ask git directly, and refuse to continue if git disagrees.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

name="${1:-}"
if [[ -z "$name" ]]; then
  printf 'usage: pnpm vault:new <name>\n\n' >&2
  printf 'Creates vaults/<name>, verifies git ignores it, and opens litfire there.\n' >&2
  exit 64
fi

# Keep it a single path segment: no traversal, no absolute paths, nothing that
# could land the vault outside the ignored directory.
if [[ "$name" == /* || "$name" == *..* || "$name" == */* ]]; then
  printf 'error: vault name must be a single path segment (got %q)\n' "$name" >&2
  exit 64
fi

target="vaults/$name"

if [[ -e "$target" ]]; then
  printf 'error: %s already exists\n' "$target" >&2
  exit 1
fi

mkdir -p "$target"

# Ask git whether it would ignore a file inside the new vault. `check-ignore`
# exits 0 only when the path is genuinely ignored, so a broken or edited
# .gitignore fails loudly here instead of silently at commit time.
probe="$target/.litrpg/config.json"
if ! git check-ignore -q "$probe" 2>/dev/null; then
  printf 'error: git does NOT ignore %s\n' "$probe" >&2
  printf 'Refusing to create a vault that could be committed.\n' >&2
  printf 'Check the "Story vaults" section of .gitignore.\n' >&2
  rmdir "$target" 2>/dev/null || true
  exit 1
fi

printf 'Created %s\n' "$target"
printf 'git confirms it is ignored (probe: %s)\n\n' "$probe"

if [[ "${LITFIRE_NO_LAUNCH:-}" == "1" ]]; then
  printf 'Run: pnpm dev %s   then /init\n' "$target"
  exit 0
fi

printf 'Opening litfire — run /init to scaffold the vault.\n\n'
exec pnpm dev "$target"
