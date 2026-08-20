"""langgraph — the smallest thing that produces a trace.

    pip install 'failproofai-sdk[langgraph]'
    python docs/langgraph/examples/quickstart.py

`instrument()` installs a tracer on langchain's global callback manager, so
every graph, node, tool and model call in the process is recorded — including
ones inside libraries you did not write. Nothing below passes an id by hand.
"""
import sys
from pathlib import Path

# Only so this file can import the shared trace printer from docs/_shared/.
# Delete these two lines and the `_shared` import below and the example still
# instruments correctly — it just stops printing its own trace at the end.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import failproofai_sdk
from _shared import banner, model, trace
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

failproofai_sdk.configure(environment="examples")
failproofai_sdk.instrument()


@tool
def word_count(text: str) -> int:
    """Count the words in a piece of text."""
    return len(text.split())


def main() -> None:
    banner("langgraph quickstart", "one tool, one turn")
    graph = create_react_agent(ChatOpenAI(model=model()), [word_count])

    # A session groups everything below into one run. Without it each
    # `.invoke()` becomes its own session, which is rarely what you want.
    with failproofai_sdk.session() as sid:
        result = graph.invoke(
            {"messages": [HumanMessage("How many words in 'hello brave new world'?")]}
        )

    print("   answer:", result["messages"][-1].content.strip()[:120])
    trace(sid, title="langgraph quickstart")


if __name__ == "__main__":
    main()
