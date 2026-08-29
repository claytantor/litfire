# Exec — running litfire headlessly

litfire is a TUI. `litfire exec` is the other door: a non-interactive surface an
agent or a script can drive, on the same vault, through the same commands.

**It cannot apply a proposal.** That is the point of it, and everything below
follows from it. The review gate is what makes this tool trustworthy — nothing
is written because it seemed right — and an exec mode that could accept a diff
on your behalf would take that away in exchange for convenience.

## Three tiers

### Tier 1 — read, and nothing else

```
litfire exec <vault> /questions --json
litfire exec <vault> /lint --json
litfire exec <vault> /status inanna --json
```

`/questions` `/lint` `/status` `/sheet` `/timeline` `/primitives` `/themes`
`/pacing` `/project` `/time` `/help`.

These compute and return. They need no model provider — a view costs nothing
and needs no provider (D24) — and they are where nearly all of an agent's value
is: the useful thing an agent does in a vault is **notice**.

### Tier 2 — propose, and stop

```
litfire exec <vault> /ingest character --propose --out /tmp/batch.json
```

Runs the model pass and builds exactly the batch the gate would, then writes it
out and exits. **Nothing is applied.** The agent's job ends here: it reports
what litfire proposes and what each item needs decided.

`--out` is required and there is no default. A batch is ephemeral state between
two processes, not vault content, so it belongs outside a directory you commit.

### Tier 3 — applying, as a separate act

```
litfire review apply /tmp/batch.json --accept 1,3,4
litfire review apply /tmp/batch.json --accept-all 3
```

A distinct invocation taking an explicit list. **No flag anywhere combines tier
2 and tier 3.** There is no `--auto-apply`, and `--yes` does not exist on
`/ingest`. A propose-and-apply pair on one command line is not a decision
somebody made; it is one keystroke from being one.

**`--accept-all` takes the count**, and refuses if it is wrong:

```
$ litfire review apply /tmp/batch.json --accept-all 2
--accept-all 2 does not match this batch, which has 3 item(s)
  re-read the batch and pass --accept-all 3 if that is really what you mean
```

A bare `--accept-all` was the one flag an agent could be talked into passing
without knowing what it covered. The count makes it an assertion about the file
in hand rather than a shrug: applying everything is a reasonable thing to want;
applying _however many things happen to be in this file_ is not, and the two are
indistinguishable until the file is not the one you thought. A regenerated
batch, the wrong path, a second propose run — each shows up as a number that
does not match, and nothing is written.

`--accept-all` with no number is refused too, since that is precisely the
mistake the count exists to catch.

### The derived-write tier

```
litfire exec <vault> /wiki build --allow-derived-write
```

`/wiki build` regenerates `wiki/` and `ledger/`. Those are pure functions of the
corpus and regenerable by definition — the gate does not govern them and in fact
forbids proposals there for the same reason — so it is safe headlessly, and an
agent reading the wiki needs it fresh.

It is its own tier because tier 1's guarantee is one sentence, _it writes
nothing_, and a guarantee needing a footnote is worth less than the command it
would admit. The flag makes the write something you asked for by name.

## The envelope

`--json` emits a versioned envelope. Parse this, not `lines`.

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "questions",
  "vault": "/abs/path",
  "litfireVersion": "0.1.0",
  "data": { "questions": [ … ] },
  "lines": [ { "text": "open questions (11)", "bold": true } ],
  "dirty": false
}
```

| Field           | Is                                                                 |
| --------------- | ------------------------------------------------------------------ |
| `schemaVersion` | This contract's version. Bumped when a field's meaning changes     |
| `ok`            | False whenever `error` is present                                  |
| `data`          | The typed payload, or `null` for a command with no structured form |
| `lines`         | The human rendering, kept so nothing the TUI would show is lost    |
| `dirty`         | Whether the vault changed. Always `false` in tier 1                |
| `error`         | `{code, reason, remedy?}`, present only when `ok` is false         |

`data` is **never null for `questions` or `lint`** — those are the two an agent
will really parse, and a null there would push it straight back to scraping
text.

```jsonc
// /questions
{"questions": [{"id", "kind", "detail", "where", "actor?", "source", "status"}]}

// /lint
{"findings": [...], "byKind": {"kind": count},
 "parseFailures": [...], "orphanedInterviews": [...], "legacyLocations": [...]}
