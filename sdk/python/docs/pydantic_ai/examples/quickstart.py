"""pydantic_ai — the smallest thing that produces a trace.

    pip install 'failproofai-sdk[pydantic-ai]'
    python docs/pydantic_ai/examples/quickstart.py

`instrument()` appends a capability to every `Agent` constructed afterwards, so
runs, tools and model calls are captured without touching the call sites.

Order matters here and nowhere else: an `Agent` built BEFORE `instrument()` does
not carry the capability. Construct agents after instrumenting, or at import
time in a module imported after it.
"""
import sys
from pathlib import Path

# Only so this file can import the shared trace printer from docs/_shared/.
# Delete these two lines and the `_shared` import below and the example still
# instruments correctly — it just stops printing its own trace at the end.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import failproofai_sdk
from _shared import banner, model, trace
from pydantic_ai import Agent

failproofai_sdk.configure(environment="examples")
failproofai_sdk.instrument()

agent = Agent(f"openai:{model()}", system_prompt="Be terse.")


@agent.tool_plain
def population(city: str) -> str:
    """Population of a city."""
    return {"tokyo": "37M", "delhi": "33M"}.get(city.lower(), "unknown")


def main() -> None:
    banner("pydantic_ai quickstart", "one tool, one turn")

    with failproofai_sdk.session() as sid:
        result = agent.run_sync("Population of Tokyo? Use the tool.")

    print("   answer:", str(result.output).strip()[:120])
    trace(sid, title="pydantic_ai quickstart")


if __name__ == "__main__":
    main()
