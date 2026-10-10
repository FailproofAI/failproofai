import json
from pathlib import Path

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.trace import Link, SpanKind, Status, StatusCode

import failproofai_sdk
from failproofai_sdk.integrations import _core


@pytest.fixture(autouse=True)
def enabled_otel(monkeypatch):
    # The CrewAI test module disables its own vendor telemetry at collection.
    # These tests explicitly exercise OTEL, without changing that other suite.
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)


def batches(home):
    result = []
    for file in (home / "state/spool-otlp").glob("*.jsonl"):
        header, body = file.read_bytes().split(b"\n", 1)
        assert json.loads(header) == {"path": "/v1/traces", "content_type": "application/json", "encoding": None}
        assert file.stat().st_mode & 0o777 == 0o600
        result.extend(json.loads(body)["resourceSpans"])
    return result


def test_real_spans_preserve_context_attributes_events_and_precise_time(tmp_path, monkeypatch):
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path))
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(failproofai_sdk.OtelSpanExporter()))
    tracer = provider.get_tracer("scope", "1.0")
    parent = tracer.start_span("agent", start_time=1780000000000000123)
    child = tracer.start_span("chat", kind=SpanKind.CLIENT,
                              context=trace.set_span_in_context(parent),
                              start_time=1780000000000000456,
                              attributes={"gen_ai.operation.name": "chat", "count": 42, "enabled": True, "values": ("a", "b")},
                              links=[Link(parent.get_span_context(), attributes={"linked": True})])
    child.add_event("prompt", {"text": "hi"}, timestamp=1780000000000000789)
    child.set_status(Status(StatusCode.ERROR, "failed"))
    child.end(end_time=1780000001000000012)
    parent.end(end_time=1780000001000000013)
    assert provider.force_flush()
    output = next(span for resource in batches(tmp_path) for scope in resource["scopeSpans"]
                  for span in scope["spans"] if span["name"] == "chat")
    assert output["traceId"] == f"{child.get_span_context().trace_id:032x}"
    assert output["parentSpanId"] == f"{parent.get_span_context().span_id:016x}"
    assert output["kind"] == 3
    assert output["startTimeUnixNano"] == "1780000000000000456"
    assert output["endTimeUnixNano"] == "1780000001000000012"
    assert output["status"] == {"code": 2, "message": "failed"}
    assert {"key": "count", "value": {"intValue": "42"}} in output["attributes"]
    assert output["events"][0]["timeUnixNano"] == "1780000000000000789"
    assert output["links"][0]["spanId"] == f"{parent.get_span_context().span_id:016x}"
    assert not list((tmp_path / "state/spool-otlp").glob("*.tmp"))
    provider.shutdown()


def test_exporter_reports_failures_and_shutdown(tmp_path):
    file = tmp_path / "not-a-directory"
    file.write_text("x")
    exporter = failproofai_sdk.OtelSpanExporter(spool_dir=file)
    provider = TracerProvider()
    span = provider.get_tracer("app").start_span("test")
    span.end()
    assert exporter.export([span]) == SpanExportResult.FAILURE
    exporter.shutdown()
    assert exporter.export([]) == SpanExportResult.FAILURE
    assert exporter.force_flush()
    provider.shutdown()


def test_batches_split_at_relay_limit(tmp_path, monkeypatch):
    from opentelemetry.sdk.trace import SpanLimits
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path))
    provider = TracerProvider(span_limits=SpanLimits(max_attribute_length=10_000_000))
    span = provider.get_tracer("app").start_span("large", attributes={"content": "x" * (4 * 1024 * 1024)})
    span.end()
    assert failproofai_sdk.OtelSpanExporter().export([span, span]) == SpanExportResult.SUCCESS
    assert len(list((tmp_path / "state/spool-otlp").glob("*.jsonl"))) == 2
    assert len(batches(tmp_path)) == 2
    provider.shutdown()


def test_instrument_is_explicit_gated_and_keeps_other_processors(tmp_path, monkeypatch):
    monkeypatch.setenv("FAILPROOFAI_HOME", str(tmp_path))
    _core.set_strict(True)
    provider = TracerProvider()
    other = []

    class Existing:
        def on_start(self, *_args, **_kwargs): pass
        def on_end(self, span): other.append(span.name)
        def shutdown(self): pass
        def force_flush(self, *_args): return True
        def _on_ending(self, span): pass

    provider.add_span_processor(Existing())
    try:
        assert "otel" not in failproofai_sdk.integrations._detected()
        assert failproofai_sdk.instrument("otel", provider=provider) == ("otel",)
        assert failproofai_sdk.instrument("otel", provider=provider) == ()
        tracer = provider.get_tracer("app")
        tracer.start_span("before").end()
        assert provider.force_flush()
        assert len(batches(tmp_path)) == 1
        assert failproofai_sdk.uninstrument("otel") == ("otel",)
        tracer.start_span("after").end()
        assert provider.force_flush()
        assert len(batches(tmp_path)) == 1
        assert other == ["before", "after"]
    finally:
        failproofai_sdk.uninstrument("otel")
        _core.set_strict(None)
        provider.shutdown()
