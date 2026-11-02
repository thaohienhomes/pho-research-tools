"""Phở research agent from the OpenAI Agents SDK, over MCP.

    pip install openai-agents
    export OPENAI_API_KEY=sk-...        # your agent's own model
    export PHO_API_KEY=pho_sk_...       # https://pho.chat/settings -> API keys
    python openai_agents_sdk.py "SGLT2 inhibitors and heart failure hospitalisation"
"""

import asyncio
import os
import sys

from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

INSTRUCTIONS = """You hand research questions to Phở.
1. Call run_research with the user's question.
2. Call get_research_run with wait_seconds=45 and since=last_seq until the
   status is completed, failed or cancelled.
3. Reply with the report Markdown, unchanged, followed by a three-line summary.
The report is written by Phở's model from the papers it found: say so."""


async def main(question: str) -> None:
    async with MCPServerStreamableHttp(
        name="pho-research",
        params={
            "url": "https://mcp.pho.chat/mcp",
            "headers": {"X-Pho-Api-Key": os.environ["PHO_API_KEY"]},
            # get_research_run waits up to 45 s server-side.
            "timeout": 60,
            "sse_read_timeout": 120,
        },
        client_session_timeout_seconds=60,
    ) as pho:
        agent = Agent(name="Researcher", instructions=INSTRUCTIONS, mcp_servers=[pho])
        # A run takes a few minutes: allow enough turns for the polling.
        result = await Runner.run(agent, question, max_turns=40)
        print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main(" ".join(sys.argv[1:]) or "Metformin and colorectal cancer incidence"))
