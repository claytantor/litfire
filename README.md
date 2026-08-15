# litfire

A terminal chat interface built with [Ink](https://github.com/vadimdemedes/ink).

Streaming transcript, keyboard-driven composer, and a pluggable engine seam so the
backend can be swapped without touching the UI.

## Requirements

- Node.js >= 22 (Ink 7 requires it)
- pnpm

## Getting started

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the TypeScript entry directly through `tsx` — no build step in the
loop. It boots with a stub "echo" engine so the app is live on first run.

## Scripts

| Command          | What it does                                   |
| ---------------- | ---------------------------------------------- |
| `pnpm dev`       | Run the TUI from source via `tsx`              |
| `pnpm build`     | Bundle to `dist/cli.js` with `tsup`            |
| `pnpm start`     | Run the built binary                           |
| `pnpm typecheck` | `tsc --noEmit` (TypeScript 7, native compiler) |
| `pnpm lint`      | `oxlint`                                       |
| `pnpm format`    | Prettier write                                 |
| `pnpm test`      | Vitest + `ink-testing-library`                 |
| `pnpm check`     | typecheck + lint + format check + test         |

## Keys and commands

| Key / command | Action                                   |
| ------------- | ---------------------------------------- |
| `enter`       | Send                                     |
| `esc`         | Cancel a streaming reply, or clear draft |
| `ctrl+c`      | Quit                                     |
| `/help`       | Show commands                            |
| `/clear`      | Clear the conversation                   |
| `/quit`       | Exit                                     |

## Layout

```
source/
  cli.tsx              entry — arg parsing (meow) and render()
  app.tsx              root — wires state to layout, owns slash commands
  theme.ts             all colors and glyphs
  types.ts             Message / Role, zod schemas
  engine/
    types.ts           the Engine seam
    echo.ts            stub engine, streams a reply word by word
  hooks/
    use-chat.ts        conversation state machine, streaming, cancellation
  components/
    transcript.tsx     <Static> region — finished turns
    message-view.tsx   one message row
    composer.tsx       input box
    status-bar.tsx     hints, spinner, errors
    header.tsx         banner
test/
```

## Swapping the engine

The UI depends on exactly one interface:

```ts
export type Engine = {
  readonly name: string;
  send(messages: readonly Message[], signal: AbortSignal): AsyncIterable<string>;
};
```

Implement it, pass it to `<App engine={...} />` in `source/cli.tsx`, and nothing in
`components/` or `hooks/` changes. Implementations must honour `signal` so `esc`
can cancel an in-flight turn.

## Notes on the setup

- **TypeScript 7** (the native compiler). `typescript-eslint` still peers at
  `<6.1.0`, so linting is **oxlint** instead — fast, and it understands TSX
  natively. The trade-off is no type-aware lint rules until typescript-eslint
  ships TS 7 support.
- **`<Static>` owns the transcript.** Ink prints it once, above the live region,
  and never redraws it, so a long conversation stays cheap and the terminal's own
  scrollback does the scrolling. The banner travels through the same list because
  Ink supports a single `<Static>` region.
- **Incremental rendering is on** (`incrementalRendering: true`, `maxFps: 60`).
  A streaming transcript repaints constantly; rewriting only changed lines is what
  keeps the composer from flickering on every token.
- **Paste and piped input.** Ink delivers a multi-character paste as one
  `useInput` event, so `key.return` never fires and `ink-text-input` splices the
  newline straight into the value. `Composer` treats the first newline in an
  incoming chunk as the submit boundary. A multi-line paste sends its first line
  and queues the rest — the honest behaviour for a single-line composer, and the
  thing to revisit if a multi-line editor lands.
