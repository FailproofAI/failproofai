"""crewai — the smallest thing that produces a trace.

    pip install 'failproofai-sdk[crewai]'
    python docs/crewai/examples/quickstart.py

`instrument()` registers a listener on crewai's event bus, so the crew, each
agent and each tool call are recorded. The task gets no span of its own — it is
the agent execution that runs it, and rides along on that agent's events as
`fw_task_id`/`fw_task_name`. `agent_id` comes from the agent's `role`, which is
what makes it a useful dashboard facet rather than a uuid nobody can read.
"""
import sys
from pathlib import Path

# Only so this file can import the shared trace printer from docs/_shared/.
# Delete these two lines and the `_shared` import below and the example still
# instruments correctly — it just stops printing its own trace at the end.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import failproofai_sdk
from _shared import banner, model, trace
from crewai import Agent, Crew, Task
from crewai.tools import tool

failproofai_sdk.configure(environment="examples")
failproofai_sdk.instrument()

MODEL = f"openai/{model()}"


@tool("lookup_metric")
def lookup_metric(name: str) -> str:
    """Look up a business metric by name."""
    return {"revenue": "$4.2M", "churn": "3.1%"}.get(name, "unknown")


def main() -> None:
    banner("crewai quickstart", "one agent, one task, one tool")

    analyst = Agent(
        role="analyst",
        goal="find the revenue number",
        backstory="You read metrics.",
        tools=[lookup_metric],
        llm=MODEL,
    )
    task = Task(
        description="Look up 'revenue' with the tool.",
        expected_output="The revenue figure.",
        agent=analyst,
    )

    with failproofai_sdk.session() as sid:
        result = Crew(agents=[analyst], tasks=[task]).kickoff()

    print("   answer:", str(result).strip()[:120])
    trace(sid, title="crewai quickstart")


if __name__ == "__main__":
    main()
