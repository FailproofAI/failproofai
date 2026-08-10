#!/usr/bin/env bash
# E2E pass 2 — the real cloud path against the freshly built stack, plus a live
# daemon + collector writing into the layout-2 directories.
set -uo pipefail
REPO=/home/sidd/Desktop/work-failproofai/failproofai
CLI="node $REPO/dist/cli.mjs"
API=http://localhost:18080
CH=http://localhost:18123
KEY=dev-admin-key
H=/tmp/fpai-c            # short: the daemon socket must fit in SUN_LEN
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
has(){ if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1" "missing [$3] in: $(printf '%s' "$2"|head -c 200)"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q "$3"; then bad "$1" "unexpected [$3]"; else ok "$1"; fi; }

pkill -f "$H/run" 2>/dev/null; rm -rf "$H"; mkdir -p "$H/home" "$H/proj/.failproofai"
export FAILPROOFAI_HOME="$H/home"
export FAILPROOFAI_NO_FIRST_RUN=1

printf '\n=== 1. CONNECT: both capabilities verified against the real server ===\n'
OUT=$($CLI config --connect "$API" --token "$KEY" --send-transcripts 2>&1); RC=$?
has "reports a full connection" "$OUT" "Connected to"
check "exit 0 when policy enrolment succeeds" "$RC" "0"
check "credentials.toml written" "$([ -f "$H/home/credentials.toml" ] && echo y || echo n)" "y"
check "credentials are 0600" "$(stat -c '%a' "$H/home/credentials.toml")" "600"
has "mode flipped to cloud" "$(cat "$H/home/config.toml")" 'kind = "cloud"'
hasnt "token never lands in config.toml" "$(cat "$H/home/config.toml")" "$KEY"
has "both tables present" "$(cat "$H/home/credentials.toml")" "\[cloud\]"
has "ingest table present" "$(cat "$H/home/credentials.toml")" "\[ingest\]"
has "transcripts opted in" "$(cat "$H/home/config.toml")" "sessions = true"

printf '\n=== 2. DAEMON: starts, reads layout-2 config, enables the collector ===\n'
mkdir -p "$H/home/policies/local-policies"
printf '{"enabledPolicies":["block-sudo"]}' > "$H/home/policies/local-policies/policies-config.json"
mkdir -p "$H/run"; chmod 700 "$H/run"
FAILPROOFAI_DAEMON_SOCKET="$H/run/d.sock" \
FAILPROOFAI_HOME="$H/home" \
FAILPROOFAI_WORKER_CMD="node $REPO/dist/worker.mjs" \
RUST_LOG=info "$REPO/target/release/failproofaid" > "$H/daemon.log" 2>&1 &
DPID=$!
sleep 10
check "daemon alive" "$(kill -0 $DPID 2>/dev/null && echo y || echo n)" "y"
LOG=$(cat "$H/daemon.log")
has "collector enabled from config.toml" "$LOG" "collector enabled"
has "sessions=true read from TOML" "$LOG" "sessions=true"
has "ingest URL read from credentials.toml" "$LOG" "$API/events"
has "cloud policy polling ON (credentials found)" "$LOG" "cloud"

printf '\n=== 3. COLLECTOR WRITES INTO LAYOUT 2, NOT THE OLD PATHS ===\n'
sleep 12
check "state/ created" "$([ -d "$H/home/state" ] && echo y || echo n)" "y"
check "cursors/ at top level" "$([ -d "$H/home/cursors" ] && echo y || echo n)" "y"
check "health under state/" "$([ -f "$H/home/state/collector-health.json" ] && echo y || echo n)" "y"
check "NO legacy spool/ at root" "$([ -d "$H/home/spool" ] && echo y || echo n)" "n"
check "NO legacy collector-health.json at root" "$([ -f "$H/home/collector-health.json" ] && echo y || echo n)" "n"

printf '\n=== 4. HOOK DECISIONS REACH CLICKHOUSE ===\n'
for i in 1 2 3; do
  printf '{"session_id":"e2e-cloud","cwd":"%s/proj","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sudo rm -rf /"}}' "$H" \
    | $CLI --hook PreToolUse --cli claude >/dev/null 2>&1
done
D=$(printf '{"session_id":"e2e-cloud","cwd":"%s/proj","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sudo id"}}' "$H" | $CLI --hook PreToolUse --cli claude 2>/dev/null)
has "block-sudo denies" "$D" '"permissionDecision":"deny"'
printf '  waiting for the collector to ship…\n'
for i in $(seq 1 24); do
  N=$(curl -s -m 5 "$CH/?query=SELECT+count()+FROM+agenteye.events+WHERE+session_id='e2e-cloud'+FORMAT+TSV" 2>/dev/null | tr -d '[:space:]')
  [ -n "${N:-}" ] && [ "$N" != "0" ] && break
  sleep 5
done
if [ -n "${N:-}" ] && [ "$N" != "0" ]; then ok "hook events landed in ClickHouse (n=$N)"; else bad "hook events landed in ClickHouse" "count=$N"; fi
HN=$(curl -s -m 5 "$CH/?query=SELECT+count()+FROM+agenteye.events+WHERE+hook_name='PreToolUse'+FORMAT+TSV" 2>/dev/null | tr -d '[:space:]')
if [ "${HN:-0}" != "0" ]; then ok "PreToolUse decisions recorded server-side (n=$HN)"; else bad "PreToolUse recorded" "0"; fi

printf '\n=== 5. SPOOL DRAINS (delivery actually completed) ===\n'
LEFT=$(find "$H/home/state/spool" -type f 2>/dev/null | wc -l)
check "spool drained" "$LEFT" "0"
check "nothing parked in failed/" "$(find "$H/home/state/failed" -type f 2>/dev/null | wc -l)" "0"

printf '\n=== 6. DISCONNECT RETURNS THE MACHINE TO OSS ===\n'
kill -TERM $DPID 2>/dev/null; sleep 3
DIS=$($CLI config --disconnect 2>&1)
has "reports disconnection" "$DIS" "Disconnected"
has "mode back to oss" "$(cat "$H/home/config.toml")" 'kind = "oss"'
CRED=$(cat "$H/home/credentials.toml" 2>/dev/null || echo "")
hasnt "cloud token gone" "$CRED" "$KEY"

printf '\n=== 7. OSS MODE IS PROVABLY SILENT ===\n'
BEFORE=$(curl -s -m 5 "$CH/?query=SELECT+count()+FROM+agenteye.events+FORMAT+TSV" | tr -d '[:space:]')
for i in 1 2 3; do
  printf '{"session_id":"oss-silent","cwd":"%s/proj","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sudo id"}}' "$H" \
    | $CLI --hook PreToolUse --cli claude >/dev/null 2>&1
done
sleep 5
AFTER=$(curl -s -m 5 "$CH/?query=SELECT+count()+FROM+agenteye.events+WHERE+session_id='oss-silent'+FORMAT+TSV" | tr -d '[:space:]')
check "no OSS-mode events reached the server" "${AFTER:-0}" "0"

pkill -f "$H/run" 2>/dev/null
printf '\n=== RESULT: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
