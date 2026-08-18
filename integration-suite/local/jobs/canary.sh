#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The integration-suite job (CANARY_JOB=canary), invoked by the canary image's
# baked entrypoint AFTER it has locked and reported which commit the image
# carries. The checkout is baked in at $CANARY_CLONE rather than cloned. It plays
# the role the GHA workflow YAML played — env → state paths → leg fan-out —
# then hands each leg to ci-entrypoint.sh, exactly as CI does.
#
# It lives IN THE REPO (not baked into the image) on purpose: the leg logic
# evolves with the harness, and the box picks changes up through the checkout —
# nobody rebuilds the boss's image for a harness tweak.
#
# Report delivery is unchanged (run.sh POSTs verdicts to CANARY_SLACK_WEBHOOK).
# What GHA gave for free — a notification when the JOB ITSELF died — is the
# crash-guard below: a leg that exits non-zero WITHOUT having posted its report
# gets a short Slack note carrying the log tail.
# ─────────────────────────────────────────────────────────────────────────────
set -u

WORK="${CANARY_WORK:?CANARY_WORK missing — job-entrypoint.sh sets it}"
CLONE="${CANARY_CLONE:-$WORK/clone-canary}"
STATE_DIR="$WORK/state"
LOGS="$WORK/logs"
mkdir -p "$STATE_DIR" "$LOGS"
LEG_TIMEOUT="${CANARY_LEG_TIMEOUT:-5400}"   # per leg, seconds — mirrors GHA's 90-min job timeout

# Everything a SIBLING container mounts must live under $WORK — the one dir
# shared with the host at an identical path. The daemon build's cargo cache is
# the only harness default rooted elsewhere ($HOME), so pin it here.
export CANARY_CARGO_CACHE="${CANARY_CARGO_CACHE:-$WORK/cargo}"

# This is the one job that drives the HOST's docker — it builds the sandbox
# image and runs the 12 probe containers as siblings. The entrypoint no longer
# demands a socket on every job's behalf (two of three never spawn anything),
# so the requirement is asserted here, where it is true, and BEFORE an hour of
# setup rather than at the first sibling container.
[ -S /var/run/docker.sock ] || {
  echo "✗ the canary drives the host's docker and the socket is not mounted." >&2
  echo "  Add:  -v /var/run/docker.sock:/var/run/docker.sock" >&2
  exit 1; }
docker info >/dev/null 2>&1 || {
  echo "✗ the docker socket is mounted but the daemon does not answer." >&2; exit 1; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
# The image is the commit, so the SHA comes from the baked value the entrypoint
# exported. The git fallback keeps this working when a job is run by hand from a
# real checkout, which is how it is developed.
FP_SHA="${CANARY_FP_SHA:-$(git -C "$CLONE" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
echo "── canary run $TS: ${CANARY_REF:-?} @ $FP_SHA ──"

# ── the baked tree has to reach the SIBLING containers ──────────────────────
# Everything this job spawns is a sibling, not a child: the HOST daemon resolves
# their `-v` sources against the HOST filesystem. The image's checkout lives at
# /opt/failproofai, which exists only inside THIS container — mounting it into a
# probe container silently mounts an empty directory, and the first thing that
# goes wrong is `bash: /opt/canary/install-clis.sh: No such file or directory`.
# (Found exactly that way, running the real job from the built image.)
#
# The work dir is the one path that means the same thing on both sides — that is
# what the identical-path mount is FOR — so the baked tree is materialised there.
# Keyed by the baked SHA and skipped when it already matches, so this is a copy
# once per published image rather than once per run, and still no clone, no
# install and no build. The daemon binary rides along for the same reason: its
# baked path is equally unreachable from a sibling.
if [ -n "${CANARY_BAKED_SHA:-}" ]; then
  HOST_REPO="$WORK/repo"
  if [ "$(cat "$HOST_REPO/.baked-sha" 2>/dev/null || echo none)" != "$FP_SHA" ]; then
    echo "materialising the baked tree at $HOST_REPO (first run of $FP_SHA)"
    rm -rf "$HOST_REPO.tmp"
    cp -a "$CLONE" "$HOST_REPO.tmp" || { echo "✗ could not copy the baked tree" >&2; exit 1; }
    if [ -x "${CANARY_DAEMON_BIN:-}" ]; then
      mkdir -p "$HOST_REPO.tmp/.bin"
      cp -a "$CANARY_DAEMON_BIN" "$HOST_REPO.tmp/.bin/failproofaid"
    fi
    printf '%s\n' "$FP_SHA" > "$HOST_REPO.tmp/.baked-sha"
    rm -rf "$HOST_REPO"; mv "$HOST_REPO.tmp" "$HOST_REPO"
  else
    echo "reusing the materialised tree at $HOST_REPO ($FP_SHA)"
  fi
  CLONE="$HOST_REPO"
  export CANARY_CLONE="$CLONE"
  [ -x "$HOST_REPO/.bin/failproofaid" ] && export CANARY_DAEMON_BIN="$HOST_REPO/.bin/failproofaid"
fi

slack_note() { # $1 = text; best-effort, never fails the run
  [ -n "${CANARY_SLACK_WEBHOOK:-}" ] || return 0
  local payload
  payload="$(printf '%s' "$1" | node -e 'const t=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify({text:t}))')"
  curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -X POST \
    -H 'Content-type: application/json' --data "$payload" "$CANARY_SLACK_WEBHOOK" 2>/dev/null || true
}

run_leg() { # $1 = channel
  local channel="$1" leg_log="$LOGS/leg-$1-$TS.log" rc daemon state peer
  if [ "$channel" = stable ]; then
    # Stable probes the daemon-configured (failproofaid) path — the way-forward
    # configuration users get from `failproofai config`. Beta stays in-process:
    # it answers "is the vendor about to break us", which is independent of our
    # transport, and it keeps the non-daemon path (Windows, opt-outs) covered.
    daemon="${CANARY_DAEMON_STABLE:-1}"
    state="$STATE_DIR/integration-suite-state.json"
    peer=""
  else
    daemon="${CANARY_DAEMON_BETA:-0}"
    state="$STATE_DIR/integration-suite-state-$channel.json"
    peer="$STATE_DIR/integration-suite-state.json"
  fi
  echo "── leg: $channel (daemon=$daemon) ──"
  GITHUB_WORKSPACE="$CLONE" \
  CANARY_CHANNEL="$channel" \
  CANARY_STATE="$state" \
  CANARY_PEER_STATE="$peer" \
  CANARY_FP_SHA="$FP_SHA" \
  CANARY_DAEMON="$daemon" \
    timeout -k 60 "$LEG_TIMEOUT" bash "$CLONE/integration-suite/ci-entrypoint.sh" 2>&1 | tee "$leg_log"
  rc=${PIPESTATUS[0]}
  # Crash-guard. Non-zero WITH a posted report is a verdict (FAIL — Slack
  # already carries the story); non-zero WITHOUT one means the harness died
  # before reporting, which on GHA surfaced as a red-job email and here would
  # otherwise be silence.
  if [ "$rc" -ne 0 ] && ! grep -q "posted to Slack webhook" "$leg_log"; then
    slack_note "🔥 canary box: $channel leg died (rc=$rc) before reporting — ${CANARY_REF:-?} @ $FP_SHA
\`\`\`
$(tail -12 "$leg_log")
\`\`\`"
  fi
  return "$rc"
}

overall=0
for channel in ${CANARY_LEGS:-stable beta}; do
  run_leg "$channel" || overall=1
done

echo "── done (overall rc=$overall) ──"
exit "$overall"
