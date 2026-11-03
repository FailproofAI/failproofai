"""langgraph — a real multi-step run: three tools, several turns.

    pip install 'failproofai-sdk[langgraph]'
    python docs/langgraph/examples/research_agent.py

What this demonstrates that the quickstart does not:

* several model turns in one session, each paired `model_request`/`model_response`
  with real token counts and latency;
* three distinct tools, each a `tool_use`/`tool_result` pair carrying arguments
  and output;
* a tool that raises — recorded as `tool_result` with `error` set, and the run
  keeps going, because a failed tool is data, not a crash;
* a named `agent()` scope, so the trace is labelled `analyst` rather than the
  graph's generated id.
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
from langgraph.prebuilt import ToolNode, create_react_agent

failproofai_sdk.configure(environment="examples")
failproofai_sdk.instrument()

_PRICES = {"widget": 42.0, "gadget": 17.5, "sprocket": 3.25}
_STOCK = {"widget": 120, "gadget": 0, "sprocket": 8}


@tool
def price_of(item: str) -> float:
    """Return the unit price of an item in USD."""
    return _PRICES[item.lower().strip()]


@tool
def stock_of(item: str) -> int:
    """Return the units of an item currently in stock."""
    return _STOCK[item.lower().strip()]


@tool
def restock_eta(item: str) -> str:
    """Return the restock ETA. Raises for items that are not tracked."""
    # Deliberately unhandled: the trace should show a failed tool call and the
    # agent recovering from it, which is the interesting case to observe.
    raise LookupError(f"no restock schedule for {item!r}")


def main() -> None:
    banner("langgraph research agent", "3 tools · multi-turn · one failing call")

    # `handle_tool_errors=True` feeds the exception back to the model as a tool
    # message instead of raising out of `.invoke()`. The failproof trace records
    # the failure either way — this just lets the run continue so you can watch
    # the model recover from it.
    tools = ToolNode([price_of, stock_of, restock_eta], handle_tool_errors=True)
    graph = create_react_agent(ChatOpenAI(model=model()), tools)

    question = (
        "For 'widget' and 'gadget': give me the unit price and the stock level. "
        "For anything out of stock, try to look up the restock ETA. "
        "Finish with a two-line summary."
    )

    # `agent("analyst")` names the span. Without it the adapter falls back to the
    # graph's own label, which is stable but not meaningful on a dashboard.
    with failproofai_sdk.session() as sid:
        with failproofai_sdk.agent("analyst", goal="price and stock report"):
            result = graph.invoke({"messages": [HumanMessage(question)]})

    print("   answer:", result["messages"][-1].content.strip()[:200], "\n")
    trace(sid, title="langgraph research agent")


if __name__ == "__main__":
    main()
