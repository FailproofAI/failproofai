"""crewai — two agents, two tasks, a shared tool, sequential handoff.

    pip install 'failproofai-sdk[crewai]'
    python docs/crewai/examples/research_crew.py

What this demonstrates that the quickstart does not:

* two `agent_id` values in one session, taken from each agent's `role`, so the
  dashboard can break latency and token spend down per role;
* task boundaries as `hook_triggered`/`hook_completed` pairs — crewai tasks are
  hooks, not nested agents, deliberately: promoting every task to an agent would
  flood `agent_id`, which is a LowCardinality column and the primary facet;
* a second task consuming the first one's output, so the handoff is visible in
  the trace rather than implied.
"""
import sys
from pathlib import Path

# Only so this file can import the shared trace printer from docs/_shared/.
# Delete these two lines and the `_shared` import below and the example still
# instruments correctly — it just stops printing its own trace at the end.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import failproofai_sdk
from _shared import banner, model, trace
from crewai import Agent, Crew, Process, Task
from crewai.tools import tool

failproofai_sdk.configure(environment="examples")
failproofai_sdk.instrument()

MODEL = f"openai/{model()}"

_METRICS = {
    "revenue": "$4.2M ARR, up 12% QoQ",
    "churn": "3.1% monthly logo churn, up from 2.4%",
    "nps": "41, flat",
}


@tool("lookup_metric")
def lookup_metric(name: str) -> str:
    """Look up a business metric by name. Valid names: revenue, churn, nps."""
    return _METRICS.get(name.lower().strip(), "unknown metric")


def main() -> None:
    banner("crewai research crew", "2 agents · 2 tasks · sequential handoff")

    analyst = Agent(
        role="analyst",
        goal="pull the numbers that matter and state them plainly",
        backstory="You read dashboards for a living and distrust round numbers.",
        tools=[lookup_metric],
        llm=MODEL,
    )
    writer = Agent(
        role="writer",
        goal="turn numbers into three lines an exec will actually read",
        backstory="You write board updates. You never pad.",
        llm=MODEL,
    )

    gather = Task(
        description=(
            "Look up 'revenue', 'churn' and 'nps' with the tool. "
            "Report each verbatim, one per line."
        ),
        expected_output="Three lines, one metric each.",
        agent=analyst,
    )
    summarize = Task(
        description="Using the metrics above, write a three-line exec summary.",
        expected_output="Exactly three lines.",
        agent=writer,
        context=[gather],
    )

    with failproofai_sdk.session() as sid:
        result = Crew(
            agents=[analyst, writer],
            tasks=[gather, summarize],
            process=Process.sequential,
        ).kickoff()

    print("   summary:", str(result).strip()[:220], "\n")
    trace(sid, title="crewai research crew")


if __name__ == "__main__":
    main()
