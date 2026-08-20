"""no framework — the scopes and `event.*` directly.

    pip install failproofai-sdk
    python docs/manual/examples/quickstart.py

There is no adapter here and nothing to instrument. This is the path for an
agent you wrote yourself, or a framework failproof does not support yet.

Three scopes do the identity work:

    session()    binds a session id. emits nothing.
    agent()      brackets a span with agent_start / agent_end.
    tool_call()  brackets a tool with tool_use / tool_result.

Everything inside them can omit `session_id=` and `agent_id=` — the scopes bind
them on contextvars and every `event.*` call reads them back.
"""
import sys
from pathlib import Path

# Only so this file can import the shared trace printer from docs/_shared/.
# Delete these two lines and the `_shared` import below and the example still
# instruments correctly — it just stops printing its own trace at the end.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import failproofai_sdk
from _shared import banner, model, trace

failproofai_sdk.configure(environment="examples")


def look_up(city: str) -> str:
    return {"tokyo": "37M", "delhi": "33M"}.get(city.lower(), "unknown")


def main() -> None:
    banner("manual quickstart", "no framework · scopes + event.*")

    with failproofai_sdk.session() as sid:
        with failproofai_sdk.agent("main", goal="answer one question"):
            # tool_call() emits tool_use on entry and tool_result on exit,
            # measuring duration and recording an exception as an error.
            with failproofai_sdk.tool_call("population", input={"city": "tokyo"}) as call:
                call.output = look_up("tokyo")

            failproofai_sdk.event.model_request(model=model(), messages=[
                {"role": "user", "content": "population of tokyo?"}
            ])
            failproofai_sdk.event.model_response(
                model=model(), output_tokens=3, duration_ms=210, response="37M"
            )

    trace(sid, title="manual quickstart")


if __name__ == "__main__":
    main()
