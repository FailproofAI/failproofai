"""Pydantic AI in three lines of telemetry.

    pip install 'failproofai-sdk[pydantic-ai]'
    python examples/pydantic_ai_quickstart.py

`instrument()` appends a capability to every `Agent` constructed afterwards, so
runs, tools and model calls are captured without touching the call sites.
"""
import os

import failproofai_sdk
from pydantic_ai import Agent

failproofai_sdk.configure(environment="quickstart")
failproofai_sdk.instrument()

agent = Agent(f"openai:{os.environ.get('MODEL', 'gpt-4o-mini')}",
              system_prompt="Be terse.")


@agent.tool_plain
def population(city: str) -> str:
    """Population of a city."""
    return {"tokyo": "37M", "delhi": "33M"}.get(city.lower(), "unknown")


def main() -> None:
    with failproofai_sdk.session():
        print(agent.run_sync("Population of Tokyo? Use the tool.").output)


if __name__ == "__main__":
    main()
