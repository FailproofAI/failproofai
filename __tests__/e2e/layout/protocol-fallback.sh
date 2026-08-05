#!/usr/bin/env bash
# Proves the outage fix with a REAL CLI process: a daemon-configured machine
# whose daemon speaks a different protocol must EVALUATE, not deny.
set -uo pipefail
R=/home/sidd/Desktop/work-failproofai/failproofai
H=/tmp/fpai-proto
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "${2:-}"; }
has(){ if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1" "missing [$3] in: $(printf '%s' "$2"|head -c 220)"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q "$3"; then bad "$1" "unexpected [$3]"; else ok "$1"; fi; }

rm -rf "$H"; mkdir -p "$H/run" "$H/policies/local-policies" "$H/proj"
chmod 700 "$H/run"
printf '{"enabledPolicies":["block-sudo"]}' > "$H/policies/local-policies/policies-config.json"
printf '[mode]\nkind = "oss"\n\n[daemon]\nconfigured = true\n' > "$H/config.toml"
printf 'layout = 2\ncli = "1.0.0-beta.5"\n' > "$H/VERSION"

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

printf '\n=== PROTOCOL MISMATCH: must EVALUATE, not deny ===\n'
OUT=$(hook "ls -la")
hasnt "a harmless command is NOT denied (no fleet lockout)" "$OUT" "could not be reached"
hasnt "…and not denied at all" "$OUT" '"permissionDecision":"deny"'
has "warns that it fell back" "$OUT" "different protocol version"
has "…and says how to fix it" "$OUT" "failproofai config"

printf '\n=== …and policies STILL ENFORCE on the fallback path ===\n'
OUT=$(hook "sudo rm -rf /")
has "block-sudo still denies" "$OUT" "sudo commands are blocked"
hasnt "denied by policy, not by fail-closed" "$OUT" "could not be reached"

printf '\n=== CONTROL: a truly absent daemon still FAILS CLOSED ===\n'
kill -TERM $FD 2>/dev/null; sleep 2; rm -f "$H/run/failproofaid.sock"
OUT=$(hook "ls -la")
has "unreachable daemon denies (unchanged)" "$OUT" "could not be reached"

printf '\n=== RESULT: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
