"""no framework — a real agent loop, hand-instrumented.

    pip install failproofai-sdk openai
    python docs/manual/examples/research_agent.py

A working tool-calling loop against the openai api with no agent framework at
all, instrumented by hand. This is the reference for "my agent is bespoke".

Every event an adapter would emit for you appears here explicitly, so you can
see exactly what the adapters are doing on your behalf:

    session()                     -> identity only, no event
    agent()                       -> agent_start / agent_end
    event.model_request/response  -> one pair per llm turn, with usage
    tool_call()                   -> tool_use / tool_result, duration measured
    event.error                   -> anything you want on the errors surface

The one rule: emit the pairs. `model_request` without `model_response` is an
open span the dashboard renders as still-running forever.
"""
import json
import sys
from pathlib import Path

# Only so this file can import the shared trace printer from docs/_shared/.
# Delete these two lines and the `_shared` import below and the example still
# instruments correctly — it just stops printing its own trace at the end.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import failproofai_sdk
from _shared import banner, model, trace
from openai import OpenAI

failproofai_sdk.configure(environment="examples")

client = OpenAI()

_PRICE = {"widget": 42.0, "gadget": 17.5}
_STOCK = {"widget": 120, "gadget": 0}

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "price_of",
            "description": "Unit price of an item. Valid: widget, gadget.",
            "parameters": {
                "type": "object",
                "properties": {"item": {"type": "string"}},
                "required": ["item"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "stock_of",
            "description": "Units in stock. Valid: widget, gadget.",
            "parameters": {
                "type": "object",
                "properties": {"item": {"type": "string"}},
                "required": ["item"],
            },
        },
    },
]


def run_tool(name: str, args: dict) -> str:
    if name == "price_of":
        return str(_PRICE[args["item"].lower().strip()])
    if name == "stock_of":
        return str(_STOCK[args["item"].lower().strip()])
    raise LookupError(f"unknown tool {name!r}")


def turn(messages: list) -> object:
    """One llm call, bracketed by the model_request/model_response pair."""
    failproofai_sdk.event.model_request(
        model=model(),
        messages=[{"role": m.get("role"), "content": str(m.get("content"))[:200]}
                  for m in messages],
    )
    reply = client.chat.completions.create(
        model=model(), messages=messages, tools=TOOLS
    )
    usage = reply.usage
    failproofai_sdk.event.model_response(
        model=model(),
        response=reply.choices[0].message.content or "",
        input_tokens=getattr(usage, "prompt_tokens", None),
        output_tokens=getattr(usage, "completion_tokens", None),
    )
    return reply.choices[0].message


def main() -> None:
    banner("manual research agent", "no framework · hand-instrumented loop")

    messages = [
        {"role": "system", "content": "Use the tools for every number. Be terse."},
        {"role": "user", "content": "Price and stock for widget and gadget?"},
    ]

    with failproofai_sdk.session() as sid:
        with failproofai_sdk.agent("inventory", goal="price and stock report"):
            for _ in range(4):  # bounded: an unbounded agent loop is its own bug
                message = turn(messages)
                calls = message.tool_calls or []
                if not calls:
                    print("   answer:", (message.content or "").strip()[:200], "\n")
                    break

                messages.append(message.model_dump(exclude_none=True))
                for call in calls:
                    args = json.loads(call.function.arguments or "{}")
                    # tool_call() emits tool_use now and tool_result on exit,
                    # turning a raised exception into `error` on the result.
                    with failproofai_sdk.tool_call(
                        call.function.name, tool_call_id=call.id, input=args
                    ) as handle:
                        handle.output = run_tool(call.function.name, args)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": str(handle.output),
                    })

    trace(sid, title="manual research agent")


if __name__ == "__main__":
    main()
