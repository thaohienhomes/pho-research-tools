# Claude Code

```bash
export PHO_API_KEY=pho_sk_...   # https://pho.chat/settings → API keys
claude mcp add --transport http pho-research https://mcp.pho.chat/mcp \
  --header "X-Pho-Api-Key: $PHO_API_KEY"
```

Run `/mcp` to check that `pho-research` is connected and lists `run_research`.

Then ask:

> Use pho-research run_research on "SGLT2 inhibitors and heart failure
> hospitalisation in type 2 diabetes, RCTs from 2015". Poll get_research_run
> until it completes, then save the report to `reports/sglt2.md` and list its
> five strongest references.

Tip: the key is stored in Claude Code's MCP config. To keep it out of a shared
`.mcp.json`, add the server with `--scope user` (the default `local` scope is
also private to you).

### As a project skill

Drop this in `.claude/skills/pho-research/SKILL.md` so Claude reaches for it on
its own:

```markdown
---
name: pho-research
description: Hand a substantive literature question to Phở's research agent and bring back a cited report.
---

When the user needs a literature review or an evidence summary (not a quick lookup):
1. Call pho-research `run_research` with the question (add `year_from` / `scope` if the user gave them).
2. Tell the user it is running, then call `get_research_run` with `wait_seconds: 45` and `since: last_seq` until the status is `completed`, `failed` or `cancelled`.
3. Save the report Markdown under `reports/`, then summarise it in five bullets with its citations. Say it is Phở's model-written report.
For a quick check of a few references, use `verify_references` instead.
```
