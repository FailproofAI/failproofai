"""LangGraph / LangChain in three lines of telemetry.

    pip install 'failproofai-sdk[langgraph]'
    python examples/langgraph_quickstart.py

`instrument()` installs a tracer on LangChain's global callback manager, so every
graph, node, tool and model call in the process is captured — including ones in
libraries you did not write. Nothing below passes a session or agent id.
"""
import os

import failproofai_sdk
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

failproofai_sdk.configure(environment="quickstart")
failproofai_sdk.instrument()


@tool
def word_count(text: str) -> int:
    """Count the words in a piece of text."""
    return len(text.split())


def main() -> None:
    graph = create_react_agent(
        ChatOpenAI(model=os.environ.get("MODEL", "gpt-4o-mini")), [word_count]
    )
    # A session groups everything below into one run. Omit it and each
    # `.invoke()` becomes its own session, which is usually not what you want.
    with failproofai_sdk.session():
        result = graph.invoke(
            {"messages": [HumanMessage("How many words in 'hello brave new world'?")]}
        )
    print(result["messages"][-1].content)


if __name__ == "__main__":
    main()
