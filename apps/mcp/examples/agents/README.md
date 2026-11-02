# Run a Phở research agent from any agent harness

Your agent (Claude Code, Codex, Cursor, LangGraph, the OpenAI Agents SDK, a cron
script…) hands a research question to Phở, Phở's agent searches PubMed and other
sources over several rounds, checks retractions, grades the evidence and writes a
cited report, and your agent gets the report back as Markdown.

Two ways in, same engine and same rules:

| Way | Use it when | What you call |
| --- | --- | --- |
| **MCP** (`https://mcp.pho.chat/mcp`) | your harness speaks MCP | tools `run_research` → `get_research_run` (→ `cancel_research_run`) |
| **REST** (`https://api.pho.chat/v1`) | anything else, or a backend job | `POST /v1/runs`, `GET /v1/runs/:id`, `GET /v1/artifacts/:id?format=markdown` ([spec](https://api.pho.chat/v1/openapi.json), [example](rest.py)) |

## 1. Get a key

Create one at **https://pho.chat/settings → API keys** (`pho_sk_…`). Agent runs
need a Phở Pro or Founder plan. If you saved your own provider key in Phở
(Settings → BYOK: OpenAI, Anthropic, Google…), runs use it and cost 0 Phở
credits; otherwise they use Phở credits.

```bash
export PHO_API_KEY=pho_sk_...
```

## 2. Connect

The MCP server takes the key in either header:

- `X-Pho-Api-Key: pho_sk_…` (recommended; works next to an OAuth sign-in), or
- `Authorization: Bearer pho_sk_…`

Without a key the same server still offers the ten free, read-only lookup tools
(`verify_references`, `search_papers`, `find_evidence`, `load_dataset`…). With a
key, `run_research`, `get_research_run` and `cancel_research_run` appear too.

| Harness | File |
| --- | --- |
| Claude Code | [claude-code.md](claude-code.md) |
| OpenAI Codex CLI | [codex.md](codex.md) |
| Cursor | [cursor.md](cursor.md) |
| OpenAI Agents SDK (Python) | [openai_agents_sdk.py](openai_agents_sdk.py) |
| LangGraph (Python) | [langgraph_agent.py](langgraph_agent.py) |
| Plain REST, no MCP (Python, stdlib only) | [rest.py](rest.py) |

## 3. How a run goes

1. `run_research({ question, agent?, deliverable?, scope?, year_from?, language? })`
   returns at once with a `run_id`. Calling it again with the same question on the
   same day returns the same run, so an agent that retries does not pay twice.
2. `get_research_run({ run_id, wait_seconds: 30, since })` waits up to 45 s for the
   run to move. Keep calling while the status is `queued` or `running`; pass
   `since = last_seq` to get only new progress steps. A run usually takes a few
   minutes.
3. When the status is `completed`, the result carries the report Markdown (first
   60,000 characters) and its artifact id. The full file is
   `GET https://api.pho.chat/v1/artifacts/<id>?format=markdown` with the same key;
   the `.docx` is in the Phở app.

Agents: `research-writer` (literature review with evidence table and GRADE, the
default), `chat-session` (agentic research ending in a `review`, `table` or
`brief`), `target-evidence` (target–disease evidence from Open Targets).

Limits: 60 API requests a minute and 30 runs an hour per key, plus your plan's
daily run limit. Errors come back as plain sentences with a code
(`plan_required`, `insufficient_credits`, `daily_limit`…).

The report is written by a model from the papers it retrieved, with citations.
Read it as a well-sourced draft, not as a verified conclusion.
