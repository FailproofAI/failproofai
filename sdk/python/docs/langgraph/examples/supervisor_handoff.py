"""langgraph — a supervisor delegating to two workers.

    pip install 'failproofai-sdk[langgraph]'
    python docs/langgraph/examples/supervisor_handoff.py

Multi-agent is where a flat event log stops being readable, so this is the
example to run if you want to see what the parent/child structure buys you.

Each worker runs inside its own `agent()` scope nested in the supervisor's, so
every event a worker emits carries `parent_id="supervisor"` and `depth=2`. The
dashboard renders that as a tree; a flat log cannot tell you which agent made
which model call.
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
def fetch_incidents(service: str) -> str:
    """List recent incidents for a service."""
    return {
        "checkout": "2 incidents: 503 spike (12m), payment timeout (4m)",
        "search": "1 incident: index lag (31m)",
    }.get(service, "no incidents on record")


@tool
def oncall_for(service: str) -> str:
    """Return who is on call for a service."""
    return {"checkout": "dana", "search": "kim"}.get(service, "unassigned")


def worker(name: str, tools: list, prompt: str) -> str:
    """One delegated unit of work, bracketed as its own child agent."""
    graph = create_react_agent(ChatOpenAI(model=model()), tools)
    with failproofai_sdk.agent(name, goal=prompt[:60]):
        out = graph.invoke({"messages": [HumanMessage(prompt)]})
        return out["messages"][-1].content


def main() -> None:
    banner("langgraph supervisor handoff", "1 supervisor → 2 workers · nested spans")

    with failproofai_sdk.session() as sid:
        with failproofai_sdk.agent("supervisor", goal="incident brief for checkout"):
            incidents = worker(
                "incident_worker",
                [fetch_incidents],
                "Use the tool to list recent incidents for the 'checkout' service.",
            )
            owner = worker(
                "roster_worker",
                [oncall_for],
                "Use the tool to say who is on call for the 'checkout' service.",
            )

            # The supervisor's own model turn, at depth 1 — the two worker turns
            # above are at depth 2 and carry parent_id="supervisor".
            summary = ChatOpenAI(model=model()).invoke(
                [HumanMessage(f"In two lines, brief the on-call.\n{incidents}\n{owner}")]
            )

    print("   brief:", summary.content.strip()[:200], "\n")
    trace(sid, title="langgraph supervisor handoff")


if __name__ == "__main__":
    main()
