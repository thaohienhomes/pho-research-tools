# OpenAI Codex CLI

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.pho-research]
url = "https://mcp.pho.chat/mcp"
# Codex reads the key from this environment variable and sends it as
# "Authorization: Bearer <key>", which the Phở server accepts.
bearer_token_env_var = "PHO_API_KEY"
```

```bash
export PHO_API_KEY=pho_sk_...   # https://pho.chat/settings → API keys
codex
```

Then ask:

> With pho-research, run_research "metformin and colorectal cancer incidence",
> wait for get_research_run to finish, and write the report to
> `docs/metformin-crc.md`.

If your Codex version does not support `bearer_token_env_var`, use
`env_http_headers = { "X-Pho-Api-Key" = "PHO_API_KEY" }` instead.
