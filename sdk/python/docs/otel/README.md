# OpenTelemetry spans

Use `failproofai_sdk.instrument("otel", provider=provider)` to attach the optional
OTLP/JSON exporter to your OpenTelemetry `TracerProvider`. Install
`opentelemetry-sdk` in the application, not as a FailproofAI runtime dependency.
`pip install 'failproofai-sdk[otel]'` is the optional convenience extra.

```python
import failproofai_sdk
from opentelemetry.sdk.trace import TracerProvider

provider = TracerProvider()
failproofai_sdk.instrument("otel", provider=provider)
with provider.get_tracer("my-agent").start_as_current_span(
    "agent", attributes={"gen_ai.operation.name": "invoke_agent"}
):
    pass
provider.force_flush()
provider.shutdown()
```

The exporter publishes requests into the relay's spool. Run a connected
`failproofaid` on the same machine; no auth header or exporter network setup is
needed. An org admin must enable OpenTelemetry ingest in Cloud. Export related
spans together and include the root agent span.

You can also pass `failproofai_sdk.OtelSpanExporter()` to your existing span
processor. Existing processors continue unchanged. `uninstrument("otel")` stops
new exports from the processor installed by FailproofAI and leaves the provider
registered. Prompt and response attributes are sent as supplied by your app.

See the [SDK README](../../README.md#opentelemetry-opt-in) for spool overrides and
the zero-dependency contract.

Run [examples/quickstart.py](examples/quickstart.py) for one span, or
[examples/agent_trace.py](examples/agent_trace.py) for an agent/model/tool trace.
