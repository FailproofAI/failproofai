"""pydantic_ai — a typed multi-tool run, plus a tool that raises.

    pip install 'failproofai-sdk[pydantic-ai]'
    python docs/pydantic_ai/examples/research_agent.py

What this demonstrates that the quickstart does not:

* three tools over several turns, each a `tool_use`/`tool_result` pair carrying
  the arguments the model actually sent;
* a tool that raises `ModelRetry`, recorded as `tool_result` with `error` set
  while the run still finishes `success` — the adapter deliberately does NOT
  treat a retry as control flow, because an attempt really did fail and that is
  what a tool span's `error` field is for;
* a typed `output_type`, so the run ends with a validated object and the trace
  still reads the same — instrumentation does not care about your result type;
* `usage` on `model_response`, which is where per-run token spend comes from.
"""
import sys
from pathlib import Path

# Only so this file can import the shared trace printer from docs/_shared/.
# Delete these two lines and the `_shared` import below and the example still
# instruments correctly — it just stops printing its own trace at the end.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import failproofai_sdk
from _shared import banner, model, trace
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry

failproofai_sdk.configure(environment="examples")
failproofai_sdk.instrument()

_PRICE = {"widget": 42.0, "gadget": 17.5}
_STOCK = {"widget": 120, "gadget": 0}


class Report(BaseModel):
    """What the run must produce. Validated by pydantic_ai, not by us."""

    headline: str
    out_of_stock: list[str]


agent = Agent(
    f"openai:{model()}",
    output_type=Report,
    system_prompt=(
        "Use the tools for every number. If a tool fails, note it and continue."
    ),
)


@agent.tool_plain
def price_of(item: str) -> float:
    """Unit price of an item. Valid: widget, gadget."""
    return _PRICE[item.lower().strip()]


@agent.tool_plain
def stock_of(item: str) -> int:
    """Units in stock. Valid: widget, gadget."""
    return _STOCK[item.lower().strip()]


@agent.tool_plain
def restock_eta(item: str) -> str:
    """Restock ETA. Not available for anything."""
    # `ModelRetry` is how pydantic_ai hands a failure back to the model instead
    # of raising out of `run_sync`. The failproof trace records it as an errored
    # tool_result either way; this just lets the run finish so you can watch the
    # model work around it.
    raise ModelRetry(f"no restock schedule for {item!r} — answer without it")


def main() -> None:
    banner("pydantic_ai research agent", "3 tools · typed output · one failing call")

    prompt = (
        "For 'widget' and 'gadget', get price and stock. For anything out of "
        "stock, try the restock ETA. Then produce the report."
    )

    with failproofai_sdk.session() as sid:
        with failproofai_sdk.agent("inventory", goal="stock report"):
            result = agent.run_sync(prompt)

    print("   headline:     ", result.output.headline[:120])
    print("   out of stock: ", result.output.out_of_stock, "\n")
    trace(sid, title="pydantic_ai research agent")


if __name__ == "__main__":
    main()
