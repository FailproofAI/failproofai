"""LlamaIndex in three lines of telemetry.

    pip install 'failproofai-sdk[llamaindex]'
    python examples/llamaindex_quickstart.py

`instrument()` attaches an event handler and a span handler to LlamaIndex's
global dispatcher, so workflow steps arrive as hook pairs and LLM calls as
model_request/model_response.

The scopes work under `async with` as well as `with`, which matters here because
LlamaIndex's agent API is async.
"""
import asyncio
import os

import failproofai_sdk
from llama_index.core.agent.workflow import FunctionAgent
from llama_index.core.tools import FunctionTool
from llama_index.llms.openai import OpenAI

failproofai_sdk.configure(environment="quickstart")
failproofai_sdk.instrument()


def city_population(city: str) -> str:
    """Population of a city."""
    return {"tokyo": "37M", "delhi": "33M"}.get(city.lower(), "unknown")


async def main() -> None:
    agent = FunctionAgent(
        tools=[FunctionTool.from_defaults(fn=city_population)],
        llm=OpenAI(model=os.environ.get("MODEL", "gpt-4o-mini")),
        system_prompt="Answer using the tool. Be terse.",
    )
    async with failproofai_sdk.session():
        print(await agent.run("What is the population of Tokyo?"))


if __name__ == "__main__":
    asyncio.run(main())
