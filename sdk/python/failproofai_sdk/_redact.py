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
    rest = value[start:]
    for prefix, minimum, label in _PREFIX_RULES:
        if not rest.startswith(prefix):
            continue
        length = 0
        for char in rest[len(prefix) :]:
            if not _is_token_char(char):
                break
            length += 1
        if length >= minimum:
            return len(prefix) + length, label
    return None


def _match_jwt(value: str, start: int):
    if not _at_boundary(value, start) or not value.startswith("eyJ", start):
        return None
    rest = value[start:]
    length = 0
    segments = 0
    while segments < 3:
        segment = 0
        for char in rest[length:]:
            if not (char.isascii() and (char.isalnum() or char in "-_=")):
                break
            segment += 1
        if segment == 0:
            break
        length += segment
        segments += 1
        if segments < 3 and length < len(rest) and rest[length] == ".":
            length += 1
        elif segments < 3:
            break
    if segments == 3 and length >= 40:
        return length, "jwt"
    return None


def _match_bearer(value: str, start: int):
    rest = value[start:]
    if rest[:7].lower() != "bearer ":
        return None
    token_length = 0
    for char in rest[7:]:
        if char.isspace() or char in "\"'":
            break
        token_length += 1
    token = rest[7 : 7 + token_length]
    # The daemon's threshold is bytes; keep short multibyte tokens in parity.
    if len(token.encode("utf-8")) >= 8:
        return 7 + token_length, "bearer-token"
    return None


def _match_assignment(value: str, start: int):
    if start == 0:
        return None
    before = value[:start]
    rest = value[start:]
    if before.endswith("=") and rest.startswith(("\"", "'")):
        return None
    without_quote = before[:-1] if before[-1:] in ("\"", "'") else before
    if not without_quote.endswith("="):
        return None

    name_part = without_quote[:-1]
    name_len = 0
    for char in reversed(name_part):
        if not (char.isascii() and (char.isalnum() or char in "_-")):
            break
        name_len += 1
    if not name_len:
        return None
    name = name_part[-name_len:].lower().strip("-")
    compound = "_" in name or "-" in name
    convincing = any(name.endswith(part) for part in _STRONG_SECRET_NAMES) or (
        compound and any(name.endswith(part) for part in _WEAK_SECRET_NAMES)
    )
    if not convincing or rest.startswith(("{", "$", "<", "(", "`")):
        return None

    quoted = before[-1:] in ("\"", "'")
    length = 0
    for char in rest:
        if char in "\"'" or (not quoted and (char.isspace() or char in ";&")):
            break
        length += 1
    # The daemon measures byte length but advances by bytes; Python advances by
    # characters, so use bytes only for the threshold and return characters.
    if len(rest[:length].encode("utf-8")) >= _MIN_ASSIGNMENT_VALUE:
        return length, "secret-assignment"
    return None


def scrub_string(value: str) -> tuple[str, int]:
    """Return the minimally redacted string and replacement count."""
    out = []
    cursor = 0
    hits = 0
    while cursor < len(value):
        match = (
            _match_prefix(value, cursor)
            or _match_jwt(value, cursor)
            or _match_bearer(value, cursor)
            or _match_assignment(value, cursor)
        )
        if match is None:
            out.append(value[cursor])
            cursor += 1
            continue
        length, label = match
        out.append(f"[redacted:{label}]")
        cursor += length
        hits += 1
    return ("".join(out), hits) if hits else (value, 0)


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
    """Redact every string value in one already-valid JSON event."""
    event = json.loads(encoded)
    hits = 0

    def scrub(value):
        nonlocal hits
        if isinstance(value, str):
            value, count = scrub_string(value)
            hits += count
            return value
        if isinstance(value, list):
            return [scrub(item) for item in value]
        if isinstance(value, dict):
            return {key: scrub(item) for key, item in value.items()}
        return value

    redacted = scrub(event)
    return json.dumps(redacted) if hits else encoded
