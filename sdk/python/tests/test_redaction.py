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


@pytest.mark.parametrize("config", [None, [], {"collector": None}, {"collector": "minimal"}])
def test_malformed_redaction_config_fails_closed(tmp_path, config):
    (tmp_path / "config.json").write_text(json.dumps(config), encoding="utf-8")

    assert redaction_enabled(tmp_path / "custom-agents") is True
