#!/usr/bin/env bash
# Refuse to let credentials or vault contents enter a commit.
#
# .gitignore only helps for untracked files — it does not stop `git add -f`, and
# it does nothing for a file that is already tracked. This closes both gaps.
#
#   scripts/check-secrets.sh            scan the whole working tree
#   scripts/check-secrets.sh --staged   scan what is staged (used by pre-commit)
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="${1:-}"
if [[ "$mode" == "--staged" ]]; then
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR)
  label="staged"
else
  mapfile -t files < <(git ls-files)
  label="tracked"
fi

if [[ ${#files[@]} -eq 0 ]]; then
  printf 'no %s files to scan\n' "$label"
  exit 0
fi

fail=0
note() {
  printf '  ✖ %s\n     %s\n' "$1" "$2" >&2
  fail=1
}

# ── 1. Paths that must never be committed, whatever they contain ─────────────
for f in "${files[@]}"; do
  case "$f" in
    vaults/.gitkeep | vaults/README.md) continue ;;
    vaults/*) note "$f" "story vault contents belong outside version control" ;;
    */.litrpg/* | .litrpg/*) note "$f" "vault cache/config (.litrpg/)" ;;
    credentials.json | */credentials.json) note "$f" "provider credentials file" ;;
    .env | .env.*) [[ "$f" == ".env.example" ]] || note "$f" "environment file may hold API keys" ;;
    *.pem | *.p12 | *.pfx | id_rsa | id_ed25519) note "$f" "private key material" ;;
    # Local assistant guidance, never part of the published project. .gitignore
    # does not stop `git add -f`, and this is the only thing that does.
    CLAUDE.md | */CLAUDE.md) note "$f" "local assistant instructions (CLAUDE.md)" ;;
    .claude/* | */.claude/*) note "$f" "local assistant configuration (.claude/)" ;;
  esac
done

# ── 2. Key-shaped literals in file content ───────────────────────────────────
# Thresholds are deliberately long enough to clear the short placeholder keys
# the test suite uses on purpose (sk-good-key, sk-bogus-key-123).
patterns=(
  'sk-ant-[A-Za-z0-9_-]{24,}'
  'sk-proj-[A-Za-z0-9_-]{24,}'
  'sk-[A-Za-z0-9]{32,}'
  'AKIA[0-9A-Z]{16}'
  '"(api_?key|secret_?key|access_?token)"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_/+-]{24,}"'
)

for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  # Skip this scanner and the lockfile: one defines the patterns, the other is
  # full of long base64 integrity hashes.
  case "$f" in
    scripts/check-secrets.sh | pnpm-lock.yaml) continue ;;
  esac

  for pattern in "${patterns[@]}"; do
    if hit=$(grep -nEo "$pattern" "$f" 2>/dev/null | head -1); then
      [[ -n "$hit" ]] && note "$f" "looks like a live API key: ${hit%%:*} → ${hit#*:}"
    fi
  done
done

if [[ $fail -ne 0 ]]; then
  printf '\nBlocked: the %s changes above look like secrets or vault contents.\n' "$label" >&2
  printf 'If a hit is a false positive, remove the file from the commit or adjust\n' >&2
  printf 'scripts/check-secrets.sh — do not bypass with --no-verify unless certain.\n' >&2
  exit 1
fi

printf 'clean: %d %s file(s), no credentials or vault contents\n' "${#files[@]}" "$label"
