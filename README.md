# Verified Citations

An Agent Skill that stops an AI assistant from showing made-up references. Whenever it
writes or reviews anything with citations, the assistant:

1. finds sources with `search_papers` instead of recalling them,
2. runs `verify_references` on every reference before showing it (Crossref, PubMed, OpenAlex),
3. formats the bibliography with `format_citations` from the database record,
4. tells you which references were corrected, retracted or removed as fabricated.

The tools come from the free **Phở Research Tools** MCP server at
`https://mcp.pho.chat/mcp`. No account is needed; signing in raises the allowance.
The skill itself costs nothing to run.

## Install

### Claude Code (plugin: skill + MCP server in one step)

```bash
claude plugin marketplace add thaohienhomes/pho-research-tools
claude plugin install verified-citations@pho-research-tools
```

The plugin adds the skill and connects the `pho-research` MCP server. Run `/mcp` to check
the server shows as connected. From a local checkout, pass the folder path to
`marketplace add` instead.

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

## Layout

```
.claude-plugin/plugin.json        plugin manifest
.claude-plugin/marketplace.json   one-plugin marketplace (source "./")
.mcp.json                         the remote MCP server
skills/verified-citations/SKILL.md
```

Check it with `claude plugin validate --strict .` from this folder.

## License

MIT
