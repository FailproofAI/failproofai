"""Customer evaluator with deterministic and optional async judge checks."""

from __future__ import annotations

import asyncio
import json
import os
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from failproofai_sdk.evaluator import (
    ConditionResult,
    EvalResult,
    Evaluator,
    Metric,
    Score,
)

app = Evaluator(name="customer-production", version="2026.08.1")


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


@app.eval(
    "tool_efficiency",
    version="1.0.0",
    labels=["tools", "deterministic"],
    when=lambda session: ConditionResult(
        session.count("tool_use") > 0, "no_tool_calls"
    ),
)
def tool_efficiency(session):
    calls = session.events_of_type("tool_use")
    distinct = {
        event.payload.get("tool_name")
        for event in calls
        if event.payload.get("tool_name")
    }
    value = len(distinct) / len(calls)
    return EvalResult(
        score=Score(value, passed=value >= 0.7),
        metrics={
            "tool_call_count": Metric(len(calls), unit="events"),
            "distinct_tool_count": Metric(len(distinct), unit="tools"),
        },
        reasoning=f"{len(distinct)} distinct tools across {len(calls)} calls",
    )


def _judge_configured(session):
    configured = bool(os.environ.get("EXAMPLE_JUDGE_URL"))
    return ConditionResult(configured, "judge_not_configured")


def _last_content(session, event_type):
    events = session.events_of_type(event_type)
    if not events:
        return None
    payload = events[-1].payload
    fields = {
        "human_input": ("response",),
        "model_response": ("content",),
        "agent_end": ("summary",),
    }.get(event_type, ("content", "summary", "response"))
    return next((payload.get(field) for field in fields if payload.get(field)), None)


def _call_judge(question, answer):
    url = os.environ["EXAMPLE_JUDGE_URL"]
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("EXAMPLE_JUDGE_URL must be an absolute http(s) URL")
    token = os.environ.get("EXAMPLE_JUDGE_TOKEN")
    body = json.dumps({"question": question, "answer": answer}).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, data=body, headers=headers, method="POST")
    with build_opener(_RejectRedirects()).open(request, timeout=25) as response:  # nosec B310
        result = json.loads(response.read(64 * 1024))
    return float(result["score"]), str(
        result.get("reasoning") or "Judge returned no reasoning"
    )


@app.eval(
    "answer_relevance",
    version="judge-api-v1",
    labels=["llm_judge", "relevance"],
    when=_judge_configured,
    timeout_seconds=30,
)
async def answer_relevance(session):
    question = _last_content(session, "human_input")
    answer = _last_content(session, "model_response")
    if question is None or answer is None:
        raise ValueError("answer relevance requires human input and model output")
    value, reasoning = await asyncio.to_thread(_call_judge, question, answer)
    value = min(max(value, 0.0), 1.0)
    return EvalResult(
        score=Score(value, passed=value >= 0.7),
        reasoning=reasoning,
        labels=("llm_judge", "relevance"),
    )


if __name__ == "__main__":
    app.run_from_env()
