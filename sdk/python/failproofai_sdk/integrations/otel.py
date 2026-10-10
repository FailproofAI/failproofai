"""Explicit OTLP/JSON exporter; disk only. OpenTelemetry is an optional runtime import."""
import base64
import json
import logging
import math
import os
import threading
import uuid
from pathlib import Path

_MAX_BYTES = 8 * 1024 * 1024
_METADATA = b'{"path":"/v1/traces","content_type":"application/json","encoding":null}\n'


def _value(value):
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value if math.isfinite(value) else str(value)}
    if isinstance(value, bytes):
        return {"bytesValue": base64.b64encode(value).decode("ascii")}
    if isinstance(value, (list, tuple)):
        return {"arrayValue": {"values": [_value(v) for v in value]}}
    if hasattr(value, "items"):
        return {"kvlistValue": {"values": _attributes(value)}}
    return {}


def _attributes(attributes=None):
    return [{"key": str(k), "value": _value(v)} for k, v in (attributes or {}).items() if v is not None]


def _context(context):
    result = {"traceId": f"{context.trace_id:032x}", "spanId": f"{context.span_id:016x}",
              "flags": int(context.trace_flags)}
    if context.trace_state:
        result["traceState"] = context.trace_state.to_header()
    return result


def _resource_span(span):
    data = _context(span.context)
    if span.parent:
        data["parentSpanId"] = f"{span.parent.span_id:016x}"
    data.update({
        "name": span.name, "kind": span.kind.value + 1,
        "startTimeUnixNano": str(span.start_time), "endTimeUnixNano": str(span.end_time),
        "attributes": _attributes(span.attributes),
        "status": {"code": span.status.status_code.value, **({"message": span.status.description} if span.status.description else {})},
        "droppedAttributesCount": span.dropped_attributes,
        "droppedEventsCount": span.dropped_events, "droppedLinksCount": span.dropped_links,
        "events": [{"name": event.name, "timeUnixNano": str(event.timestamp),
                    "attributes": _attributes(event.attributes),
                    "droppedAttributesCount": event.dropped_attributes} for event in span.events],
        "links": [{**_context(link.context), "attributes": _attributes(link.attributes),
                   "droppedAttributesCount": link.dropped_attributes} for link in span.links],
    })
    scope = span.instrumentation_scope
    return {
        "resource": {"attributes": _attributes(span.resource.attributes)},
        **({"schemaUrl": span.resource.schema_url} if span.resource.schema_url else {}),
        "scopeSpans": [{
            "scope": {"name": scope.name if scope else "", **({"version": scope.version} if scope and scope.version else {})},
            **({"schemaUrl": scope.schema_url} if scope and scope.schema_url else {}),
            "spans": [data],
        }],
    }


class OtelSpanExporter:
    """Exports standard spans durably to the daemon's raw OTLP spool, never HTTP."""

    def __init__(self, *, spool_dir=None):
        self._directory = Path(spool_dir) if spool_dir is not None else None
        self._stopped = False
        self._lock = threading.Lock()

    def export(self, spans):
        from opentelemetry.sdk.trace.export import SpanExportResult
        with self._lock:
            if self._stopped:
                return SpanExportResult.FAILURE
            try:
                directory = self._directory or Path(os.environ.get("FAILPROOFAI_HOME", Path.home() / ".failproofai")) / "state" / "spool-otlp"
                items, chunks, size = [], [], 20
                for span in spans:
                    encoded = json.dumps(_resource_span(span), ensure_ascii=True, separators=(",", ":")).encode("utf8")
                    if len(encoded) + 20 > _MAX_BYTES:
                        raise ValueError("OTEL span exceeds the 8 MiB relay limit")
                    if size + len(encoded) + 1 > _MAX_BYTES:
                        chunks.append(b'{"resourceSpans":[' + b",".join(items) + b"]}")
                        items, size = [], 20
                    items.append(encoded)
                    size += len(encoded) + 1
                if items:
                    chunks.append(b'{"resourceSpans":[' + b",".join(items) + b"]}")
                for chunk in chunks:
                    self._publish(directory, chunk)
                return SpanExportResult.SUCCESS
            except Exception:
                logging.getLogger(__name__).warning("OTEL export failed; request was not published", exc_info=True)
                return SpanExportResult.FAILURE

    def _publish(self, directory, body):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        name = f"otlp-sdk-{uuid.uuid4()}"
        temporary = directory / f".{name}.tmp"
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(_METADATA + body)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, directory / f"{name}.jsonl")
            if os.name != "nt":
                descriptor = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)

    def shutdown(self):
        with self._lock:
            self._stopped = True

    def force_flush(self, timeout_millis=30000):
        return True


class _Gate:
    def __init__(self, processor):
        self.processor = processor
        self.enabled = True

    def on_start(self, span, parent_context=None):
        if self.enabled:
            self.processor.on_start(span, parent_context=parent_context)

    def on_end(self, span):
        if self.enabled:
            self.processor.on_end(span)

    def _on_ending(self, span):
        if self.enabled:
            callback = getattr(self.processor, "_on_ending", None)
            if callback:
                callback(span)

    def shutdown(self):
        self.processor.shutdown()

    def force_flush(self, timeout_millis=30000):
        return self.processor.force_flush(timeout_millis) if self.enabled else True


class _Adapter:
    name = "otel"
    module = "opentelemetry"

    def __init__(self):
        self.gate = None

    def install(self, **options):
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        provider = options.get("provider") or trace.get_tracer_provider()
        if not hasattr(provider, "add_span_processor"):
            if options.get("provider") is not None:
                raise ValueError("OTEL provider must support add_span_processor()")
            provider = TracerProvider()
            trace.set_tracer_provider(provider)
        self.gate = _Gate(BatchSpanProcessor(OtelSpanExporter(spool_dir=options.get("spool_dir"))))
        provider.add_span_processor(self.gate)

    def uninstall(self):
        if self.gate:
            self.gate.enabled = False
            self.gate.shutdown()
            self.gate = None


adapter = _Adapter()
