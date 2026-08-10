#!/usr/bin/env bash
# A daemon-configured machine has exactly ONE evaluator, and this proves it with
# a REAL CLI process: when the daemon cannot answer — for ANY reason — the call
# is denied, and in-process evaluation is never reached.
#
# This asserted the opposite until enforcement was made daemon-only. A protocol
# mismatch used to fall back to in-process on the grounds that a daemon which
# answered is demonstrably alive. That fallback was a second policy engine
# reachable by breaking the first, so it is gone; what survives from it is the
# MESSAGE, which still names which of the two failures happened, because the
# remedies differ (upgrade the daemon vs. find out why it is down).
set -uo pipefail
# Repo root, derived from this script's own location: these live at
# <repo>/__tests__/e2e/layout/. It was hardcoded to one contributor's home
# directory, so the suite ran on exactly one machine and silently used the
# wrong CLI (or none) on every other.
R=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
H=/tmp/fpai-proto
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "${2:-}"; }
has(){ if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1" "missing [$3] in: $(printf '%s' "$2"|head -c 220)"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q "$3"; then bad "$1" "unexpected [$3]"; else ok "$1"; fi; }

rm -rf "$H"; mkdir -p "$H/run" "$H/policies" "$H/proj"
chmod 700 "$H/run"
# Layout 3 reads the global policy config at the home ROOT; under
# policies/local-policies/ it is never loaded and the policy never fires.
printf '{"enabledPolicies":["block-sudo"]}' > "$H/policies-config.json"
printf '{"mode":{"kind":"oss"},"daemon":{"configured":true}}\n' > "$H/config.json"
printf '{"layout":3,"cli":"1.0.0-beta.5"}\n' > "$H/VERSION"

# A daemon that answers every request stamped with a DIFFERENT protocol version
# — exactly what an old daemon does after the CLI bumps PROTOCOL_VERSION.
cat > "$H/fake-daemon.mjs" <<'JS'
import { createServer } from "node:net";
const enc = (v) => { const b = Buffer.from(JSON.stringify(v), "utf8");
  const h = Buffer.alloc(4); h.writeUInt32BE(b.length, 0); return Buffer.concat([h, b]); };
createServer((s) => {
  s.on("data", () => s.end(enc({ type: "error", protocolVersion: 99,
    message: "protocol version mismatch: daemon speaks 99, client sent 1" })));
}).listen(process.env.SOCK);
JS
SOCK="$H/run/failproofaid.sock" node "$H/fake-daemon.mjs" &
FD=$!
sleep 2
[ -S "$H/run/failproofaid.sock" ] && ok "mismatched daemon is listening" || bad "daemon listening" "no socket"

hook() { printf '{"session_id":"p","cwd":"%s/proj","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$H" "$1" \
  | FAILPROOFAI_HOME="$H" node "$R/dist/cli.mjs" --hook PreToolUse --cli claude 2>&1; }

printf '\n=== PROTOCOL MISMATCH: denies, and says WHICH failure it was ===\n'
OUT=$(hook "ls -la")
has "a daemon that cannot answer denies" "$OUT" '"permissionDecision":"deny"'
has "…named as a version mismatch, not as unreachable" "$OUT" "different protocol version"
has "…and says how to fix it" "$OUT" "failproofai config"
hasnt "…and is NOT reported as unreachable" "$OUT" "could not be reached"

printf '\n=== no in-process evaluation is reachable from here ===\n'
# A command a LOCAL policy would allow must still be denied: reaching a verdict
# of its own would mean a second evaluator ran.
OUT=$(hook "echo hello")
has "an otherwise-allowed command is denied too" "$OUT" '"permissionDecision":"deny"'
hasnt "…and no policy decided it" "$OUT" "sudo commands are blocked"

printf '\n=== CONTROL: a truly absent daemon still FAILS CLOSED ===\n'
kill -TERM $FD 2>/dev/null; sleep 2; rm -f "$H/run/failproofaid.sock"
OUT=$(hook "ls -la")
has "unreachable daemon denies (unchanged)" "$OUT" "could not be reached"
hasnt "…and is NOT reported as a version mismatch" "$OUT" "different protocol version"

printf '\n=== RESULT: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
