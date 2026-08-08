#!/usr/bin/env bash
# E2E pass 1 — layout, reset, OSS gating, collector, all against a throwaway
# HOME on the host. No root, nothing touching the operator's real state.
set -uo pipefail
# Repo root, derived from this script's own location: these live at
# <repo>/__tests__/e2e/layout/. It was hardcoded to one contributor's home
# directory, so the suite ran on exactly one machine and silently used the
# wrong CLI (or none) on every other.
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
CLI="node $REPO/dist/cli.mjs"
H=/tmp/fpai-e2e
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
has()  { if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1" "missing [$3] in: $(printf '%s' "$2" | head -c 160)"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q "$3"; then bad "$1" "unexpected [$3]"; else ok "$1"; fi; }

rm -rf "$H"; mkdir -p "$H/proj"
export FAILPROOFAI_HOME="$H/home"
export FAILPROOFAI_NO_FIRST_RUN=1   # the wizard needs a TTY; tested separately

printf '\n=== 1. FRESH HOME: VERSION stamped, nothing else invented ===\n'
$CLI policies >/dev/null 2>&1
check "VERSION exists" "$([ -f "$H/home/VERSION" ] && echo y || echo n)" "y"
has "layout recorded" "$(cat "$H/home/VERSION" 2>/dev/null)" '"layout": 3'
check "no credentials on a fresh home" "$([ -f "$H/home/credentials.json" ] && echo y || echo n)" "n"

printf '\n=== 2. OSS MODE IS THE DEFAULT AND IS SILENT ===\n'
OUT=$($CLI config --status 2>&1)
hasnt "status does not claim a connection" "$OUT" "Connected to"

printf '\n=== 3. HOOKS WRITE TO THE NEW LAYOUT ===\n'
# Layout 3 keeps the global policy config at the home ROOT. It was written to
# policies/local-policies/ here, which layout 3 never reads — so the policy did
# not fire and this asserted nothing about enforcement.
printf '{"enabledPolicies":["block-sudo"]}' > "$H/home/policies-config.json"
DENY=$(printf '{"session_id":"e2e","cwd":"%s/proj","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sudo rm -rf /"}}' "$H" | $CLI --hook PreToolUse --cli claude 2>/dev/null)
has "global policy at the home root fires" "$DENY" '"permissionDecision":"deny"'
check "hook-activity is top-level, not under cache/" "$([ -d "$H/home/hook-activity" ] && echo y || echo n)" "y"
check "no cache/ dir is recreated" "$([ -d "$H/home/cache" ] && echo y || echo n)" "n"

printf '\n=== 4. ALLOW STILL ALLOWS ===\n'
ALLOW=$(printf '{"session_id":"e2e","cwd":"%s/proj","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la"}}' "$H" | $CLI --hook PreToolUse --cli claude 2>/dev/null)
check "harmless command allowed" "${ALLOW:-empty}" "empty"

printf '\n=== 5. STALE LAYOUT: hook warns HONESTLY, deletes nothing, never denies ===\n'
S="$H/stale"; mkdir -p "$S/cache/hook-activity"
printf '{"enabledPolicies":["block-sudo"]}' > "$S/policies-config.json"
printf '{"url":"https://x","key":"k"}' > "$S/ingest.json"
echo '{}' > "$S/cache/hook-activity/current.jsonl"
WARN=$(printf '{"session_id":"e2e","cwd":"%s/proj","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' "$H" | FAILPROOFAI_HOME="$S" FAILPROOFAI_HOOK_DEBUG=1 $CLI --hook PreToolUse --cli claude 2>&1 >/dev/null)
# A layout-1 home keeps its policy config at the home ROOT, which is exactly
# where layout 3 reads it — so these policies ARE enforced, and the hook must
# NOT claim otherwise. It used to print "global policies are NOT being enforced"
# on every tool call while denying on the very same call.
hasnt "hook does not claim unenforced while enforcing" "$WARN" "NOT being enforced"

# The layout where the claim is TRUE: layout 2 nested the config where layout 3
# never looks, so nothing loads it and the warning has to fire.
S2="$H/stale2"; mkdir -p "$S2/policies/local-policies"
printf 'mode = "oss"\n' > "$S2/config.toml"
printf '{"enabledPolicies":["block-sudo"]}' > "$S2/policies/local-policies/policies-config.json"
WARN2=$(printf '{"session_id":"e2e","cwd":"%s/proj","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' "$H" | FAILPROOFAI_HOME="$S2" FAILPROOFAI_HOOK_DEBUG=1 $CLI --hook PreToolUse --cli claude 2>&1 >/dev/null)
has "hook DOES warn when the config is where nothing reads it" "$WARN2" "NOT being enforced"
check "hook deleted nothing" "$([ -f "$S/policies-config.json" ] && echo y || echo n)" "y"
RC=$(printf '{"session_id":"e2e","cwd":"%s/proj","hook_event_name":"UserPromptSubmit","prompt":"hi"}' "$H" | FAILPROOFAI_HOME="$S" $CLI --hook UserPromptSubmit --cli claude >/dev/null 2>&1; echo $?)
check "UserPromptSubmit is NOT denied (no lockout)" "$RC" "0"

printf '\n=== 6. STALE LAYOUT: a CLI command resets it, visibly ===\n'
RESET=$(FAILPROOFAI_HOME="$S" $CLI policies 2>&1 >/dev/null)
has "reset explains itself" "$RESET" "reorganised"
has "reset points at config" "$RESET" "failproofai config"
# NOT removed — layout 3 puts the CURRENT config at layout 1's path, and the
# reset carries the user's selection into it rather than discarding it. The
# meaningful assertion is that the selection survived the upgrade.
check "policy config still present at the layout-3 path" "$([ -f "$S/policies-config.json" ] && echo y || echo n)" "y"
has "…and the user's selection was carried, not reset to defaults" "$(cat "$S/policies-config.json")" "block-sudo"
check "old ingest credential removed" "$([ -f "$S/ingest.json" ] && echo y || echo n)" "n"
# cache/ CONTAINS layout 1's decision log, which is carried rather than deleted,
# so its children go individually and the parent may remain. Asserting the
# parent was gone would have required deleting the one thing nothing regenerates.
check "old audit cache removed" "$([ -d "$S/cache/audit" ] && echo y || echo n)" "n"
check "decision log carried out of cache/" "$([ -f "$S/hook-activity/current.jsonl" ] && echo y || echo n)" "y"
has "VERSION now current" "$(cat "$S/VERSION" 2>/dev/null)" '"layout": 3'
AGAIN=$(FAILPROOFAI_HOME="$S" $CLI policies 2>&1 >/dev/null)
hasnt "second run does not re-announce a reset" "$AGAIN" "reorganised"

printf '\n=== 7. FUTURE LAYOUT: refused, never deleted ===\n'
F="$H/future"; mkdir -p "$F"
printf '{"layout":99,"cli":"9.9.9"}\n' > "$F/VERSION"
printf '{"mode":{"kind":"cloud"}}\n' > "$F/config.json"
FUT=$(FAILPROOFAI_HOME="$F" $CLI policies 2>&1 >/dev/null); FRC=$?
has "refuses a newer layout" "$FUT" "newer version"
check "exits nonzero" "$FRC" "1"
check "future config NOT deleted" "$([ -f "$F/config.json" ] && echo y || echo n)" "y"

printf '\n=== 8. BINARY AND SOCKETS SURVIVE A RESET ===\n'
S2="$H/stale2"; mkdir -p "$S2/bin" "$S2/run" "$S2/cache"
echo ELF > "$S2/bin/failproofaid-1.0.0"; echo "" > "$S2/run/failproofaid.lock"
printf '{"enabledPolicies":[]}' > "$S2/policies-config.json"
FAILPROOFAI_HOME="$S2" $CLI policies >/dev/null 2>&1
check "daemon binary kept (avoids a needless refetch)" "$([ -f "$S2/bin/failproofaid-1.0.0" ] && echo y || echo n)" "y"
check "run/ kept (may belong to a live daemon)" "$([ -f "$S2/run/failproofaid.lock" ] && echo y || echo n)" "y"

printf '\n=== 9. CREDENTIALS ARE OWNER-ONLY, AND CONFIG NEVER HOLDS A TOKEN ===\n'
node -e '
process.env.FAILPROOFAI_HOME = process.argv[1];
const { writeCredentials } = require("'$REPO'/dist/index.js");
' 2>/dev/null || true
FAILPROOFAI_HOME="$H/home" node -e '
const {writeCredentials}=require("'"$REPO"'/src/hooks/fp-config.ts");
' 2>/dev/null || true
# Use the CLI surface instead: --connect writes both files.
CONN=$(FAILPROOFAI_HOME="$H/home" $CLI config --connect http://127.0.0.1:9 --token TOPSECRETKEY123 2>&1); :
if [ -f "$H/home/credentials.json" ]; then
  MODE=$(stat -c '%a' "$H/home/credentials.json")
  check "credentials.json is 0600" "$MODE" "600"
  hasnt "config.json never holds the token" "$(cat "$H/home/config.json" 2>/dev/null)" "TOPSECRETKEY123"
else
  ok "no credential written for an unreachable endpoint (verify-before-write)"
  hasnt "mode stayed oss on a failed connect" "$(cat "$H/home/config.json" 2>/dev/null)" '"kind": "cloud"'
fi

printf '\n=== RESULT: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
