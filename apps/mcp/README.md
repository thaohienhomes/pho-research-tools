# Phở Research Tools — MCP server

A remote MCP server (Streamable HTTP) that lets any AI assistant check its own
references. It wraps `@pho/scholar-core` and exposes five read-only tools:

| Tool | What it does |
| --- | --- |
| `verify_references` | Checks each reference against Crossref, PubMed and OpenAlex: verified, real but with wrong details (with the corrected record), likely fabricated, not found, retracted, or ambiguous. |
| `format_citations` | Formats references in APA 7, MLA 9, Chicago, Harvard, Vancouver, IEEE or AMA, or exports BibTeX, RIS or CSL-JSON. Verified references are formatted from the real record. |
| `search_papers` | Searches OpenAlex and PubMed. Every result has a DOI or PMID; retracted papers are left out and preprints are labelled. |
| `check_retractions` | Retraction, expression-of-concern and correction notices for a list of DOIs. |
| `prisma_flow_diagram` | Draws a PRISMA 2020 flow diagram (PNG + SVG + links) and checks that the counts add up. |

No account is needed. Anonymous use has a daily allowance per caller: 30
reference checks and 200 tool calls by default. Signing in with a free Phở
account raises that to 300 reference checks and 3,000 tool calls a month, the
same allowance from any network.

There are two addresses for the same tools:

| Address | Sign-in |
| --- | --- |
| `https://<host>/mcp` | None. Anonymous allowance. |
| `https://<host>/mcp/login` | Required. The client opens a Phở (Clerk) sign-in page once, then uses the account allowance. |

Below, `<URL>` means one of these, for example `https://mcp.pho.chat/mcp` (the same server also answers at `https://pho-mcp.vercel.app/mcp`).

## Connect it

### Claude (claude.ai, desktop and mobile)

1. Open **Settings → Connectors** and click **Add custom connector**.
2. Name: `Phở Research Tools`. URL: `<URL>`. Leave the OAuth fields empty, then click **Add**.
3. In a chat, open the **+** menu → **Connectors** and make sure *Phở Research Tools* is on.
4. Try: *"Write three references on nirsevimab for RSV, then verify them with Phở Research Tools."*

To sign in, use `https://<host>/mcp/login` as the URL in step 2, still with the
OAuth fields empty. Claude opens the Phở sign-in page; sign in, approve access,
and the connector shows as connected. To switch an existing anonymous connector,
remove it and add it again with the `/mcp/login` URL.

On Team and Enterprise plans an owner adds the connector under **Organization settings → Connectors** first.

### Claude Code

```bash
claude mcp add --transport http pho-research <URL>
```

Then run `/mcp` in Claude Code to check it shows as connected.

### ChatGPT

Needs a plan with developer mode (Plus, Pro, Business, Enterprise or Edu).

1. **Settings → Apps & Connectors → Advanced settings**, turn on **Developer mode**.
2. Back in **Apps & Connectors**, click **Create**. Name: `Phở Research Tools`, MCP server URL: `<URL>`, Authentication: **No authentication**. Tick the trust box and click **Create**.
3. In a chat, choose **Developer mode** from the **+** menu and enable the connector.

### Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "pho-research": { "url": "<URL>" }
  }
}
```

Then open **Cursor Settings → MCP** and check the server is green.

### Perplexity

Remote connectors are under **Settings → Connectors → Add connector → Custom (remote MCP)** on plans that offer them. Use `<URL>` with no authentication. *Not yet tested by us; menu names may differ.*

### Grok

Through the xAI API, pass the server as a remote MCP tool:

```json
{ "tools": [{ "type": "mcp", "server_url": "<URL>", "server_label": "pho_research" }] }
```

*Not yet tested by us.* The grok.com app does not offer custom connectors at the time of writing.

### OpenClaw

Add the server as a remote (HTTP) MCP server in your OpenClaw MCP configuration, with `url` set to `<URL>` and no authentication. *Not yet tested by us; the configuration key depends on your OpenClaw version.*

### MCP Inspector (for debugging)

```bash
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, enter `<URL>`, click **Connect**, then **Tools → List Tools**.

