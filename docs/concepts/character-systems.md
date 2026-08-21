# Character systems

A _character system_ is the thing that tracks and manages a character's stats. A
vault may hold several — a Seed that grants power and a Custodian that audits it
are two systems, not one with two moods — and **a character is under exactly one
at a time**.

That single constraint is what keeps `level`, `xp`, and `stats` flat scalars
rather than maps keyed by system: there is only ever one answer to "what is their
vitality". Moving between systems is a `port` event, never a silent frontmatter
edit, so the moment it happens sits in the ledger where the story can see it.

```
systems/
  seed.md          id, name, stats, skills, curves + formulas in the body
  custodian.md
characters/
  inanna.md        system: seed
```

A port re-seeds any stat the new system declares and the character lacks, keeps
the ones it does not declare rather than discarding them, and re-derives the
level from the XP already earned under the new curve — the same experience is
worth a different standing under different rules. All of it is reported as a
`system_port` finding.

Formulas defined in a system page's body are scoped to that system; the shared
`setting/formulas.md` stays global and is the fallback. This matters immediately,
because every system's curve defaults to the id `xp-for-level` — without scoping,
two systems would silently level their characters by one curve.

Naming a system on a character is optional when the vault has one. With several
it is required, and leaving it out raises `character_system_unset` rather than a
guess: choosing a system for someone decides what every number on their sheet
means.

**Vaults written before this need no migration.** The original `corpus/systems/<id>.md`,
`corpus/systems/<id>.md`, and `corpus/systems/<id>.md` load as one system with the id
`system`, and a character that names none is placed in it.

## The two Kimi products are not interchangeable

`api.moonshot.ai` (pay-per-token platform) and `api.kimi.ai/coding/v1` (a
subscription from kimi.ai) are separate services. A key for one is rejected by
the other with `401 invalid_authentication_error`, and the same model carries a
different id on each:

|             | Kimi (Moonshot)      | Kimi Code (kimi.ai)     |
| ----------- | -------------------- | ----------------------- |
| Host        | `api.moonshot.ai/v1` | `api.kimi.ai/coding/v1` |
| Key prefix  | `sk-…`               | `sk-kimi-…`             |
| K3 model id | `kimi-k3`            | `k3`                    |
| Billing     | per token            | subscription            |

**kimi.ai is the host to use.** `api.kimi.com` answers identically — it is the
same service behind a different front door — but kimi.com is the mainland-China
site, so litfire defaults to `api.kimi.ai` and nothing points you at the other
one. If you do need it, `LITFIRE_KIMI_CODE_BASE_URL` overrides the host.

`kimi-k3` is also accepted on a subscription as an alias for `k3`, but it is
absent from that host's `/models` response, so `/provider` will not offer it.
Pick `k3`.

Subscription models are **thinking-only**: reasoning tokens come out of the same
budget as the answer, so a small `max_tokens` returns an empty `content` with
`finish_reason: "length"`. Each provider therefore carries its own
`maxOutputTokens` in the catalog, and Kimi Code's is the largest — extracting a
30-exchange interview spent 50k characters on reasoning before writing 18k of
answer. A reply that is cut off raises a named error rather than being parsed:
truncation is not a shorter answer, it is a broken one, and it used to surface
as an "unterminated JSON object" that blamed the parser.
A subscription exposes `k3` (1M context), `k3-256k`, `kimi-for-coding`, and
`kimi-for-coding-highspeed`.

Anthropic is **not** routed through the OpenAI-compatible adapter. Its endpoint
(`/v1/messages`), auth header (`x-api-key`, not a bearer token), required
`anthropic-version` header, and request shape all differ, and Anthropic's own
guidance is to use the SDK rather than a compatibility shim. The other three
share one adapter; only the base URL differs.

**Connection tests cost nothing.** Verification lists models — an authenticated
`GET` — so it proves the key, the network path, and the base URL without
spending a token. The same call supplies the model picker.

## Where keys live

**API keys are never written into the vault.** They go to
`$XDG_CONFIG_HOME/litfire/credentials.json` (default `~/.config/litfire/`) at
mode `0600`; the vault's `.litrpg/config.json` records only the selected
provider and model.

This is deliberate. P1 makes the filesystem the API, but that governs corpus
content, not secrets — and P2 makes the vault an Obsidian folder people sync and
share, while section 6.4 already anticipates shared corpora. A key in `.litrpg/`
would ride along with any of that.

An environment variable always wins over a stored key, and a key supplied by the
environment is never written to disk.

## Custom and local endpoints

Section 9 calls for "any local OpenAI-compatible endpoint". Every provider's host
is overridable via `LITFIRE_<PROVIDER>_BASE_URL`:

```bash
LITFIRE_OPENAI_BASE_URL=http://localhost:11434/v1 litfire   # a local server
LITFIRE_KIMI_BASE_URL=https://api.moonshot.cn/v1 litfire    # Kimi's .cn host
```