```

## Exit codes

An agent branches on these, so they are distinct rather than one failure code.

|     |                                                                    |
| --- | ------------------------------------------------------------------ |
| `0` | success                                                            |
| `1` | command error — including a batch where some items failed to write |
| `2` | usage error                                                        |
| `3` | refused in exec mode                                               |
| `4` | stale batch — the vault moved under it                             |
| `5` | consent required                                                   |
| `6` | no provider configured                                             |

## What exec refuses, and why

Eleven `CommandResult` branches hand control back to a human. Each has an
answer, not a shared apology:

| Branch          | In exec                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `confirm`       | Fails closed. `--yes` answers it — and what it was guarding is then checked again |
| `ingest`        | Tier 2: `--propose --out <file>`                                                  |
| `generateStats` | Refused; it opens the gate                                                        |
| `adopt`         | Refused; it proposes into `raw/`                                                  |
| `curator`       | Refused; it may propose into `raw/`                                               |
| `reviewer`      | Refused; author-driven by definition                                              |
| `interview`     | Refused; a dialogue has no headless form                                          |
| `wizard`        | Refused; exec never touches a credential                                          |
| `openEditor`    | Refused; there is no buffer                                                       |
| `switchProject` | Refused; exec takes its vault as an argument                                      |
| `exit`          | Refused; nothing to exit                                                          |

Refusal is decided from the **returned result**, not a list of command names,
because the same command is a different tier at different arguments:
`/questions` is a report and `/questions character` is an interview. The check
recurses into `confirm.proceed`, so answering a question is never permission for
what it was guarding.

## Guarantees

- **`raw/` is untouchable.** `FORBIDDEN_PREFIXES` applies identically, and
  `PathOptions.allowRaw` is not settable from exec by any flag, config key or
  environment variable. `/curator` and `/ingest adopt` are the only paths that
  may set it and both stay interactive.
- **Proposal paths stay untrusted.** `resolveInsideVault` guards every one.
- **Consent is not bypassable.** Exec never calls `consentFormulas`. It fails
  closed with exit 5, because an unconsented vault reports derived stats as
  zero — Ω reads `0` instead of `1.4444`, a ceiling reads `0` instead of `20`,
  and the finding count does not even change. An agent cannot tell; this can.
- **No credential is ever prompted for.** `/provider` stays a wizard.
- **Every invocation is logged.** `log.md` records that a run came from exec.
  This is the one thing tier 1 writes, deliberately: if an agent touches a
  vault, that belongs in the vault's own record.

::: warning A new vault is unconsented
`/init` ships formulas and writes `consentedFormulaHash: null`, so a freshly
scaffolded vault fails exec with exit 5 until you run `/consent` once in the
TUI. That is the gate working, but it is a surprise the first time.
:::

## Staleness

A batch records a hash of each target as it was when proposed, and `review
apply` refuses anything that moved since. **Absent and empty hash differently**:
a proposal for a file that did not exist, applied after something else created
it, would otherwise overwrite work nobody reviewed.

Per item, not per batch — a batch whose third target moved is still applicable
for the other two.

## A worked example

```bash
#!/usr/bin/env bash
set -euo pipefail
VAULT=~/novels/inanna-2

# 1. Notice. This is most of the job.
litfire exec "$VAULT" /questions --json > questions.json
litfire exec "$VAULT" /lint --json      > lint.json

jq -r '.data.questions[] | "\(.kind): \(.detail)"' questions.json

# 2. Propose, if there are notes to read. Nothing lands.
litfire exec "$VAULT" /ingest character --propose --out /tmp/batch.json
jq -r '.data.items[] | "\(.index) \(.path)  +\(.stat.added) -\(.stat.removed)"' \
  /tmp/batch.json

# The count, if you are going to quote it back:
jq '.items | length' /tmp/batch.json

# 3. Report to the human. Stop here.
#    Applying is theirs:
#      litfire review apply /tmp/batch.json --accept 1,3
#      litfire review apply /tmp/batch.json --accept-all 3
```

Exit codes an agent should handle by name rather than by message:

```bash
litfire exec "$VAULT" /questions --json > out.json || case $? in
  3) echo "not available headlessly — needs the TUI" ;;
  5) echo "run /consent in litfire first" ;;
  6) echo "no model provider configured" ;;
  *) echo "failed" ;;
esac
```
