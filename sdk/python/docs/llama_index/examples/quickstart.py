"""llama_index — the smallest thing that produces a trace.

    pip install 'failproofai-sdk[llamaindex]'
    python docs/llama_index/examples/quickstart.py

`instrument()` attaches an event handler and a span handler to llama_index's
global dispatcher, so workflow steps arrive as hook pairs and llm calls as
`model_request`/`model_response`.

The scopes work under `async with` as well as `with`, which matters here because
llama_index's agent api is async.
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


def city_population(city: str) -> str:
    """Population of a city."""
    return {"tokyo": "37M", "delhi": "33M"}.get(city.lower(), "unknown")


async def main() -> None:
    banner("llama_index quickstart", "one tool, one turn, async")

    agent = FunctionAgent(
        tools=[FunctionTool.from_defaults(fn=city_population)],
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
        system_prompt="Answer using the tool. Be terse.",
    )
    async with failproofai_sdk.session() as sid:
        answer = await agent.run("What is the population of Tokyo?")

    print("   answer:", str(answer).strip()[:120])
    trace(sid, title="llama_index quickstart")


if __name__ == "__main__":
    asyncio.run(main())
