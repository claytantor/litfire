#!/usr/bin/env bash
# Point git at the repo's tracked hooks directory.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
git config core.hooksPath .githooks
printf 'hooks installed (core.hooksPath = .githooks):\n'
for hook in "$repo_root"/.githooks/*; do
  [[ -f "$hook" ]] || continue
  # An unexecutable hook is silently skipped by git, which is the worst way for
  # a guard to fail: it looks installed and does nothing.
  chmod +x "$hook"
  printf '  %s\n' "$(basename "$hook")"
done
printf 'Credentials and vault contents will now be blocked before they commit.\n'
printf 'Uninstall with: git config --unset core.hooksPath\n'
