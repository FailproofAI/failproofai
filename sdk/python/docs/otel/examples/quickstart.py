"""An optional OTEL span, durably exported with no HTTP setup.

pip install 'failproofai-sdk[otel]'
python docs/otel/examples/quickstart.py
"""
import failproofai_sdk
from opentelemetry.sdk.trace import TracerProvider


def main():
    provider = TracerProvider()
    failproofai_sdk.instrument("otel", provider=provider)
    with provider.get_tracer("my-agent").start_as_current_span(
        "agent", attributes={"gen_ai.operation.name": "invoke_agent"}
    ):
        pass
    provider.force_flush()
    provider.shutdown()


if __name__ == "__main__":
    main()
