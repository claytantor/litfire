# Model providers

`/provider` walks you through selecting a provider, entering a key, verifying the
connection, and picking a model from the list that provider returns.

Keys resolve in this order, and `/provider status` always names the winner:

1. the env var itself, e.g. `KIMI_CODE_API_KEY`
2. the file it names, e.g. `KIMI_CODE_API_KEY_FILE=~/.local/secrets/kimi-api-key`
3. the key stored by `/provider`, in `~/.config/litfire/credentials.json` (0600)

Every provider's env var has a `…_FILE` companion. The secret then never enters
the environment, never reaches shell history, and never shows up in `ps` — and
rotating the file is enough, because it is read fresh on every resolve. A leading
`~` is expanded, since a value set in a config file never passes through a shell.
A path that cannot be read is reported rather than silently treated as no key,
and a key file readable by other users earns a `chmod 600` nudge.

| Provider            | API                         | Env var             |
| ------------------- | --------------------------- | ------------------- |
| Anthropic Claude    | Messages API (official SDK) | `ANTHROPIC_API_KEY` |
| OpenAI              | OpenAI chat completions     | `OPENAI_API_KEY`    |
| Together AI         | OpenAI-compatible           | `TOGETHER_API_KEY`  |
| Kimi (Moonshot)     | OpenAI-compatible           | `MOONSHOT_API_KEY`  |
| Kimi Code (kimi.ai) | OpenAI-compatible           | `KIMI_CODE_API_KEY` |
| Local               | OpenAI-compatible           | — none needed       |

## Running against your own machine

The **Local** entry covers Ollama, llama.cpp's `llama-server`, LM Studio and
vLLM. One entry rather than four: they differ in the port and in nothing else
that matters here — same wire protocol, same model list, same absence of a key.

```
/provider local http://localhost:11434/v1
```

With no model it lists what the endpoint has, so you can see what you pulled:

```
http://localhost:11434/v1 — 3 model(s) available
  qwen3:8b
  llama3.3:70b
  gpt-oss:20b

/provider local http://localhost:11434/v1 <model> selects one
```

Name one and it is verified and saved:

```
/provider local http://localhost:11434/v1 qwen3:8b
provider set to local · qwen3:8b
at http://localhost:11434/v1 — no key stored
```

A model the endpoint does not list is **reported, not refused** — a server can be
mid-pull, and some list nothing at all.

The `/provider` wizard also has it, and asks for the base URL where every other
provider asks for a key.

| Server                     | Usual base URL              |
| -------------------------- | --------------------------- |
| Ollama                     | `http://localhost:11434/v1` |
| llama.cpp — `llama-server` | `http://localhost:8080/v1`  |
| LM Studio                  | `http://localhost:1234/v1`  |
| vLLM                       | `http://localhost:8000/v1`  |

### There is no key, and litfire does not pretend there is

The wizard skips the key step for this provider. A masked field holding a
placeholder, on a server with no authentication, teaches the wrong thing about
what a key is for.

litfire still sends `Authorization: Bearer litfire-local`, because
`llama-server` rejects an **empty** header with a 401 — which reads like a
credential problem on a machine that has no credentials. That placeholder is
never written to `~/.config/litfire/credentials.json`: putting a fake credential
in the real credential file is how the next reader comes to trust it.

If your endpoint _is_ behind something that wants a real token — a reverse proxy
in front of a GPU box — set `LITFIRE_LOCAL_API_KEY` (or its `…_FILE` companion)
and it wins, exactly as for any other provider.

### Configuring it without the TUI

Everything the local provider needs lives in the vault's own config, so an agent
or a setup script can write it directly. **No credential is involved**, which is
what makes this safe to automate:

```json
// .litrpg/config.json
{
  "provider": {
    "id": "local",
    "model": "qwen3.8-27b",
    "baseUrl": "http://gx10-44bc.local:8080/v1"
  }
}
```

That is the whole onboarding. Nothing else has to be set, and nothing is written
outside the vault.

`LITFIRE_LOCAL_BASE_URL` works too, and wins over the stored value — useful when
one vault is opened from two machines that reach the same box by different names.

::: tip A remote box is still "local"
The name is about who owns the endpoint, not where it is. Pointing this at
`http://gx10-44bc.local:8080/v1` on your LAN is the ordinary case, and the base
URL is the whole of the difference.
:::
