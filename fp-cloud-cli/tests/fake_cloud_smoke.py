"""User-level CLI smoke against a local Cloud fake, including paused SSE.

Run after building/installing the wheel:
    python tests/fake_cloud_smoke.py --fp /tmp/fp-smoke/bin/fp --artifacts /job/artifacts

The fake is intentionally server-shaped and does not import the CLI's client.
It exercises actual subprocesses, cookie login, bearer routing and an interactive
approval through a pseudo-terminal. Never connect this script to a live Cloud.
"""

from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Cloud:
    definitions = []
    dashboards = []
    tiles = []
    requests = []
    answers = []
    pending = {}
    unavailable = False
    source = 'EvalResult(score=Score(1.0 if session.count("error") == 0 else 0.0), reasoning="Error-free session")'


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def json_response(self, data, status=200, headers=None):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def stream(self, events):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for event in events:
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()
            if event["type"] == "ask-user":
                if not Cloud.pending[event["callId"]].wait(10):
                    raise RuntimeError("CLI did not answer the pending approval")
        self.close_connection = True

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_PUT(self):
        self.dispatch("PUT")

    def dispatch(self, method):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        body = json.loads(raw) if raw else None
        path = self.path.split("?", 1)[0]
        key_mode = path.startswith("/v1/")
        route = re.sub(r"^/(api|v1)", "", path)
        Cloud.requests.append({"method": method, "path": path, "body": body, "auth": "key" if key_mode else "session"})
        if route == "/auth/otp/request":
            return self.json_response({"ok": True})
        if route == "/auth/otp/verify":
            assert body["code"] == "123456"
            return self.json_response({"user": {"id": "u1", "email": "smoke@example.test"}, "expires_in_secs": 3600},
                headers={"Set-Cookie": "ae_session=fake-session; Path=/"})
        if key_mode:
            assert self.headers.get("Authorization") == "Bearer fake-key"
            assert not self.headers.get("Cookie")
        else:
            assert "ae_session=fake-session" in self.headers.get("Cookie", "")
            assert not self.headers.get("Authorization")
        if Cloud.unavailable:
            return self.json_response({"code": "unknown_route", "error": "old Cloud route absent"}, 404)
        if route == "/auth/session":
            return self.json_response({"id": "u1", "email": "smoke@example.test", "memberships": [
                {"org_id": "o1", "org_slug": "smoke", "org_name": "Smoke", "permissions": ["evaluations:trigger", "events:read", "queries:run", "agent:use"], "permission_set": "admin"}]})
        if route == "/access-granters":
            return self.json_response([])
        if route == "/agent/compose-eval":
            return self.json_response({"eval_key": "error_free", "display_name": "Error free", "result_kind": "score", "labels": ["reliability"],
                "condition_source": "", "evaluator_source": Cloud.source, "reasoning": "Drafted from intent", "kind": "code"})
        if route == "/evaluator-definitions/dry-run":
            assert len(body["session_ids"]) <= 10
            return self.json_response({"runs": [{"ok": True, "session_id": sid, "mode": "run", "result": {"score": {"value": 1.0}}} for sid in body["session_ids"]],
                "summary": {"failed": 0, "succeeded": len(body["session_ids"]), "skipped": 0}})
        if route == "/evaluations/backfill":
            assert body == {
                "from": "2026-10-01T00:00:00Z", "to": "2026-10-08T00:00:00Z",
                "eval_key": "error_free", "dry_run": True,
            }
            return self.json_response({"queued": False, "dry_run": True})
        if route == "/sessions/missing/re-evaluate":
            return self.json_response({"error": "session not found"}, 404)
        if route == "/evaluator-definitions":
            if method == "GET":
                return self.json_response(Cloud.definitions)
            assert body["eval_key"] and body["display_name"] and body["eval_version"]
            assert isinstance(body["evaluator_source"], str)
            if body["evaluator_source"].startswith("{"):
                envelope = json.loads(body["evaluator_source"])
                assert envelope["kind"] in ("judge", "jev")
                assert body["result_kind"] == "score"
            row = {**body, "id": f"d{len(Cloud.definitions) + 1}", "enabled": True}
            Cloud.definitions.append(row)
            return self.json_response(row, 201)
        if route.startswith("/evaluator-definitions/") and method == "PATCH":
            row = next(r for r in Cloud.definitions if r["id"] == route.rsplit("/", 1)[1])
            assert set(body) <= {"enabled", "labels", "display_name"}
            row.update(body)
            return self.json_response(row)
        if route == "/dashboards":
            if method == "GET":
                return self.json_response({"dashboards": Cloud.dashboards})
            assert isinstance(body["definition"], dict)
            row = {**body, "id": "board1"}
            Cloud.dashboards.append(row)
            return self.json_response(row, 201)
        if route == "/dashboards/board1/tiles":
            if method == "GET":
                return self.json_response({"tiles": Cloud.tiles})
            assert body["query_id"] == "q1" and body["chart_type"] == "bar"
            assert all(k in body for k in ("pos_x", "pos_y", "pos_w", "pos_h"))
            row = {**body, "id": "tile1"}
            Cloud.tiles.append(row)
            return self.json_response(row, 201)
        if route.startswith("/events/sentiment"):
            return self.json_response({"positive": 4, "negative": 1, "neutral": 2})
        if route == "/queries/run":
            assert body["sql"].lower().startswith("select")
            return self.json_response({"columns": [{"name": "agent", "type": "String"}, {"name": "events", "type": "UInt64"}],
                "rows": [["agent-smoke", 42]], "truncated": False, "elapsed_ms": 1})
        if route == "/agent/chat":
            call_id = f"ask_{len(Cloud.answers) + 1}"
            Cloud.pending[call_id] = threading.Event()
            return self.stream([
                {"type": "ui-action", "action": "open_artifact", "artifact": {"title": "Events by agent", "sql": "SELECT agent_id, count() FROM events GROUP BY agent_id"}},
                {"type": "ask-user", "kind": "approval", "callId": call_id, "question": "Approve disabling the test alert?", "details": "Change: alert test-alert enabled=false", "allowText": False},
                {"type": "text-delta", "text": "The requested summary is ready."},
                {"type": "done"},
            ])
        if route == "/agent/answer":
            assert body["decision"] in ("approve", "reject")
            Cloud.answers.append(body)
            Cloud.pending[body["callId"]].set()
            return self.json_response({}, 200)
        if route == "/agent/conversations" and method == "POST":
            return self.json_response({"id": "chat-smoke-001"})
        if route == "/agent/conversations/chat-smoke-001/messages":
            assert body["messages"][-1]["content"]["artifacts"]
            return self.json_response({})
        if route == "/agent/home-brief":
            return self.json_response({"greeting": "Hello", "summary": "One agent needs attention.",
                "blocks": [{"key": "traffic", "kind": "table", "title": "Events by agent", "sql": "SELECT 42"}]})
        return self.json_response({"error": "unexpected fake route"}, 404)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fp", required=True)
    parser.add_argument("--artifacts", required=True)
    args = parser.parse_args()
    artifacts = Path(args.artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    transcript = []
    with tempfile.TemporaryDirectory(prefix="fp-user-smoke-") as tmp:
        env = {**os.environ, "FP_HOME": tmp, "FP_ANALYTICS_DISABLED": "1", "COLUMNS": "140", "NO_COLOR": "1"}
        for var in ("FP_TOKEN", "FP_API_KEY", "FP_ORG", "FP_JSON", "FP_DASHBOARD_URL"):
            env.pop(var, None)
        fp = [args.fp, "--base-url", base]

        def run(argv, *, input=None, key=False, json_mode=True, expected=0):
            cmd = fp + (["--api-key", "fake-key"] if key else []) + (["--json"] if json_mode else []) + argv
            completed = subprocess.run(cmd, input=input, text=True, capture_output=True, env=env, cwd=tmp, timeout=20)
            transcript.append("$ fp " + " ".join(argv) + (" [key mode]" if key else " [session mode]") + "\n" + completed.stdout + completed.stderr + f"\nexit {completed.returncode}\n")
            assert completed.returncode == expected, transcript[-1]
            return json.loads(completed.stdout) if json_mode and completed.stdout else completed.stdout

        run(["login", "--email", "smoke@example.test"], input="123456\n", json_mode=False)
        spec = str(Path(tmp) / "evaluator.json")
        run(["evaluators", "draft", "Measure error-free sessions with code", "--kind", "code", "--out", spec])
        run(["evaluators", "create", "--file", spec, "--dry-run-on", "run-001"])
        run(["evaluators", "dry-run", "--file", spec, "--session", "run-001"], key=True)
        run(["evaluators", "deploy", "error_free", "--file", spec, "--version", "2"], key=True)
        assert not Cloud.definitions[0]["enabled"] and Cloud.definitions[1]["enabled"]
        run(["evaluators", "list", "--all"], key=True)
        run(["evaluators", "disable", "error_free@2"], key=True)
        run(["evaluators", "backfill", "--from", "2026-10-01T02:00:00+02:00",
             "--to", "2026-10-07T20:00:00-04:00", "--key", "error_free", "--dry-run"], key=True)
        run(["evaluators", "create", "--key", "relevance", "--name", "Relevance", "--judge", "--criteria", "Grade relevance"], key=True)
        run(["evaluators", "dry-run", "--judge", "--criteria", "Grade relevance"], key=True, expected=2)
        for step in ("score 1 if correct", "give 0 when incorrect", "pass/fail", "yes or no"):
            run(["evaluators", "create", "--key", "binary", "--name", "Binary", "--judge",
                 "--criteria", "Grade relevance", "--step", step], key=True, expected=2)
        run(["evaluators", "create", "--key", "resolution", "--name", "Resolution", "--jev", "noul", "--instructions", "Was the request resolved?", "--true", "Resolved", "--false", "Unresolved"], key=True)
        run(["dashboards", "create", "--name", "Quality"], key=True)
        run(["dashboards", "tiles", "board1", "add", "--query", "q1", "--chart", "bar", "--title", "Traffic"], key=True)
        run(["dashboards", "tiles", "board1", "list"])
        run(["sentiment", "summary"], key=True)
        answer = run(["agent", "ask", "Count events"])
        assert answer["artifacts"][0]["result"]["rows"] == [["agent-smoke", 42]]
        assert Cloud.answers[-1]["decision"] == "reject"
        run(["agent", "ask", "Count events", "--approve"])
        assert Cloud.answers[-1]["decision"] == "approve"
        run(["agent", "brief", "--range", "7d"], json_mode=False)
        run(["evaluators", "draft", "Grade quality"], key=True, expected=2)
        denial = run(["agent", "ask", "Hello"], key=True, expected=2)
        assert denial["error"] == "`fp agent ask` needs a signed-in session: run `fp login`"
        missing = run(["sessions", "re-evaluate", "missing"], key=True, expected=6)
        assert missing["error"] == "session not found"
        assert "not available" not in missing["error"]
        help_text = run(["help"], json_mode=False)
        for group in ("evaluators", "dashboards", "sentiment", "roles", "plan", "otel", "slack"):
            assert group in help_text
        Cloud.unavailable = True
        unavailable = run(["sentiment", "summary"], key=True, expected=6)
        assert "not available on this FailproofAI Cloud yet" in unavailable["error"]
        Cloud.unavailable = False

        # Real terminal approval, with the stream paused until /agent/answer.
        master, slave = pty.openpty()
        proc = subprocess.Popen(fp + ["agent", "ask", "Count events"], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=tmp)
        os.close(slave)
        output = b""
        sent = False
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                output += data
                if b"Approve this change" in output and not sent:
                    os.write(master, b"y\n")
                    sent = True
            if proc.poll() is not None and not ready:
                break
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
        os.close(master)
        transcript.append("$ fp agent ask 'Count events' [interactive approval]\n" + output.decode(errors="replace") + f"\nexit {proc.returncode}\n")
        assert proc.returncode == 0 and sent, transcript[-1]
        assert Cloud.answers[-1]["decision"] == "approve"
        rendered = output.decode(errors="replace")
        assert rendered.index("failproof ai") < rendered.index("Events by agent")
    server.shutdown()
    (artifacts / "fp-user-smoke.txt").write_text("\n".join(transcript), encoding="utf-8")
    (artifacts / "fp-fake-cloud-requests.json").write_text(json.dumps(Cloud.requests, indent=2), encoding="utf-8")
    print(f"User smoke passed: {len(transcript)} CLI invocations; cookie/key auth and paused SSE approvals verified.")


if __name__ == "__main__":
    main()
