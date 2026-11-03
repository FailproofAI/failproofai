"""Cosmetics shared by the examples. No SDK behaviour lives here.

Two helpers, both deliberately boring:

* `model()` — the model id, from `FPAI_MODEL` / `MODEL`, so one export drives
  every example instead of a dozen edits.
* `trace()` — reads the spool back and prints what the run actually recorded.

`trace()` is the point of these examples. An adapter that "works" is one whose
event stream you can read, so every example ends by printing its own trace
rather than asserting in a comment that events were produced. It reads the same
JSONL the daemon collects, filtered to the session just run.

Nothing here is required to use the SDK. Delete this folder and the examples
still instrument correctly; they just stop printing.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

import failproofai_sdk

# ── brand ────────────────────────────────────────────────────────────────────
# Exact hex from the design system: pink #e4587d, mint #66d1b5, ink #d8d6d2.
# Truecolor, and only when stdout is a terminal — a piped log gets clean text.
_TTY = sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _TTY else text


def pink(t: str) -> str:
    return _c("38;2;228;88;125", t)


def mint(t: str) -> str:
    return _c("38;2;102;209;181", t)


def dim(t: str) -> str:
    return _c("38;2;120;120;130", t)


def bold(t: str) -> str:
    return _c("1", t)


RULE = "━" * 68


def model() -> str:
    """The model id every example runs against."""
    return os.environ.get("FPAI_MODEL") or os.environ.get("MODEL") or "gpt-4o-mini"


def banner(title: str, subtitle: str = "") -> None:
    """Print the example's header and start capturing events."""
    capture()
    print()
    print(pink("━━ ") + bold(title.lower()))
    if subtitle:
        print(dim("   " + subtitle))
    print()


# ── capturing what the run emitted ───────────────────────────────────────────
# NOT by reading the spool. When `failproofaid` is running it collects and
# DELETES each batch file within milliseconds of it appearing, so a spool read
# races the daemon and returns whatever happens to be left — which looks exactly
# like an adapter that only emitted its closing events. (That is a real thing
# that happened while writing these examples.)
#
# So the tap sits on the writer instead: the same dict that goes to disk is
# appended to a list first. Race-free, and it works whether or not a daemon is
# running.
_CAPTURED: list[dict] = []
_TAPPED = False


def capture() -> None:
    """Start recording every event this process emits. Idempotent."""
    global _TAPPED
    if _TAPPED:
        return
    writer = failproofai_sdk._writer
    original = writer.submit

    def _tee(entry: dict) -> None:
        _CAPTURED.append(entry)
        return original(entry)

    writer.submit = _tee  # instance attribute; the real method is untouched
    _TAPPED = True


def events(session_id: str | None = None) -> list[dict]:
    """Everything captured, optionally narrowed to one session."""
    rows = [r for r in _CAPTURED if session_id is None or r.get("session_id") == session_id]
    return sorted(rows, key=lambda r: r.get("timestamp", ""))


_LEAF = {
    "tool_use": "tool_result",
    "model_request": "model_response",
    "hook_triggered": "hook_completed",
    "agent_start": "agent_end",
    "human_wait": "human_input",
    "agent_pause": "agent_resume",
}
_CLOSERS = set(_LEAF.values())


def _detail(row: dict) -> str:
    t = row["type"]
    if t in ("tool_use", "tool_result"):
        bits = [row.get("tool_name") or "?"]
        if row.get("error"):
            bits.append(pink("error"))
        elif t == "tool_result":
            bits.append(mint("ok"))
        return " · ".join(bits)
    if t in ("model_request", "model_response"):
        bits = [row.get("model") or "?"]
        tok = row.get("output_tokens")
        if tok:
            bits.append(f"{tok} out-tok")
        if row.get("error"):
            bits.append(pink("error"))
        return " · ".join(bits)
    if t in ("agent_start", "agent_end"):
        bits = [row.get("agent_id") or "?"]
        if row.get("parent_id"):
            bits.append(dim("under " + row["parent_id"]))
        if row.get("outcome"):
            good = row["outcome"] == "success"
            bits.append((mint if good else pink)(row["outcome"]))
        return " · ".join(bits)
    if t in ("hook_triggered", "hook_completed"):
        return " · ".join(x for x in (row.get("hook_name"), row.get("status")) if x)
    if t == "error":
        return pink(str(row.get("message", ""))[:48])
    for key in ("prompt", "reason", "response", "summary", "goal"):
        if row.get(key):
            return dim(str(row[key])[:48])
    return ""


def trace(session_id: str, *, title: str = "trace") -> list[dict]:
    """Print the event stream this run produced. Returns the rows."""
    rows = events(session_id)
    if not rows:
        print(pink("  no events — is the spool configured?"))
        return rows

    kinds = sorted({r["type"] for r in rows})
    agents = sorted({r.get("agent_id") for r in rows if r.get("agent_id")})
    t0 = rows[0]["timestamp"]

    print(pink("━━ ") + bold(f"failproof_ai · {title}"))
    print(dim(f"   session  {session_id}"))
    print(dim(f"   events   {len(rows)} · agents {len(agents)} · types {len(kinds)}"))
    print()
    print(dim(f"   {'№':>3}  {'offset':>8}  {'event':<16}  detail"))
    print(dim("   " + RULE))

    depth = 0
    for i, row in enumerate(rows, 1):
        t = row["type"]
        if t in _CLOSERS:
            depth = max(depth - 1, 0)
        indent = "  " * depth
        offset = _offset(t0, row["timestamp"])
        name = f"{indent}{t}"
        print(f"   {i:>3}  {dim(offset):>8}  {name:<16}  {_detail(row)}")
        if t in _LEAF:
            depth += 1
    print(dim("   " + RULE))
    print(dim("   " + " ".join(kinds)))
    print()
    return rows


def _offset(first: str, ts: str) -> str:
    from datetime import datetime

    try:
        a = datetime.fromisoformat(first.replace("Z", "+00:00"))
        b = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return f"+{(b - a).total_seconds():.3f}s"
    except Exception:
        return ""
