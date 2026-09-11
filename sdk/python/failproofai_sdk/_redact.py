"""Deterministic credential scrubbing for SDK spool files.

This mirrors the daemon's minimal redaction boundary.  The SDK applies it
before bytes reach disk; the daemon applies it again before upload so batches
written by older SDKs receive the same protection.
"""

import json
import os
from pathlib import Path

_PREFIX_RULES = (
    ("sk-ant-api", 16, "anthropic-key"),
    ("sk-ant-", 16, "anthropic-key"),
    ("sk-proj-", 16, "openai-key"),
    ("sk-", 16, "api-key"),
    ("ghp_", 20, "github-token"),
    ("gho_", 20, "github-token"),
    ("ghu_", 20, "github-token"),
    ("ghs_", 20, "github-token"),
    ("ghr_", 20, "github-token"),
    ("github_pat_", 20, "github-token"),
    ("sb_secret_", 16, "supabase-key"),
    ("sbp_", 20, "supabase-key"),
    ("xoxb-", 16, "slack-token"),
    ("xoxp-", 16, "slack-token"),
    ("AKIA", 16, "aws-access-key-id"),
    ("ASIA", 16, "aws-access-key-id"),
)
_STRONG_SECRET_NAMES = ("secret", "password", "passwd", "credential")
_WEAK_SECRET_NAMES = ("key", "token")
_MIN_ASSIGNMENT_VALUE = 12


def _is_token_char(char: str) -> bool:
    return char.isascii() and (char.isalnum() or char in "_-")


def _at_boundary(value: str, start: int) -> bool:
    return start == 0 or not _is_token_char(value[start - 1])


def _match_prefix(value: str, start: int):
    if not _at_boundary(value, start):
        return None
    for prefix, minimum, label in _PREFIX_RULES:
        if not value.startswith(prefix, start):
            continue
        end = start + len(prefix)
        while end < len(value) and _is_token_char(value[end]):
            end += 1
        if end - start - len(prefix) >= minimum:
            return end - start, label
    return None


def _match_jwt(value: str, start: int):
    if not _at_boundary(value, start) or not value.startswith("eyJ", start):
        return None
    end = start
    segments = 0
    while segments < 3:
        segment_start = end
        while end < len(value):
            char = value[end]
            if not (char.isascii() and (char.isalnum() or char in "-_=")):
                break
            end += 1
        if end == segment_start:
            break
        segments += 1
        if segments < 3 and end < len(value) and value[end] == ".":
            end += 1
        elif segments < 3:
            break
    length = end - start
    if segments == 3 and length >= 40:
        return length, "jwt"
    return None


def _match_bearer(value: str, start: int):
    if value[start : start + 7].lower() != "bearer ":
        return None
    end = start + 7
    token_bytes = 0
    while end < len(value):
        char = value[end]
        if char.isspace() or char in "\"'":
            break
        token_bytes += len(char.encode("utf-8"))
        end += 1
    if token_bytes >= 8:
        return end - start, "bearer-token"
    return None


def _is_secret_name(name: str) -> bool:
    raw = name.strip("-")
    lowered = raw.lower()
    compound = "_" in raw or "-" in raw or any(char.isupper() for char in raw[1:])
    return any(lowered.endswith(part) for part in _STRONG_SECRET_NAMES) or (
        compound and any(lowered.endswith(part) for part in _WEAK_SECRET_NAMES)
    )


def _is_literal_secret(value: str) -> bool:
    return (
        len(value.encode("utf-8")) >= _MIN_ASSIGNMENT_VALUE
        and not value.startswith(("{", "$", "<", "(", "`", "[redacted:"))
    )


def _match_assignment(value: str, start: int):
    if start == 0:
        return None
    if value[start - 1] == "=" and value[start] in "\"'":
        return None

    quote = value[start - 1] if value[start - 1] in "\"'" else None
    equals = start - 2 if quote else start - 1
    if equals < 0 or value[equals] != "=":
        return None

    name_start = equals
    while name_start > 0:
        char = value[name_start - 1]
        if not (char.isascii() and (char.isalnum() or char in "_-")):
            break
        name_start -= 1
    if name_start == equals:
        return None
    if not _is_secret_name(value[name_start:equals]) or value.startswith(
        ("{", "$", "<", "(", "`"), start
    ):
        return None

    end = start
    value_bytes = 0
    while end < len(value):
        char = value[end]
        if (quote and char == quote) or (
            not quote and (char.isspace() or char in ";&\"'")
        ):
            break
        value_bytes += len(char.encode("utf-8"))
        end += 1
    if value_bytes >= _MIN_ASSIGNMENT_VALUE:
        return end - start, "secret-assignment"
    return None


def scrub_string(value: str) -> tuple[str, int]:
    """Return the minimally redacted string and replacement count."""
    out = []
    cursor = 0
    copied_through = 0
    hits = 0
    while cursor < len(value):
        match = (
            _match_prefix(value, cursor)
            or _match_jwt(value, cursor)
            or _match_bearer(value, cursor)
            or _match_assignment(value, cursor)
        )
        if match is None:
            cursor += 1
            continue
        length, label = match
        out.append(value[copied_through:cursor])
        out.append(f"[redacted:{label}]")
        cursor += length
        copied_through = cursor
        hits += 1
    if not hits:
        return value, 0
    out.append(value[copied_through:])
    return "".join(out), hits


def redaction_enabled(base_dir: Path) -> bool:
    """Read the daemon's redaction switch, defaulting safely to minimal."""
    configured_home = os.environ.get("FAILPROOFAI_HOME")
    if base_dir.name == "custom-agents":
        config_path = base_dir.parent / "config.json"
    elif configured_home:
        config_path = Path(configured_home) / "config.json"
    else:
        config_path = Path.home() / ".failproofai" / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            return True
        collector = config.get("collector")
        return not isinstance(collector, dict) or collector.get("redact") != "off"
    except (OSError, TypeError, ValueError):
        return True


def redact_json_line(encoded: str) -> str:
    """Redact credential-shaped keys and string values in a valid JSON event."""
    event = json.loads(encoded)
    hits = 0

    def scrub(value, field_name=None):
        nonlocal hits
        if isinstance(value, str):
            value, count = scrub_string(value)
            hits += count
            if count == 0 and isinstance(field_name, str) and _is_secret_name(field_name):
                if _is_literal_secret(value):
                    hits += 1
                    return "[redacted:secret-assignment]"
            return value
        if isinstance(value, list):
            return [scrub(item) for item in value]
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                redacted_key, count = scrub_string(key)
                hits += count
                unique_key = redacted_key
                suffix = 2
                while unique_key in result:
                    unique_key = f"{redacted_key}#{suffix}"
                    suffix += 1
                result[unique_key] = scrub(item, key)
            return result
        return value

    redacted = scrub(event)
    return json.dumps(redacted) if hits else encoded
