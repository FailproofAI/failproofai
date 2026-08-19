"""CrewAI in three lines of telemetry.

    pip install 'failproofai-sdk[crewai]'
    python examples/crewai_quickstart.py

`instrument()` registers a listener on CrewAI's event bus, so the crew, each
agent, each task and each tool call are captured. `agent_id` comes from the
agent's `role`, which is what makes it a useful facet rather than a UUID.
"""
import os

import failproofai_sdk
from crewai import Agent, Crew, Task
from crewai.tools import tool

failproofai_sdk.configure(environment="quickstart")
failproofai_sdk.instrument()

MODEL = f"openai/{os.environ.get('MODEL', 'gpt-4o-mini')}"


@tool("lookup_metric")
def lookup_metric(name: str) -> str:
    """Look up a business metric by name."""
    return {"revenue": "$4.2M", "churn": "3.1%"}.get(name, "unknown")


def main() -> None:
    analyst = Agent(role="analyst", goal="find the revenue number",
                    backstory="You read metrics.", tools=[lookup_metric], llm=MODEL)
    task = Task(description="Look up 'revenue' with the tool.",
                expected_output="The revenue figure.", agent=analyst)

    with failproofai_sdk.session():
        print(Crew(agents=[analyst], tasks=[task]).kickoff())


if __name__ == "__main__":
    main()
