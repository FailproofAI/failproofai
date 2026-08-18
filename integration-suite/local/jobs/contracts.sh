#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The contracts lab (CANARY_JOB=contracts), invoked by the runner image's baked
# entrypoint AFTER it has locked, cloned and checked out $CANARY_REF into
# $CANARY_WORK/clone-contracts.
#
# It answers the question the canary cannot: not "is enforcement working" — that
# needs a deny, and a vendor that ignores our config produces no evidence at all
# — but "does this vendor still accept the config we install, and can we still
# read what it sends". The output is a pack: one file describing every CLI's
# live hook contract, shaped exactly like the observation table a customer's own
# machine keeps, so one comparator reads both.
#
# Like the other jobs it lives IN THE REPO rather than the image: adding or
# changing a job is a checkout away, and nobody rebuilds the boss's image for it.
#
# WHY IT RUNS AT ALL, given the canary already probes twelve CLIs daily: the
# canary is version-gated and verdict-shaped. It tells us a CLI went red; it does
# not tell us WHAT the vendor changed, and its green does not mean our payload
# maps are intact — a CLI can pass an enforcement probe on Bash while a renamed
# file-tool key has quietly made every path policy inert.
# ─────────────────────────────────────────────────────────────────────────────
set -u

WORK="${CANARY_WORK:?CANARY_WORK missing — runner-entrypoint.sh sets it}"
CLONE="${CANARY_CLONE:-$WORK/clone-contracts}"
LOGS="$WORK/logs"
OUT="$WORK/contracts"
mkdir -p "$LOGS" "$OUT"
JOB_TIMEOUT="${CONTRACTS_TIMEOUT:-5400}"

export CANARY_CARGO_CACHE="${CANARY_CARGO_CACHE:-$WORK/cargo}"

# Like the canary, this job drives the HOST's docker — the sandbox image and one
# probe container per CLI are siblings. Asserted here, where it is true, and
# BEFORE an hour of setup rather than at the first container.
[ -S /var/run/docker.sock ] || {
  echo "✗ the contracts lab drives the host's docker and the socket is not mounted." >&2
  echo "  Add:  -v /var/run/docker.sock:/var/run/docker.sock" >&2
  exit 1; }
docker info >/dev/null 2>&1 || {
  echo "✗ the docker socket is mounted but the daemon does not answer." >&2; exit 1; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
FP_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"
LOG="$LOGS/contracts-$TS.log"
PACK="$OUT/pack.json"
echo "── contracts run $TS: ${CANARY_REF:-?} @ $FP_SHA ──"

slack_note() { # $1 = text; best-effort, never fails the run
  [ -n "${CANARY_SLACK_WEBHOOK:-}" ] || return 0
  local payload
  payload="$(printf '%s' "$1" | node -e 'const t=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify({text:t}))')"
  curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -X POST \
    -H 'Content-type: application/json' --data "$payload" "$CANARY_SLACK_WEBHOOK" 2>/dev/null || true
}

# A candidate template to prove, if an operator left one. Dropped at a known
# path rather than passed as a flag, because cron lines are rewritten by the
# installer and a one-off argument would not survive the next install.
CANDIDATES="${CONTRACTS_TEMPLATE:-$WORK/candidates.json}"
if [ -f "$CANDIDATES" ]; then
  export CONTRACTS_TEMPLATE="$CANDIDATES"
  echo "── proving candidate templates from $CANDIDATES ──"
else
  unset CONTRACTS_TEMPLATE
fi

# The daemon is mandatory: `recordHookShape` has one call site, in the warm
# worker, so an in-process run would probe every CLI and publish an empty pack.
GITHUB_WORKSPACE="$CLONE" \
CANARY_RUNNER="contracts-runner.sh" \
CANARY_CHANNEL="stable" \
CANARY_DAEMON=1 \
CANARY_FP_SHA="$FP_SHA" \
CONTRACTS_OUT_DIR="$OUT" \
CONTRACTS_PACK="$PACK" \
CONTRACTS_TEMPLATE="${CONTRACTS_TEMPLATE:-}" \
  timeout -k 60 "$JOB_TIMEOUT" bash "$CLONE/integration-suite/ci-entrypoint.sh" 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}

# ── Report ───────────────────────────────────────────────────────────────────
# The exit code carries the meaning (contracts-pack.mjs owns it):
#   0  every probe that ran reached OK and nothing we read has moved
#   1  a vendor moved — either a DRIFT verdict or a high-severity finding
#   2  the run could not be trusted: nothing was exercised, or a probe errored
summary="$(grep -E '^(probes:|  \[|[0-9]+ high-severity|translation:|NOTHING REACHED OK)' "$LOG" | tail -25)"
case "$rc" in
  0) icon="✅"; head="contracts: nothing moved" ;;
  1) icon="🚨"; head="contracts: A VENDOR MOVED — a pack update and probably a release are needed" ;;
  *) icon="🔥"; head="contracts: the run could not be trusted (rc=$rc)" ;;
esac
slack_note "$icon $head — ${CANARY_REF:-?} @ $FP_SHA
\`\`\`
${summary:-no summary in the log — see $LOG}
\`\`\`"

# ── Publish ──────────────────────────────────────────────────────────────────
# The pack goes to its own public repo, whose releases the daemon can pull the
# same way it pulls failproofaid when npm did not deliver it. Deliberately
# skipped unless BOTH are configured, and never on an untrustworthy run: a pack
# assembled from a run that exercised nothing would overwrite a good one with
# silence, which is worse than publishing nothing.
if [ -n "${CONTRACTS_REPO:-}" ] && [ -n "${CONTRACTS_TOKEN:-}" ] && [ "$rc" -lt 2 ]; then
  if [ -s "$PACK" ]; then
    echo "── publishing pack to $CONTRACTS_REPO ──"
    bash "$CLONE/integration-suite/contracts-publish.sh" "$PACK" 2>&1 | tee -a "$LOG" \
      || slack_note "⚠️ contracts: the pack was built but could not be published — see $LOG"
  else
    slack_note "⚠️ contracts: rc=$rc but no pack at $PACK — nothing published"
  fi
else
  echo "── publish skipped (CONTRACTS_REPO / CONTRACTS_TOKEN not both set, or untrusted run) ──"
fi

# Promotion is deliberately NOT done here. `contracts-promote.sh` asks whether a
# machine that runs these CLIs for real agrees with what the lab recorded, and
# running it on this box would compare the lab's run against the lab's own
# leftovers — always agreeing, which is worse than not checking at all. It
# belongs on a working machine, on its own schedule.

echo "── done (rc=$rc) ──"
exit "$rc"
