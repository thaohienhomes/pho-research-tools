# Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "pho-research": {
      "url": "https://mcp.pho.chat/mcp",
      "headers": { "X-Pho-Api-Key": "${env:PHO_API_KEY}" }
    }
  }
}
```

Start Cursor from a shell where `PHO_API_KEY` is set (or put the key in the
file, and keep that file out of git). Check **Settings → MCP**: `pho-research`
should be green and list `run_research`.

Then in Agent mode:

> Run a Phở research run on "GLP-1 receptor agonists and suicidality", keep
> checking it until it completes, and add the report to `research/glp1.md`.
