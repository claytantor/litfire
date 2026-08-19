#!/usr/bin/env bash
# Block AI/assistant attribution from entering git.
#
# The repository's commits are the author's work. No co-author trailer, no
# "generated with" line, no robot emoji — not in a commit message, not in a
# file, not in a trailer.
#
#   scripts/check-attribution.sh                 scan tracked files
#   scripts/check-attribution.sh --staged        scan staged files (pre-commit)
#   scripts/check-attribution.sh --message FILE  scan a commit message (commit-msg)
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Attribution *forms*, deliberately not the bare word "Anthropic" — this project
# integrates the Anthropic API, so `@anthropic-ai/sdk`, `api.anthropic.com`, and
# `ANTHROPIC_API_KEY` are legitimate content that must not trip the guard.
patterns=(
  'Co-[Aa]uthored-[Bb]y:.*([Cc]laude|[Aa]nthropic|[Aa]ssistant|\bAI\b|Copilot|GPT|Cursor)'
  '[Cc]o-[Aa]uthored-[Bb]y:.*noreply@anthropic\.com'
  '[Aa]ssisted-[Bb]y:.*([Cc]laude|[Aa]nthropic|\bAI\b)'
  '[Gg]enerated (with|by) .*([Cc]laude|Copilot|GPT|\bAI\b)'
  '[Cc]reated (with|by) .*[Cc]laude [Cc]ode'
  '🤖'
  '[Cc]laude [Cc]ode'
  'noreply@anthropic\.com'
)

fail=0
hit() {
  printf '  ✖ %s\n     %s\n' "$1" "$2" >&2
  fail=1
}

scan_text() {
  local label="$1" text="$2"
  for pattern in "${patterns[@]}"; do
    local found
    found=$(printf '%s' "$text" | grep -nE "$pattern" | head -1)
    [[ -n "$found" ]] && hit "$label" "line ${found%%:*}: ${found#*:}"
  done
}

mode="${1:-}"

if [[ "$mode" == "--message" ]]; then
  msg_file="${2:-}"
  if [[ -z "$msg_file" || ! -f "$msg_file" ]]; then
    printf 'usage: check-attribution.sh --message <file>\n' >&2
    exit 64
  fi
  # Comment lines are stripped by git and never reach the commit.
  scan_text "commit message" "$(grep -v '^#' "$msg_file")"
  if [[ $fail -ne 0 ]]; then
    printf '\nBlocked: this commit message carries AI attribution.\n' >&2
    printf 'Remove the trailer or line above and commit again.\n' >&2
    exit 1
  fi
  printf 'commit message: no attribution\n'
  exit 0
fi

if [[ "$mode" == "--staged" ]]; then
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR)
  label="staged"
else
  mapfile -t files < <(git ls-files)
  label="tracked"
fi

for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  # This scanner defines the patterns; scanning it would always match.
  [[ "$f" == "scripts/check-attribution.sh" ]] && continue
  # Binary files cannot carry a readable trailer, and reading them through a
  # command substitution drops null bytes noisily.
  grep -qI . "$f" 2>/dev/null || continue
  scan_text "$f" "$(cat "$f")"
done

if [[ $fail -ne 0 ]]; then
  printf '\nBlocked: the %s files above carry AI attribution.\n' "$label" >&2
  exit 1
fi

printf 'clean: %d %s file(s), no attribution\n' "${#files[@]}" "$label"
