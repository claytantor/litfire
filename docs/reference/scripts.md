# Scripts

| Command              | What it does                                   |
| -------------------- | ---------------------------------------------- |
| `pnpm dev`           | Run the TUI from source via `tsx`              |
| `pnpm build`         | Bundle to `dist/cli.js`                        |
| `pnpm typecheck`     | `tsc --noEmit` (TypeScript 7, native compiler) |
| `pnpm lint`          | `oxlint`                                       |
| `pnpm test`          | Vitest + `ink-testing-library`                 |
| `pnpm check`         | typecheck + lint + format check + test         |
| `pnpm vault:new`     | Create an ignored local story vault            |
| `pnpm check:secrets` | Scan tracked files for credentials             |
| `pnpm hooks:install` | Install the pre-commit secret guard            |

`typescript-eslint` still peers at `typescript <6.1.0` and cannot see TypeScript 7,
which is why linting is oxlint. The trade-off is no type-aware lint rules.
