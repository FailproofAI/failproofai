#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Pairs a machine with a REAL AgentEye deployment and proves the whole chain:
#
#   key introspection -> permission gating -> enrolment -> daemon pull ->
#   artifact integrity -> ENFORCE -> OBSERVE -> ingest reaching the server
#
# Everything here talks to the live stack on :8080 and a real failproofaid
# process. Nothing is mocked.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API=http://localhost:8080
OPS=k-ops-e2e-55555555
K_BOTH=k-both-33333333
K_EVENTS=k-events-only-11111111
K_POLICIES=k-policies-only-22222222
K_NEITHER=k-neither-44444444
MACHINE=e2e-machine
DAEMON="$R/target/release/failproofaid"
CLI="$R/dist/cli.mjs"

H=/tmp/fpai-e2e-home
FAKEHOME=/tmp/fpai-e2e-fakehome
LOG=/tmp/fpai-e2e-daemon.log

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "${2:-}"; }
has()   { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1" "missing [$3] in: $(printf '%s' "$2" | tr '\n' ' ' | head -c 260)"; fi; }
hasnt() { if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1" "unexpected [$3] in: $(printf '%s' "$2" | tr '\n' ' ' | head -c 260)"; else ok "$1"; fi; }
eq()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want [$3] got [$2]"; fi; }
head1() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

stop_daemon() {
  [ -n "${DPID:-}" ] && kill "$DPID" 2>/dev/null
  # Any stragglers from an earlier run — matched on the binary path, never via
  # `pkill -f`, which also matches this script's own command line.
  pkill -x failproofaid 2>/dev/null
  sleep 1
}
trap stop_daemon EXIT

reset_home() {
  rm -rf "$H" "$FAKEHOME"; mkdir -p "$H" "$FAKEHOME"
}

connect() { # <token> [extra args...]
  local tok="$1"; shift
  FAILPROOFAI_HOME="$H" node "$CLI" config --connect "$API" \
    --token "$tok" --machine-id "$MACHINE" "$@" 2>&1
}

api() { # <method> <path> <token> [json]
  local m="$1" p="$2" t="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -s -m 15 -X "$m" -H "Authorization: Bearer $t" -H 'Content-Type: application/json' \
      -d "$body" "$API$p"
  else
    curl -s -m 15 -X "$m" -H "Authorization: Bearer $t" "$API$p"
  fi
}

jqp() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

hook() { # <command> -> the raw hook JSON response
  printf '{"session_id":"e2e-sess","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' \
    "$H" "$1" | FAILPROOFAI_HOME="$H" HOME="$FAKEHOME" node "$CLI" --hook PreToolUse --cli claude 2>&1
}

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 0 — preconditions"
curl -s -m 5 -o /dev/null -w '' "$API/health" && ok "AgentEye is up on $API" || bad "AgentEye is up" "no /health"
[ -x "$DAEMON" ] && ok "failproofaid binary built" || bad "failproofaid binary built" "$DAEMON missing"
[ -f "$CLI" ] && ok "CLI bundle built" || bad "CLI bundle built" "$CLI missing"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 1 — the key is checked BEFORE it is used (live introspect)"

reset_home
OUT=$(connect "$K_BOTH")
# Asserted in two parts, because the CLI shows a human LABEL beside the id when
# the machine has one — `shownAs` in cloud-enrollment-cli.ts renders
# "<label> (<id>)" and falls back to the bare id only when they are equal. A
# single fixed-string assertion on "as <id>" therefore passed on an unlabelled
# machine and failed on a labelled one, which is a property of whoever ran it
# last, not of the code under test.
has "a key with both permissions connects" "$OUT" "Connected to $API as"
has "…identifying this machine" "$OUT" "$MACHINE"
has "…and the server's own org is named back to the user" "$OUT" "FailproofAI (failproofai)"
has "…policy capability configured" "$OUT" "Policy"
has "…dashboard capability configured" "$OUT" "hook activity will be sent"
has "…and ingest targets the VERSIONED route" "$OUT" "$API/v1/events"
CREDS=$(cat "$H/credentials.json")
has "credentials.json carries the policy token" "$CREDS" '"cloud":'
has "…the ingest key" "$CREDS" '"ingest":'
has "…and the org, recorded once" "$CREDS" '"org":'
has "…by slug" "$CREDS" '"slug": "failproofai"'
eq  "credentials.json is owner-only" "$(stat -c '%a' "$H/credentials.json")" "600"
STATUS=$(FAILPROOFAI_HOME="$H" node "$CLI" config --status 2>&1)
has "--status reports the org offline" "$STATUS" "failproofai"
hasnt "--status never prints the token" "$STATUS" "$K_BOTH"

reset_home
OUT=$(connect "$K_EVENTS")
has "an events-only key still configures the dashboard" "$OUT" "dashboard reporting only"
has "…and names the missing permission, not a generic 403" "$OUT" "policies:pull"
has "…identifying the org the key IS valid for" "$OUT" "FailproofAI (failproofai)"
[ -f "$H/credentials.json" ] && has "…records the org with no cloud credential" "$(cat "$H/credentials.json")" '"org":' \
  || bad "…records the org with no cloud credential" "no credentials.json"
hasnt "…and writes no policy credential it cannot use" "$(cat "$H/credentials.json")" '"cloud":'

reset_home
OUT=$(connect "$K_POLICIES")
has "a policies-only key still enrols for policy" "$OUT" "for policy only"
has "…and names the missing ingest permission" "$OUT" "events:add"
hasnt "…and writes no ingest credential" "$(cat "$H/credentials.json")" '"ingest":'

reset_home
OUT=$(connect "$K_NEITHER")
has "a key with neither permission is refused" "$OUT" "Could not connect"
has "…naming events:add" "$OUT" "events:add"
has "…and policies:pull" "$OUT" "policies:pull"
[ -f "$H/credentials.json" ] && bad "…and writes nothing at all" "credentials.json exists" || ok "…and writes nothing at all"
CFG=$(cat "$H/config.json" 2>/dev/null)
hasnt "…leaving the machine in oss mode, provably silent" "$CFG" '"kind": "cloud"'

reset_home
OUT=$(connect "not-a-real-key")
has "a key the server rejects is reported as rejected" "$OUT" "did not accept"
[ -f "$H/credentials.json" ] && bad "…and writes nothing" "credentials.json exists" || ok "…and writes nothing"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 2 — author and deploy a cloud-managed policy"

POLICY_SRC='import { customPolicies, deny, allow } from "failproofai";
customPolicies.add({
  name: "e2e-cloud-guard",
  description: "E2E cloud-managed guard",
  match: { events: ["PreToolUse"], tools: ["Bash"] },
  fn: async (ctx) => /forbidden-by-cloud/.test(String(ctx.toolInput?.command ?? ""))
    ? deny("blocked by the cloud-managed policy")
    : allow(),
});
'
BODY=$(python3 -c "import json,sys;print(json.dumps({'id':'e2e-cloud-guard','description':'e2e','source':sys.stdin.read()}))" <<< "$POLICY_SRC")
PUB=$(api POST /enforcement/policies "$OPS" "$BODY")
VER=$(printf '%s' "$PUB" | jqp "['version']")
[ -n "$VER" ] && ok "policy published (version $VER)" || bad "policy published" "$PUB"

DEP=$(api PUT "/enforcement/deployments/$MACHINE" "$OPS" \
  "{\"policies\":[{\"id\":\"e2e-cloud-guard\",\"version\":$VER}]}")
DEPL=$(printf '%s' "$DEP" | jqp "['deployment']")
[ -n "$DEPL" ] && ok "policy deployed to $MACHINE (deployment $DEPL)" || bad "policy deployed" "$DEP"

DS=$(api GET "/enforcement/v1/desired-state?machineId=$MACHINE" "$OPS")
eq "desired-state names the policy" "$(printf '%s' "$DS" | jqp "['policies'][0]['id']")" "e2e-cloud-guard"
eq "…defaulting to enforce, never to observe" "$(printf '%s' "$DS" | jqp "['policies'][0]['effect']")" "enforce"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 3 — the daemon pulls it, verifies it, and the CLI can read it"

reset_home
connect "$K_BOTH" >/dev/null
python3 - "$H/config.json" <<'PY'
import sys, json, pathlib
# What `failproofai config` sets after a successful service install. Set here
# directly because installing a system unit needs root this run does not have.
#
# Parsed and re-serialised rather than string-replaced. The replace form was a
# TOML edit left over from layout 2: against a JSON file it matched nothing,
# wrote the file back BYTE-IDENTICAL, and every assertion after it ran against a
# machine that was never daemon-configured — the phase silently tested nothing.
p = pathlib.Path(sys.argv[1]); d = json.loads(p.read_text())
d.setdefault("daemon", {})["configured"] = True
p.write_text(json.dumps(d, indent=2) + "\n")
PY
has "machine marked daemon-configured" "$(cat "$H/config.json")" '"configured": true'

FAILPROOFAI_HOME="$H" HOME="$FAKEHOME" \
  FAILPROOFAI_WORKER_COMMAND="$(command -v node) $R/dist/worker.mjs" \
  FAILPROOFAI_CLOUD_POLICY_POLL_MS=1000 \
  "$DAEMON" >"$LOG" 2>&1 &
DPID=$!
sleep 8

SOCK=$(grep -o 'listening on /[^ ]*failproofaid.sock' "$LOG" | head -1)
has "the daemon binds inside FAILPROOFAI_HOME, where the CLI looks" "$SOCK" "$H/run/failproofaid.sock"
hasnt "cloud polling is NOT disabled on an enrolled machine" "$(cat "$LOG")" "cloud-managed policy polling disabled"

ACTIVE="$H/policies/cloud-policies/active.json"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$ACTIVE" ] && break; sleep 1; done
[ -f "$ACTIVE" ] && ok "the pulled deployment lands where the CLI reads it" \
  || bad "the pulled deployment lands where the CLI reads it" "no $ACTIVE"
MAN=$(cat "$ACTIVE" 2>/dev/null)
has "…naming the deployed policy" "$MAN" "e2e-cloud-guard"
has "…with its content hash" "$MAN" "sha256"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 4 — ENFORCE: the cloud policy actually blocks"

OUT=$(hook "echo forbidden-by-cloud")
has "a command the cloud policy forbids is DENIED" "$OUT" '"permissionDecision":"deny"'
has "…for the policy's stated reason" "$OUT" "blocked by the cloud-managed policy"
hasnt "…denied by the policy, not by a fail-closed daemon" "$OUT" "could not be reached"

OUT=$(hook "echo hello")
hasnt "an unrelated command is not denied" "$OUT" '"permissionDecision":"deny"'

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 5 — OBSERVE: evaluated, recorded, never blocking"

api PUT "/enforcement/deployments/$MACHINE" "$OPS" \
  "{\"policies\":[{\"id\":\"e2e-cloud-guard\",\"version\":$VER,\"effect\":\"observe\"}]}" >/dev/null
DS=$(api GET "/enforcement/v1/desired-state?machineId=$MACHINE" "$OPS")
eq "the same policy is redeployed as observe" "$(printf '%s' "$DS" | jqp "['policies'][0]['effect']")" "observe"

for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  grep -qE '"effect":\s*"observe"' "$ACTIVE" 2>/dev/null && break; sleep 1
done
if grep -qE '"effect":\s*"observe"' "$ACTIVE" 2>/dev/null; then
  ok "the daemon picks up the effect change with no restart"
else
  bad "the daemon picks up the effect change with no restart" "$(cat "$ACTIVE")"
fi

# Count first, never delete: the collector is tailing this file, and removing
# it out from under the tailer would be testing our own cleanup, not the product.
BEFORE=$(wc -l < "$H/hook-activity/current.jsonl" 2>/dev/null || echo 0)
OUT=$(hook "echo forbidden-by-cloud")
hasnt "the SAME command is no longer blocked" "$OUT" '"permissionDecision":"deny"'
sleep 2
# The decision log records decisions, not command text (hooks_verbosity =
# "decisions"), so the new record is identified by position, not by grep.
REC=$(tail -n +$((BEFORE + 1)) "$H/hook-activity/current.jsonl" 2>/dev/null | tail -1)
has "…the record allowed it" "$REC" '"decision":"allow"'
has "…but says what it WOULD have done" "$REC" '"observed"'
has "…naming the policy" "$REC" "e2e-cloud-guard"
has "…and the verdict it discarded" "$REC" '"decision":"deny"'

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 6 — the activity reaches the server"

ch() { curl -s -m 15 "http://localhost:8123/" --data-binary "$1"; }

for _ in $(seq 1 20); do
  COUNT=$(ch "select count() from agenteye.events where session_id = 'e2e-sess'" | tr -d ' \n')
  [ "${COUNT:-0}" -gt 0 ] && break
  sleep 2
done
[ "${COUNT:-0}" -gt 0 ] && ok "hook activity reached the server ($COUNT events)" \
  || bad "hook activity reached the server" "0 events after 40s"

PAY=$(ch "select payload from agenteye.events where session_id = 'e2e-sess' and payload like '%observed%' limit 1")
has "…and the observe verdict travelled with it" "$PAY" "failproofai_observed"
has "…naming the cloud policy" "$PAY" "e2e-cloud-guard"
has "…the verdict it would have returned" "$PAY" '"decision":"deny"'
has "…while the action itself was allowed" "$PAY" '"outcome":"allow"'
has "…stamped with this machine" "$PAY" '"machine_id":"e2e-machine"'
has "…and the deployment it enforced from" "$PAY" '"cloud_deployment"'

DENIED=$(ch "select payload from agenteye.events where session_id = 'e2e-sess' and payload like '%\"outcome\":\"deny\"%' limit 1")
has "the ENFORCE-mode denial also reached the server" "$DENIED" "e2e-cloud-guard"

printf '\n\033[1m═══ %s passed, %s failed ═══\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