## Run it locally

```bash
pnpm install
pnpm --filter @pho/mcp start            # http://localhost:8787/mcp, in-memory storage; keeps running
pnpm --filter @pho/mcp smoke            # in a second terminal: calls every tool against it
```

With Docker (build from the repository root):

```bash
docker build -f apps/mcp/Dockerfile -t pho-mcp .
docker run -p 8787:8787 -e QUOTA_SALT="$(openssl rand -hex 32)" pho-mcp
```

Settings are environment variables; see [`.env.example`](./.env.example). Without
`DATABASE_URL` quotas and the response cache live in memory, which is fine for one
process.

## Deploy on Vercel

Create a Vercel project with **Root Directory** `apps/mcp`. `vercel.json` does the
rest: it installs only this app's dependencies, bundles the server into
`dist/handler.mjs` (`pnpm build`), and routes every path to one function.

Set `QUOTA_SALT` (a long random secret; the server refuses to start without it) and `SCHOLAR_CONTACT_EMAIL`. For
quotas shared across instances, set `DATABASE_URL` and create the tables with
`packages/database/drizzle/manual/2026-10-05_research_tools.sql`.

Deployment Protection must be off for the URL you hand to clients: assistants
cannot pass Vercel's login screen.

Sign-in is off until `OAUTH_ISSUER` is set to the Clerk instance (for Phở,
`https://clerk.pho.chat`). The Clerk instance must let MCP clients register
themselves: **Clerk Dashboard → OAuth applications → Settings → Client
onboarding**, turn on Client ID Metadata Documents (CIMD) and/or **Publish DCR
support**. Without it, `/.well-known/oauth-authorization-server` on the Clerk
domain has no `registration_endpoint` and clients cannot start the sign-in. No
Clerk secret is needed on this server: tokens are checked against Clerk's
`/oauth/userinfo` endpoint.

## How it works

- **Stateless.** Each `POST /mcp` builds a server, answers and closes. No sessions, so any instance can serve any request.
- **Quotas.** The caller is a salted SHA-256 of the IP address (for IPv6, its /64 prefix), never the raw IP. The client name is kept for analytics only, so changing the User-Agent does not buy a new allowance; behind a proxy, only the address the proxy appended to X-Forwarded-For counts. `verify_references` and `check_retractions` spend one unit per reference or DOI, and so does `format_citations` unless called with `verify: false`; when the allowance runs out mid-list, the rest come back `not_checked`. Every tool call also spends one unit of the call allowance. If the quota store fails, requests are allowed.
- **Sign-in.** `/mcp/login` answers 401 with `WWW-Authenticate: Bearer resource_metadata=…` until the client sends a token; the metadata (RFC 9728) names Clerk as the authorization server, so the client runs OAuth 2.1 with PKCE against Clerk. A token is accepted on `/mcp` too. A token Clerk rejects gets a 401 so the client signs in again; if Clerk cannot be reached, the call is served as anonymous. Verified tokens are remembered for 5 minutes (by hash). A signed-in caller's quota subject is a salted hash of the Clerk user id, counted per UTC calendar month.
- **Cache.** Upstream responses (200 and 404 only) are cached 30 days; Crossref work records 1 day, because retraction notices can appear any day.
- **Analytics.** One PostHog event per call, `rt_tool_call`, with the tool name, client, `anon` or `user`, latency, result status and counts. Never the references, queries or DOIs.
- **PRISMA images.** Links carry the counts in the URL (compressed), so they render on any instance without storage.

## Tests

```bash
pnpm --filter @pho/mcp test
```

A real MCP client talks to the app over Streamable HTTP; every call to Crossref,
PubMed, OpenAlex and doi.org is answered from the responses recorded in
`packages/scholar-core/test/fixtures/`.
