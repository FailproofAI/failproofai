"""Exercise an installed fp against a local Cloud, never a production deployment."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


class Handler(BaseHTTPRequestHandler):
    legacy = False
    calls = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urlsplit(self.path)
        key_mode = parsed.path.startswith("/v1/")
        if key_mode:
            assert self.headers.get("Authorization") == "Bearer fake-key"
            assert not self.headers.get("Cookie")
        else:
            assert "ae_session=fake-session" in self.headers.get("Cookie", "")
            assert not self.headers.get("Authorization")
        filters = {key: values[0] for key, values in parse_qs(parsed.query).items()
                   if key not in ("limit", "state")}
        self.calls.append({"path": parsed.path, "filters": filters})
        route = parsed.path.removeprefix("/v1").removeprefix("/api")
        issue = {"id": "i1", "title": "Tool timeouts", "state": "firing",
                 "scope": {"harnesses": ["claude"], "agents": ["claude-repo"]}}
        status = 200
        if route == "/issues/facets":
            status = 404 if self.legacy else 200
            data = {"error": "not found"} if self.legacy else {
                "harnesses": [{"value": "claude", "count": 2}],
                "agents": [{"value": "claude-repo", "count": 2}],
            }
        elif route == "/issues/count":
            data = {"count": 2} if self.legacy else {"count": 2, "filters": filters}
        elif route == "/issues":
            data = [issue] if self.legacy else {"issues": [issue], "filters": filters}
        else:
            status, data = 404, {"error": "unknown route"}
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fp", required=True)
    parser.add_argument("--artifacts", required=True)
    args = parser.parse_args()
    artifacts = Path(args.artifacts)
    artifacts.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="fp-issue-smoke-") as cli_home:
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith("FP_") and key != "FAILPROOFAI_HOME"}
            env.update(FP_HOME=cli_home, FP_NO_ANALYTICS="1", TERM="dumb", COLUMNS="140")
            for key_mode in (False, True):
                auth = ["--api-key", "fake-key"] if key_mode else ["--token", "fake-session"]
                mode = "key" if key_mode else "session"
                for command in ("list", "count", "facets"):
                    for as_json in (False, True):
                        result = subprocess.run([
                            args.fp, "--base-url", f"http://127.0.0.1:{server.server_port}",
                            *auth, *(["--json"] if as_json else []), "issues", command,
                            "--harness", "claude", "--harness", "codex", "--env", "prod",
                            "--assignee", "unassigned", "--since", "2026-10-01T00:00:00Z",
                            "--until", "2026-10-14T00:00:00Z", "--search", "tool timeout",
                        ], env=env, text=True, capture_output=True, timeout=20)
                        assert result.returncode == 0, result.stderr
                        if as_json:
                            data = json.loads(result.stdout)
                            assert data["count"] == 2 if command == "count" else bool(data)
                        elif command == "list":
                            assert "[harness:claude]" in result.stdout
                            assert "[agent:claude-repo]" in result.stdout
                        elif command == "facets":
                            assert "claude" in result.stdout and "2" in result.stdout
                        assert "unfiltered" not in result.stderr
                        stem = f"issues-{mode}-{command}-{'json' if as_json else 'human'}"
                        (artifacts / f"{stem}.txt").write_text(result.stdout + result.stderr)
                        assert Handler.calls[-1]["filters"]["harness"] == "claude,codex"
                Handler.legacy = True
                for command in ("list", "count", "facets"):
                    result = subprocess.run([
                        args.fp, "--base-url", f"http://127.0.0.1:{server.server_port}",
                        *auth, "--json", "issues", command, "--harness", "claude",
                    ], env=env, text=True, capture_output=True, timeout=20)
                    json.loads(result.stdout)
                    if command == "facets":
                        assert result.returncode == 6
                        assert "not available on this FailproofAI Cloud yet" in result.stdout
                    else:
                        assert result.returncode == 0
                        assert result.stderr.count("unfiltered") == 1
                    (artifacts / f"issues-{mode}-{command}-legacy.txt").write_text(
                        result.stdout + result.stderr)
                Handler.legacy = False
            (artifacts / "issue-filter-requests.json").write_text(json.dumps(Handler.calls, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    print("Installed fp: session/key filters, facets, human tags, JSON and older-Cloud checks passed.")


if __name__ == "__main__":
    main()
