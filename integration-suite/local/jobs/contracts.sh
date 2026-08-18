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
# It runs from the CANARY image rather than one of its own: it needs exactly what
# that image has — the baked checkout, the docker client, and a compiled
# failproofaid — and a fourth near-identical image is a fourth thing to build,
# publish and keep in step. `CANARY_JOB=contracts` selects this script out of the
# same baked tree.
#
# WHY IT RUNS AT ALL, given the canary already probes twelve CLIs daily: the
# canary is version-gated and verdict-shaped. It tells us a CLI went red; it does
# not tell us WHAT the vendor changed, and its green does not mean our payload
# maps are intact — a CLI can pass an enforcement probe on Bash while a renamed
# file-tool key has quietly made every path policy inert.
# ─────────────────────────────────────────────────────────────────────────────
set -u

WORK="${CANARY_WORK:?CANARY_WORK missing — job-entrypoint.sh sets it}"
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
# The image is the commit, so the SHA comes from the baked value the entrypoint
# exported. The git fallback keeps this working when the job is run by hand from
# a real checkout, which is how it is developed.
FP_SHA="${CANARY_FP_SHA:-$(git -C "$CLONE" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
LOG="$LOGS/contracts-$TS.log"
PACK="$OUT/pack.json"
echo "── contracts run $TS: ${CANARY_REF:-?} @ $FP_SHA ──"

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
