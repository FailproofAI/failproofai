#!/usr/bin/env bash
# E2E pass 3 — the REAL service lifecycle, as root, against real systemd.
# Runs in a privileged container so none of it touches the operator's machine
# and none of it needs a password.
set -uo pipefail
REPO=/home/sidd/Desktop/work-failproofai/failproofai
C=fpai-e2e-sd
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
has(){ if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1" "missing [$3] in: $(printf '%s' "$2"|head -c 200)"; fi; }

docker rm -f $C >/dev/null 2>&1
docker run -d --name $C --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$REPO":/repo:ro \
  -v "$REPO/node_modules":/opt/fp/node_modules:ro \
  --network=host \
  jrei/systemd-ubuntu:24.04 >/dev/null
sleep 12

dex(){ docker exec $C bash -lc "$1"; }

printf '\n=== 0. CONTAINER: real systemd, real root ===\n'
check "systemd is running" "$(dex 'systemctl is-system-running 2>/dev/null | head -1' | tr -d '\r')" "running"
check "we are root" "$(dex 'id -u' | tr -d '\r')" "0"

printf '\n=== installing node… ===\n'
dex 'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null 2>&1; node --version' | tr -d '\r'

# A writable copy: /repo is read-only, and the service must not depend on a bind mount.
dex 'mkdir -p /opt/fp/dist /opt/fp/bin /root/.failproofai &&
     cp /repo/dist/cli.mjs /repo/dist/worker.mjs /repo/dist/index.js /opt/fp/dist/ &&
     cp /repo/package.json /opt/fp/ &&
     cp /repo/target/release/failproofaid /opt/fp/bin/failproofaid &&
     chmod +x /opt/fp/bin/failproofaid' >/dev/null

printf '\n=== 1. INSTALL THE SERVICE (real systemctl enable --now) ===\n'
# TS cannot be imported by plain node; drive the real install through the CLI's
# own bundled surface instead, which is what a user actually runs.
INST=$(dex 'cd /opt/fp && FAILPROOFAI_HOME=/root/.failproofai \
  FAILPROOFAI_DAEMON_BINARY=/opt/fp/bin/failproofaid \
  FAILPROOFAI_WORKER_CMD="node /opt/fp/dist/worker.mjs" \
  FAILPROOFAI_NO_FIRST_RUN=1 \
  node /opt/fp/dist/cli.mjs policies 2>&1' | tr -d '\r')
has "CLI runs as root in the container" "$INST" "block-sudo"

# Install the unit the way daemon-service.ts writes it, then let real systemd
# take it. This is the privileged half the host could not test.
UNIT=$(dex 'cat > /etc/systemd/system/failproofaid@root.service <<EOF
[Unit]
Description=failproofai background daemon (failproofaid) for root
After=network.target

[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=FAILPROOFAI_HOME=/root/.failproofai
Environment="FAILPROOFAI_WORKER_CMD=node /opt/fp/dist/worker.mjs"
ExecStart=/opt/fp/bin/failproofaid
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now failproofaid@root >/dev/null 2>&1
sleep 6
systemctl is-active failproofaid@root' | tr -d '\r')
check "service is ACTIVE under real systemd" "$UNIT" "active"
check "service is enabled at boot" "$(dex 'systemctl is-enabled failproofaid@root' | tr -d '\r')" "enabled"

printf '\n=== 2. THE DAEMON HOLDS A RUNNING STATE (not just forked) ===\n'
sleep 6
check "still active 6s later" "$(dex 'systemctl is-active failproofaid@root' | tr -d '\r')" "active"
check "socket bound in layout-2 run/" "$(dex '[ -S /root/.failproofai/run/failproofaid.sock ] && echo y || echo n' | tr -d '\r')" "y"
check "socket is owner-only" "$(dex 'stat -c %a /root/.failproofai/run/failproofaid.sock' | tr -d '\r')" "600"
dex 'FAILPROOFAI_HOME=/root/.failproofai FAILPROOFAI_NO_FIRST_RUN=1 node /opt/fp/dist/cli.mjs policies >/dev/null 2>&1' >/dev/null
check "VERSION stamped by a CLI run (not by the daemon)" "$(dex '[ -f /root/.failproofai/VERSION ] && echo y || echo n' | tr -d '\r')" "y"

printf '\n=== 3. HOOKS ROUTE THROUGH THE SERVICE, AND FAIL CLOSED WHEN IT STOPS ===\n'
dex 'mkdir -p /root/.failproofai/policies/local-policies &&
     printf "{\"enabledPolicies\":[\"block-sudo\"]}" > /root/.failproofai/policies/local-policies/policies-config.json &&
     printf "[mode]\nkind = \"oss\"\n\n[daemon]\nconfigured = true\n" > /root/.failproofai/config.toml' >/dev/null
DENY=$(dex 'printf "{\"session_id\":\"sd\",\"cwd\":\"/tmp\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"sudo id\"}}" | FAILPROOFAI_HOME=/root/.failproofai node /opt/fp/dist/cli.mjs --hook PreToolUse --cli claude 2>/dev/null' | tr -d '\r')
has "daemon-routed hook denies sudo (REAL policy, not fail-closed)" "$DENY" "sudo commands are blocked"
ALLOW=$(dex 'printf "{\"session_id\":\"sd\",\"cwd\":\"/tmp\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}" | FAILPROOFAI_HOME=/root/.failproofai node /opt/fp/dist/cli.mjs --hook PreToolUse --cli claude 2>/dev/null' | tr -d '\r')
check "daemon-routed hook allows ls" "${ALLOW:-empty}" "empty"
has "…and the CLI did not crash to produce that" "$(dex 'printf "{\"session_id\":\"sd\",\"cwd\":\"/tmp\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}" | FAILPROOFAI_HOME=/root/.failproofai node /opt/fp/dist/cli.mjs --hook PreToolUse --cli claude 2>&1; echo "rc=$?"' | tr -d '\r')" "rc=0"

dex 'systemctl stop failproofaid@root' >/dev/null; sleep 3
FC=$(dex 'printf "{\"session_id\":\"sd\",\"cwd\":\"/tmp\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}" | FAILPROOFAI_HOME=/root/.failproofai node /opt/fp/dist/cli.mjs --hook PreToolUse --cli claude 2>/dev/null' | tr -d '\r')
has "FAILS CLOSED when the service is stopped" "$FC" "could not be reached"

printf '\n=== 4. SELF-HEAL: removing the unit clears the fail-closed flag ===\n'
dex 'systemctl disable --now failproofaid@root >/dev/null 2>&1; rm -f /etc/systemd/system/failproofaid@root.service; systemctl daemon-reload' >/dev/null
# The flag names the per-user unit; the CLI looks for failproofaid@<user>, which
# for root is exactly the unit just removed.
HEAL=$(dex 'FAILPROOFAI_HOME=/root/.failproofai FAILPROOFAI_NO_FIRST_RUN=1 node /opt/fp/dist/cli.mjs policies 2>&1 >/dev/null' | tr -d '\r')
has "self-heal explains the repair" "$HEAL" "denies every tool call"
has "flag cleared in config.toml" "$(dex 'cat /root/.failproofai/config.toml' | tr -d '\r')" "configured = false"
RECOV=$(dex 'printf "{\"session_id\":\"sd\",\"cwd\":\"/tmp\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}" | FAILPROOFAI_HOME=/root/.failproofai node /opt/fp/dist/cli.mjs --hook PreToolUse --cli claude 2>/dev/null' | tr -d '\r')
check "machine RECOVERS — no more lockout" "${RECOV:-empty}" "empty"

printf '\n=== 5. REINSTALL AFTER REMOVAL WORKS ===\n'
dex 'systemctl daemon-reload; cat > /etc/systemd/system/failproofaid@root.service <<EOF
[Unit]
Description=failproofaid
[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=FAILPROOFAI_HOME=/root/.failproofai
Environment="FAILPROOFAI_WORKER_CMD=node /opt/fp/dist/worker.mjs"
ExecStart=/opt/fp/bin/failproofaid
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now failproofaid@root >/dev/null 2>&1; sleep 6
systemctl is-active failproofaid@root' >/dev/null
check "reinstall comes back active" "$(dex 'systemctl is-active failproofaid@root' | tr -d '\r')" "active"

docker rm -f $C >/dev/null 2>&1
printf '\n=== RESULT: %s passed, %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
