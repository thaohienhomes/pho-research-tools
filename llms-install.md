# Installing Phở Research Tools (for AI agents)

**Do not clone or build this repository.** Phở Research Tools is a hosted remote MCP server.
Setting it up means adding one URL to the MCP client's configuration. No install, no API key,
no Node or pnpm needed.

- URL: `https://mcp.pho.chat/mcp`
- Transport: Streamable HTTP
- Authentication: none

## Cline

Add this entry to `cline_mcp_settings.json` (keep any existing servers):

```json
{
  "mcpServers": {
    "pho-research": {
      "type": "streamableHttp",
      "url": "https://mcp.pho.chat/mcp"
    }
  }
}
```

## Other clients

- Claude Code: `claude mcp add --transport http pho-research https://mcp.pho.chat/mcp`
- Any other client: add `https://mcp.pho.chat/mcp` as a remote (Streamable HTTP) MCP server.

## Check it worked

The server should connect and list 5 read-only tools: `verify_references`,
`check_retractions`, `search_papers`, `format_citations`, `prisma_flow_diagram`.
A quick test: ask for `check_retractions` on DOI `10.1056/NEJMoa1200303` (PREDIMED, NEJM 2013);
it should report a retraction.

## Limits

Free. Without an account: 30 reference checks and 200 tool calls a day. A free account at
https://pho.chat raises this; sign in by using `https://mcp.pho.chat/mcp/login` instead (OAuth).

Running the server yourself from source is optional and only for development; see README.md.
