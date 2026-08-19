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
