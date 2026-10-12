# Contributing

Thanks for helping make AI-written references checkable.

## Setup

Requires Node 22+ and pnpm 9.

```bash
pnpm install
pnpm test        # every suite replays recorded API responses, no network needed
pnpm typecheck
pnpm dev         # MCP server on http://localhost:8787/mcp
```

## Ground rules

- **Only open data.** New sources must have an open API and an open licence for the
  metadata they return. No scraping, no paywalled content.
- **Never invent a record.** A tool either returns something a public database
  confirmed, or says it could not confirm it.
- **Tests replay cassettes.** If you add a network call, record its response with
  `pnpm --filter @pho/scholar-core record` and commit the cassette.
- Keep pull requests focused, with a short description of what changes for a user.

For bigger ideas, open an issue or a discussion first.
