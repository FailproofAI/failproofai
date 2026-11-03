"""Export one related agent/model/tool trace through the local spool.

pip install 'failproofai-sdk[otel]'
python docs/otel/examples/agent_trace.py
"""
import failproofai_sdk
from opentelemetry.sdk.trace import TracerProvider


def main():
    provider = TracerProvider()
    failproofai_sdk.instrument("otel", provider=provider)
    tracer = provider.get_tracer("planner")
    with tracer.start_as_current_span(
        "planner", attributes={"gen_ai.operation.name": "invoke_agent"}
    ):
        with tracer.start_as_current_span(
            "model", attributes={"gen_ai.operation.name": "chat"}
        ):
            pass
        with tracer.start_as_current_span(
            "search", attributes={"gen_ai.operation.name": "execute_tool"}
        ):
            pass
    provider.force_flush()
    provider.shutdown()


if __name__ == "__main__":
    main()
