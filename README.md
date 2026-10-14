# Phở Research Tools

**An open-source MCP server that lets any AI assistant check its own references.**
It verifies citations, flags retractions, formats bibliographies and draws PRISMA 2020
diagrams, using only open scholarly databases: Crossref, PubMed and OpenAlex.

AI models invent references. This server gives Claude, ChatGPT, Cursor or any MCP client
a way to look each one up in a public database before you trust it.

| Tool | What it does |
| --- | --- |
| `verify_references` | Checks each reference: verified, real but with wrong details (with the corrected record), likely fabricated, not found, retracted, or ambiguous. |
| `check_retractions` | Retraction, expression-of-concern and correction notices for a list of DOIs. |
| `search_papers` | Searches OpenAlex and PubMed. Every result has a DOI or PMID; retracted papers are left out and preprints are labelled. |
| `format_citations` | APA 7, MLA 9, Chicago, Harvard, Vancouver, IEEE or AMA, or BibTeX, RIS and CSL-JSON, formatted from the real record. |
| `prisma_flow_diagram` | A PRISMA 2020 flow diagram (PNG + SVG) with a check that the counts add up. |

All five tools are read-only. Results are database lookups, not model opinions:
`likely_fabricated` means the DOI is not registered or no matching record exists.

## Use the hosted server (no install)

Add this URL as a custom connector / MCP server in your client:

```
https://mcp.pho.chat/mcp
```

- **Claude Code:** `claude mcp add --transport http pho-research https://mcp.pho.chat/mcp`
- **Claude (web, desktop):** Settings → Connectors → Add custom connector.
- **ChatGPT:** Settings → Apps & Connectors → Developer mode → Create.
- **Cursor, VS Code, others:** see [`apps/mcp/README.md`](apps/mcp/README.md).

No account is needed. Anonymous use has a daily allowance; a free account at
[pho.chat](https://pho.chat) raises it. Prefer a web page? The same tools run at
[pho.chat/tools](https://pho.chat/tools/).

## Verified Citations skill

This repository also ships **Verified Citations**, an Agent Skill that makes an assistant
use the tools above on every reference it writes: find sources with `search_papers`
instead of recalling them, run `verify_references` before showing anything, format with
`format_citations`, and say which references were corrected, retracted or removed.

### Claude Code (plugin: skill + MCP server in one step)

```bash
claude plugin marketplace add thaohienhomes/pho-research-tools
claude plugin install verified-citations@pho-research-tools
```

The plugin adds the skill and connects the `pho-research` MCP server. Run `/mcp` to check
the server shows as connected. From a local checkout, pass the folder path to
`marketplace add` instead.

### Cursor (Agent Plugin: skill + MCP server in one step)

The repository root is an [Agent Plugin](https://agent-plugins.org): `plugin.json` names
the plugin, `skills/` holds the skill, and `mcp.json` connects the `pho-research` server at
`https://mcp.pho.chat/mcp`. Cursor loads it as-is:

- **Teams and Enterprise:** Dashboard → Plugins & MCPs → Add Marketplace → Import from
  Repo, and paste `https://github.com/thaohienhomes/pho-research-tools`.
- **Local:** clone or copy this repository to `~/.cursor/plugins/local/verified-citations`,
  run **Developer: Reload Window**, and check under **Customize** that the plugin and the
  `pho-research` MCP server are listed.

The plugin logo is [`assets/logo.svg`](assets/logo.svg). Support: support@pho.chat.

### skills.sh (Claude Code, Cursor, Codex, Gemini CLI and other agents)

```bash
npx skills add thaohienhomes/pho-research-tools --skill verified-citations
```

This installs the skill only. Connect the MCP server in your agent too, for example in
Claude Code:

```bash
claude mcp add --transport http pho-research https://mcp.pho.chat/mcp
```

### ClawHub (OpenClaw)

```bash
clawhub install verified-citations
```

Then add `https://mcp.pho.chat/mcp` as a remote MCP server in OpenClaw.

### Claude.ai, ChatGPT and others

Add `https://mcp.pho.chat/mcp` as a custom connector; step-by-step instructions for each
app are at https://pho.chat/tools/mcp/. Without the connector, paste a reference list into
the free checker at https://pho.chat/tools/citation-checker/.

## Run it yourself

Requires Node 22+ and pnpm 9.

```bash
pnpm install
pnpm dev            # http://localhost:8787/mcp
```

Every setting is optional for a local run; see [`apps/mcp/.env.example`](apps/mcp/.env.example).
A Dockerfile is in `apps/mcp/` (`docker build -f apps/mcp/Dockerfile -t pho-mcp .`).

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/mcp` | The MCP server (Streamable HTTP, Hono). Quotas, optional sign-in, analytics, all off unless configured. |
| `packages/scholar-core` | Verification, retraction checks, search, citation formatting and PRISMA rendering. Pure TypeScript, no AI SDK, no database. |
| `packages/citation-engine` | DOI, BibTeX and RIS parsing and Crossref helpers. |
| `docs/samples/scholar-core` | Sample outputs, regenerated and checked by the test suite. |
| `skills/verified-citations` | The Verified Citations Agent Skill. |
| `.claude-plugin/`, `.mcp.json` | Claude Code plugin + one-plugin marketplace (skill and MCP server in one install). |
| `plugin.json`, `mcp.json` | Agent Plugin manifest for Cursor and other Agent Plugins clients (skills found in `skills/`). |
| `assets/logo.svg` | Plugin logo, a vector version of `apps/mcp/public/icon.png`. |
| `server.json`, `glama.json` | MCP Registry entry (published by `.github/workflows/publish-mcp-registry.yml`) and Glama maintainer claim. |

```bash
pnpm test        # 190 tests, all replaying recorded API responses
pnpm typecheck
```

## Open data only

Every source this server calls has an open API and open metadata. Nothing paywalled is
fetched or stored. Embedded CSL styles are CC BY-SA 3.0; details in [`NOTICE.md`](NOTICE.md).

## Privacy

What the hosted server receives and keeps: https://pho.chat/tools/privacy/

## Contributing and license

Issues and pull requests are welcome; read [`CONTRIBUTING.md`](CONTRIBUTING.md) first.
Security reports: [`SECURITY.md`](SECURITY.md).

Code is [MIT](LICENSE). Built by [Phở](https://pho.chat), a research workspace for
doctors and scientists.

---

*Tiếng Việt: Phở Research Tools là máy chủ MCP mã nguồn mở giúp trợ lý AI tự kiểm tra
tài liệu tham khảo (xác minh trích dẫn, kiểm tra rút bài, định dạng, vẽ sơ đồ PRISMA
2020), chỉ dùng dữ liệu khoa học mở.*
