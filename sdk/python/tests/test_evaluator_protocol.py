from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from failproofai_sdk.evaluator import (
    ClaimRequest,
    ClaimResponse,
    DefinitionsResponse,
    ErrorResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    PlanRequest,
    PlanResponse,
    ProtocolError,
    RegisterRequest,
    RegisterResponse,
    ResultRequest,
    ResultResponse,
    SessionTranscript,
    UnsupportedProtocolVersion,
    protocol,
)

FIXTURE = Path(__file__).parent / "fixtures" / "evaluator_v2" / "contract.json"


def _contract():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    ("sample", "model"),
    [
        ("register_request", RegisterRequest),
        ("register_response", RegisterResponse),
        ("claim_request", ClaimRequest),
        ("claim_response", ClaimResponse),
        ("definitions_response", DefinitionsResponse),
        ("transcript_response", SessionTranscript),
        ("plan_request", PlanRequest),
        ("plan_response", PlanResponse),
        ("heartbeat_request", HeartbeatRequest),
        ("heartbeat_response", HeartbeatResponse),
        ("result_request", ResultRequest),
        ("result_response", ResultResponse),
        ("error_response", ErrorResponse),
    ],
)
def test_golden_messages_round_trip(sample, model):
    wire = _contract()["samples"][sample]
    assert model.from_wire(wire).to_wire() == wire


def test_unknown_additive_fields_are_tolerated():
    wire = dict(_contract()["samples"]["claim_request"])
    wire["future_optional_field"] = True
    assert ClaimRequest.from_wire(wire).capacity == 2


def test_unsupported_major_version_fails_loudly():
    wire = dict(_contract()["samples"]["claim_request"])
    wire["protocol_version"] = "3"
    with pytest.raises(
        UnsupportedProtocolVersion, match="supported major version is 2"
    ):
        ClaimRequest.from_wire(wire)


def test_transcript_event_count_is_an_integrity_check():
    wire = dict(_contract()["samples"]["transcript_response"])
    wire["event_count"] = 99
    with pytest.raises(ProtocolError, match="transcript contains 2 events"):
        SessionTranscript.from_wire(wire)


@pytest.mark.parametrize(
    ("sample", "model", "path", "value", "message"),
    [
        (
            "claim_response",
            ClaimResponse,
            ("assignments", 0),
            42,
            r"assignments\[0\] must be an object",
        ),
        (
            "register_response",
            RegisterResponse,
            ("disabled_definitions",),
            [42],
            r"disabled_definitions\[0\] must be a string",
        ),
        (
            "heartbeat_response",
            HeartbeatResponse,
            ("accepted_run_ids", 0),
            None,
            r"accepted_run_ids\[0\] must be a string",
        ),
        (
            "plan_response",
            PlanResponse,
            ("runs", 0),
            "not-an-object",
            r"runs\[0\] must be an object",
        ),
        (
            "result_request",
            ResultRequest,
            ("results", 0, "labels", 0),
            7,
            r"labels\[0\] must be a string",
        ),
        (
            "register_request",
            RegisterRequest,
            ("definitions", 0, "result_kind"),
            "unknown",
            "result_kind must be one of",
        ),
    ],
)
def test_nested_wire_values_fail_with_protocol_errors(
    sample, model, path, value, message
):
    wire = copy.deepcopy(_contract()["samples"][sample])
    target = wire
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    with pytest.raises(ProtocolError, match=message):
        model.from_wire(wire)


@pytest.mark.parametrize(
    ("sample", "model", "field", "value", "message"),
    [
        (
            "claim_response",
            ClaimResponse,
            "lease_generation",
            0,
            "lease_generation must be greater than zero",
        ),
        (
            "claim_response",
            ClaimResponse,
            "event_count",
            -1,
            "event_count must not be negative",
        ),
        (
            "result_response",
            ResultResponse,
            "result_count",
            -1,
            "result_count must not be negative",
        ),
    ],
)
def test_server_response_counters_and_generations_are_bounded(
    sample, model, field, value, message
):
    wire = copy.deepcopy(_contract()["samples"][sample])
    if sample == "claim_response":
        wire["assignments"][0][field] = value
    else:
        wire[field] = value
    with pytest.raises(ProtocolError, match=message):
        model.from_wire(wire)


def test_fixture_constants_match_the_sdk_contract():
    contract = _contract()
    assert contract["protocol"] == {
        "supported_major_versions": [protocol.PROTOCOL_VERSION],
        "transcript_schema_version": protocol.TRANSCRIPT_SCHEMA_VERSION,
        "result_schema_version": protocol.RESULT_SCHEMA_VERSION,
    }
    assert contract["http"] == {
        "register": protocol.REGISTER_PATH,
            "claim": protocol.CLAIM_PATH,
            "transcript": protocol.TRANSCRIPT_PATH,
            "definitions": protocol.DEFINITIONS_PATH,
        "plan": protocol.PLAN_PATH,
        "heartbeat": protocol.HEARTBEAT_PATH,
        "result": protocol.RESULT_PATH,
        "worker_id_header": protocol.WORKER_ID_HEADER,
        "lease_generation_header": protocol.LEASE_GENERATION_HEADER,
    }
    assert contract["timing"] == {
        "heartbeat_interval_seconds": protocol.HEARTBEAT_INTERVAL_SECONDS,
        "lease_duration_seconds": protocol.LEASE_DURATION_SECONDS,
        "max_claim_wait_seconds": protocol.MAX_CLAIM_WAIT_SECONDS,
        "max_attempts": protocol.MAX_ATTEMPTS,
    }
    assert contract["limits"] == {
        "max_catalog_definitions": protocol.MAX_CATALOG_DEFINITIONS,
        "max_claim_capacity": protocol.MAX_CLAIM_CAPACITY,
        "max_transcript_bytes": protocol.MAX_TRANSCRIPT_BYTES,
        "max_results_per_run": protocol.MAX_RESULTS_PER_RUN,
        "max_eval_key_bytes": protocol.MAX_EVAL_KEY_BYTES,
        "max_display_name_bytes": protocol.MAX_DISPLAY_NAME_BYTES,
        "max_version_bytes": protocol.MAX_VERSION_BYTES,
        "max_worker_id_bytes": protocol.MAX_WORKER_ID_BYTES,
        "max_label_bytes": protocol.MAX_LABEL_BYTES,
        "max_labels_per_result": protocol.MAX_LABELS_PER_RESULT,
        "max_summary_bytes": protocol.MAX_SUMMARY_BYTES,
        "max_reasoning_bytes": protocol.MAX_REASONING_BYTES,
        "max_unit_bytes": protocol.MAX_UNIT_BYTES,
        "max_display_value_bytes": protocol.MAX_DISPLAY_VALUE_BYTES,
        "max_description_bytes": protocol.MAX_DESCRIPTION_BYTES,
        "max_error_code_bytes": protocol.MAX_ERROR_CODE_BYTES,
        "max_error_message_bytes": protocol.MAX_ERROR_MESSAGE_BYTES,
    }
    assert contract["errors"] == protocol.ERROR_SPECS


def test_session_helpers_use_the_protocol_event_vocabulary():
    session = SessionTranscript.from_wire(_contract()["samples"]["transcript_response"])
    assert session.count("tool_use") == 1
    assert session.events_of_type("agent_end")[0].payload["summary"] == "Done"
