"""llama_index — a multi-tool async agent, including a tool that fails.

    pip install 'failproofai-sdk[llamaindex]'
    python docs/llama_index/examples/research_agent.py

What this demonstrates that the quickstart does not:

* three tools across several turns, each a `tool_use`/`tool_result` pair;
* a tool that raises, recorded as `tool_result` with `error` set while the run
  continues;
* llama_index workflow steps as `hook_triggered`/`hook_completed`, so you can
  see the agent loop itself and not just its llm calls;
* a named `agent()` scope wrapping an async run — the scopes support
  `async with`, so nothing about identity changes when the framework does.
"""
import asyncio
import sys
from pathlib import Path

# Only so this file can import the shared trace printer from docs/_shared/.
# Delete these two lines and the `_shared` import below and the example still
# instruments correctly — it just stops printing its own trace at the end.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import failproofai_sdk
from _shared import banner, model, trace
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.core.tools import FunctionTool
from llama_index.llms.openai import OpenAI

failproofai_sdk.configure(environment="examples")
failproofai_sdk.instrument()

_POP = {"tokyo": "37M", "delhi": "33M", "lagos": "16M"}
_AREA = {"tokyo": "2,194 km2", "delhi": "1,484 km2", "lagos": "1,171 km2"}


def population(city: str) -> str:
    """Population of a city. Valid: tokyo, delhi, lagos."""
    return _POP.get(city.lower().strip(), "unknown")


def area(city: str) -> str:
    """Land area of a city. Valid: tokyo, delhi, lagos."""
    return _AREA.get(city.lower().strip(), "unknown")


def founding_year(city: str) -> str:
    """Founding year of a city. Not actually available for any of them."""
    # Deliberately raises: the trace should show a failed tool and the agent
    # carrying on without it.
    raise LookupError(f"no founding-year record for {city!r}")


async def main() -> None:
    banner("llama_index research agent", "3 tools · multi-turn · one failing call")

    agent = FunctionAgent(
        tools=[
            FunctionTool.from_defaults(fn=population),
            FunctionTool.from_defaults(fn=area),
            FunctionTool.from_defaults(fn=founding_year),
        ],
        llm=OpenAI(
            model=model(),
            # WITHOUT THIS, EVERY TOKEN COUNT IS NULL.
            # FunctionAgent calls `astream_chat`, and llama_index does not ask
            # OpenAI for usage on a stream — so `LLMChatEndEvent` carries a
            # response with no usage on it and there is nothing for any
            # instrumentation to read. This is upstream behaviour, not a
            # failproof one; the line below is the documented way back.
            additional_kwargs={"stream_options": {"include_usage": True}},
        ),
        system_prompt=(
            "Use the tools. If a tool fails, say so and continue with what you have."
        ),
    )

    question = (
        "Compare Tokyo and Delhi on population and area, then try to get the "
        "founding year for each. Finish with a two-line comparison."
    )

    async with failproofai_sdk.session() as sid:
        async with failproofai_sdk.agent("city_analyst", goal="compare two cities"):
            answer = await agent.run(question)

    print("   answer:", str(answer).strip()[:220], "\n")
    trace(sid, title="llama_index research agent")


if __name__ == "__main__":
    asyncio.run(main())
