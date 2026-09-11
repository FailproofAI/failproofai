import json

import pytest

from failproofai_sdk._redact import redact_json_line, redaction_enabled, scrub_string


@pytest.mark.parametrize(
    ("raw", "marker"),
    [
        ("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", "anthropic-key"),
        ("sk-proj-abcdefghijklmnopqrstuvwxyz", "openai-key"),
        ("ghp_abcdefghijklmnopqrstuvwxyz0123", "github-token"),
        ("AKIAIOSFODNN7EXAMPLE0000", "aws-access-key-id"),
        (
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sIgNaTuRe0123456789ab",
            "jwt",
        ),
        ("Authorization: Bearer tok-🔑🔑🔑-SECRETTAIL", "bearer-token"),
        ("Authorization: Bearer 🔑🔑", "bearer-token"),
        ("API_TOKEN=пароль-очень-ENDOFSECRET", "secret-assignment"),
        ("API_TOKEN=密码密码密码", "secret-assignment"),
    ],
)
def test_minimal_redaction_matches_daemon_secret_shapes(raw, marker):
    scrubbed, count = scrub_string(raw)
    assert count == 1
    assert scrubbed == f"[redacted:{marker}]" or scrubbed.endswith(f"[redacted:{marker}]")
    assert "SECRETTAIL" not in scrubbed
    assert "ENDOFSECRET" not in scrubbed


@pytest.mark.parametrize(
    "value",
    [
        "this is a risk-averse approach",
        "AWS_REGION=us-east-1",
        "key=someLongIdentifier",
        "api_key=$OPENAI_API_KEY",
        "--token=<your-token-here>",
    ],
)
def test_minimal_redaction_leaves_known_false_positives_alone(value):
    assert scrub_string(value) == (value, 0)


def test_redaction_preserves_json_structure_and_is_deterministic():
    encoded = json.dumps(
        {
            "type": "tool_use",
            "input": {"command": 'API_KEY="abcdefghijklmnop" && echo done'},
            "nested": [{"output": "ghp_abcdefghijklmnopqrstuvwxyz0123"}],
        }
    )
    first = redact_json_line(encoded)
    second = redact_json_line(encoded)
    assert first == second
    event = json.loads(first)
    assert event["type"] == "tool_use"
    assert event["input"]["command"] == 'API_KEY="[redacted:secret-assignment]" && echo done'
    assert event["nested"][0]["output"] == "[redacted:github-token]"


@pytest.mark.parametrize(
    "field",
    ["password", "client_secret", "api_key", "access_token", "apiKey", "accessToken"],
)
def test_secret_named_fields_redact_opaque_values(field):
    encoded = json.dumps({"nested": {field: "abcdefghijklmnop"}})
    event = json.loads(redact_json_line(encoded))
    assert event["nested"][field] == "[redacted:secret-assignment]"


def test_credential_shaped_dictionary_keys_are_redacted_without_colliding():
    first = "API_KEY=abcdefghijklmnop"
    second = "API_KEY=qrstuvwxyzabcdef"
    event = json.loads(redact_json_line(json.dumps({"nested": {first: 1, second: 2}})))
    keys = list(event["nested"])
    assert first not in keys
    assert second not in keys
    assert len(keys) == 2
    assert sorted(event["nested"].values()) == [1, 2]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "PASSWORD='abcdefghijkL\"mnopQRST'",
            "PASSWORD='[redacted:secret-assignment]'",
        ),
        (
            'PASSWORD="abcdefghijkL\'mnopQRST"',
            'PASSWORD="[redacted:secret-assignment]"',
        ),
    ],
)
def test_quoted_assignment_stops_only_at_its_matching_quote(raw, expected):
    assert scrub_string(raw) == (expected, 1)


def test_plain_string_scan_does_not_copy_every_remaining_suffix():
    class NoTailSlices(str):
        def __getitem__(self, item):
            if isinstance(item, slice) and item.stop is None and (item.start or 0) > 0:
                raise AssertionError(f"copied the remaining tail at {item.start}")
            return super().__getitem__(item)

    value = NoTailSlices("ordinary payload text " * 100)
    assert scrub_string(value) == (value, 0)


@pytest.mark.parametrize("config", [None, [], {"collector": None}, {"collector": "minimal"}])
def test_malformed_redaction_config_fails_closed(tmp_path, config):
    (tmp_path / "config.json").write_text(json.dumps(config), encoding="utf-8")

    assert redaction_enabled(tmp_path / "custom-agents") is True
