#!/usr/bin/env python3
"""Drive `failproofai config` through a real pseudo-terminal, screen by screen.

Used by cli-login.sh, inside the systemd container, as the unprivileged user.
The wizard only offers browser login to a real terminal, so a pty is the only
honest way to test it end to end.

Usage: cli-login-driver.py <script> <transcript-file> <url-file> -- <command...>

<script> is a comma-separated list of steps, each `wait:<text>` (block until
the screen shows <text>), `key:<name>` (enter, down, up, esc, ctrl-c, tab),
`url` (wait for the authorize link and write it to <url-file>), or
`sleep:<seconds>`. Exit status is the command's own, or 124 on a timeout.
"""
import os
import pty
import re
import select
import sys
import time

KEYS = {
    "enter": b"\r",
    "down": b"\x1b[B",
    "up": b"\x1b[A",
    "esc": b"\x1b",
    "ctrl-c": b"\x03",
    "tab": b"\t",
}
ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]")
LINK = re.compile(r"https?://\S+/cli/authorize\?r=[0-9a-f]{64}")
STEP_TIMEOUT = float(os.environ.get("DRIVER_STEP_TIMEOUT", "60"))


def main() -> int:
    script, transcript_path, url_path = sys.argv[1], sys.argv[2], sys.argv[3]
    cmd = sys.argv[sys.argv.index("--") + 1 :]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["COLUMNS"] = "100"
        os.execvp(cmd[0], cmd)

    screen = b""
    seen_from = 0  # `wait` only matches text that arrived after the last match

    def pump(timeout: float) -> bool:
        nonlocal screen
        r, _, _ = select.select([fd], [], [], timeout)
        if not r:
            return True
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        screen += chunk
        with open(transcript_path, "ab") as f:
            f.write(chunk)
        return True

    def plain() -> str:
        return ANSI.sub(b"", screen).decode("utf-8", "replace")

    for step in [s for s in script.split(",") if s]:
        kind, _, arg = step.partition(":")
        deadline = time.time() + STEP_TIMEOUT
        if kind == "wait":
            while arg not in plain()[seen_from:]:
                if time.time() > deadline or not pump(0.2):
                    print(f"driver: timed out waiting for {arg!r}", file=sys.stderr)
                    return 124
            seen_from = plain().index(arg, seen_from) + len(arg)
        elif kind == "url":
            while not LINK.search(plain()[seen_from:]):
                if time.time() > deadline or not pump(0.2):
                    print("driver: no authorize link appeared", file=sys.stderr)
                    return 124
            m = LINK.search(plain()[seen_from:])
            seen_from += m.end()
            with open(url_path, "w") as f:
                f.write(m.group(0))
        elif kind == "key":
            time.sleep(0.3)  # let the screen settle so the key lands on it
            os.write(fd, KEYS[arg])
        elif kind == "sleep":
            end = time.time() + float(arg)
            while time.time() < end:
                pump(0.2)

    # Drain until the command exits.
    deadline = time.time() + STEP_TIMEOUT * 2
    while pump(0.2):
        if time.time() > deadline:
            print("driver: command did not exit", file=sys.stderr)
            return 124
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
