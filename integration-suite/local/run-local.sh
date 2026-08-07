#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# failproofai integration suite — LOCAL front door (runs on the canary box).
#
# The GHA cron's replacement: a systemd user timer (failproofai-canary.timer)
# fires this daily. It plays exactly the role the workflow YAML played — thin
# trigger: checkout, secrets → env, state paths, leg fan-out — then hands each
# leg to integration-suite/ci-entrypoint.sh FROM THE CHECKED-OUT REF, same as
# CI. Runs from an INSTALLED copy (install.sh puts it under
# ~/.config/failproofai-canary/bin), never from inside the clone it resets.
#
# Layout (each overridable via env of the same name):
#   ~/.config/failproofai-canary/secrets.env   credentials + box config (0600)
#   ~/.local/state/failproofai-canary/         state JSONs, logs, tmp
#   ~/canary/failproofai                       runner clone (NEVER a dev tree —
#                                              this script hard-resets it)
#
# Report delivery is unchanged (run.sh POSTs verdicts to CANARY_SLACK_WEBHOOK).
# What GHA gave for free — a notification when the JOB ITSELF died — is the
# crash-guard below: a leg that exits non-zero WITHOUT having posted its report
# gets a short Slack note carrying the log tail.
# ─────────────────────────────────────────────────────────────────────────────
set -u

CONF_DIR="${CANARY_CONF_DIR:-$HOME/.config/failproofai-canary}"
STATE_DIR="${CANARY_STATE_DIR:-$HOME/.local/state/failproofai-canary}"
SECRETS="${CANARY_SECRETS:-$CONF_DIR/secrets.env}"
mkdir -p "$STATE_DIR/logs" "$STATE_DIR/tmp"

[ -f "$SECRETS" ] || { echo "✗ $SECRETS missing — run integration-suite/local/install.sh, then fill it in" >&2; exit 1; }
perms="$(stat -c %a "$SECRETS" 2>/dev/null || stat -f %Lp "$SECRETS" 2>/dev/null)"
[ "$perms" = 600 ] || { echo "✗ $SECRETS must be chmod 600 (is $perms) — it holds credentials" >&2; exit 1; }
set -a; . "$SECRETS"; set +a

# Required, no default ON PURPOSE: a baked-in default ref would silently keep
# probing a stale branch after the daemon branch merges to main. Every box
# states what it tests.
: "${CANARY_REF:?CANARY_REF unset — set it in $SECRETS (origin/failproofaid until #632 merges, then origin/main)}"
CLONE="${CANARY_CLONE:-$HOME/canary/failproofai}"
GIT_URL="${CANARY_GIT_URL:-https://github.com/FailproofAI/failproofai.git}"
LEG_TIMEOUT="${CANARY_LEG_TIMEOUT:-5400}"   # per leg, seconds — mirrors GHA's 90-min job timeout

# One run at a time — the local stand-in for GHA's `concurrency` group. A
# still-running yesterday (hung vendor CLI) must not race today's volume.
exec 9>"$STATE_DIR/.lock"
flock -n 9 || { echo "another canary run holds $STATE_DIR/.lock — exiting" >&2; exit 0; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"

slack_note() { # $1 = text; best-effort, never fails the run
  [ -n "${CANARY_SLACK_WEBHOOK:-}" ] || return 0
  local payload
  payload="$(printf '%s' "$1" | node -e 'const t=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify({text:t}))')"
  curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -X POST \
    -H 'Content-type: application/json' --data "$payload" "$CANARY_SLACK_WEBHOOK" 2>/dev/null || true
}

# ── checkout the ref under test ──────────────────────────────────────────────
if [ ! -d "$CLONE/.git" ]; then
  git clone "$GIT_URL" "$CLONE" || { slack_note "🔥 canary box: clone of $GIT_URL failed — no run"; exit 1; }
fi
git -C "$CLONE" fetch --prune origin \
  || { slack_note "🔥 canary box: git fetch failed — no run today"; exit 1; }
{ git -C "$CLONE" checkout --detach --force "$CANARY_REF" && git -C "$CLONE" reset --hard "$CANARY_REF"; } \
  || { slack_note "🔥 canary box: checkout of $CANARY_REF failed — no run"; exit 1; }
FP_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"
echo "── canary run $TS: $CANARY_REF @ $FP_SHA ──"

# ── legs (the same two the GHA matrix ran; sequential on one Docker host) ────
run_leg() { # $1 = channel
  local channel="$1" leg_log="$STATE_DIR/logs/leg-$1-$TS.log" rc daemon state peer
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
  CANARY_ENVFILE="$STATE_DIR/tmp/canary-$channel.env" \
  CANARY_TOKENS_DIR="$STATE_DIR/tmp/tokens-$channel" \
    timeout -k 60 "$LEG_TIMEOUT" bash "$CLONE/integration-suite/ci-entrypoint.sh" 2>&1 | tee "$leg_log"
  rc=${PIPESTATUS[0]}
  # Crash-guard. Non-zero WITH a posted report is a verdict (FAIL — Slack
  # already carries the story); non-zero WITHOUT one means the harness died
  # before reporting, which on GHA surfaced as a red-job email and here would
  # otherwise be silence.
  if [ "$rc" -ne 0 ] && ! grep -q "posted to Slack webhook" "$leg_log"; then
    slack_note "🔥 canary box: $channel leg died (rc=$rc) before reporting — $CANARY_REF @ $FP_SHA
\`\`\`
$(tail -12 "$leg_log")
\`\`\`"
  fi
  return "$rc"
}

rc_stable=0; rc_beta=0
run_leg stable || rc_stable=$?
run_leg beta   || rc_beta=$?

find "$STATE_DIR/logs" -name '*.log' -mtime +14 -delete 2>/dev/null || true

echo "── done: stable rc=$rc_stable, beta rc=$rc_beta ──"
[ "$rc_stable" -eq 0 ] && [ "$rc_beta" -eq 0 ]
