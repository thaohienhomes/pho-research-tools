"""Phở research agent from LangGraph, over MCP.

    pip install langgraph langchain-mcp-adapters "langchain[anthropic]"
    export ANTHROPIC_API_KEY=...        # your agent's own model (any LangChain chat model works)
    export PHO_API_KEY=pho_sk_...       # https://pho.chat/settings -> API keys
    python langgraph_agent.py "Statins and dementia risk in older adults"
"""

import asyncio
import os
import sys
from datetime import timedelta

from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent

PROMPT = """You hand research questions to Phở. Call run_research, then call
get_research_run (wait_seconds=45, since=last_seq) until the status is
completed, failed or cancelled. Return the report Markdown unchanged and say it
is Phở's model-written report."""


async def main(question: str) -> None:
    client = MultiServerMCPClient(
        {
            "pho": {
                "transport": "streamable_http",
                "url": "https://mcp.pho.chat/mcp",
                "headers": {"X-Pho-Api-Key": os.environ["PHO_API_KEY"]},
                # get_research_run waits up to 45 s server-side.
                "timeout": timedelta(seconds=60),
            }
        }
    )
    tools = await client.get_tools()
    agent = create_react_agent("anthropic:claude-sonnet-4-6", tools, prompt=PROMPT)
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": question}]},
        # Each poll is one tool step; a run takes a few minutes.
        config={"recursion_limit": 80},
    )
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main(" ".join(sys.argv[1:]) or "Statins and dementia risk in older adults"))
