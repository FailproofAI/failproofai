#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# failproofai contracts lab — orchestrator. The sibling of run.sh: same setup,
# a different question.
#
#   run.sh            "is enforcement working" — needs a deny to observe
#   contracts-runner  "does the vendor still accept our config, and can we still
#                      read what it sends" — needs only a tool call
#
# ci-entrypoint.sh has already built failproofai and failproofaid, built the
# sandbox image, created the volume, installed the CLIs @latest, injected the
# OAuth tokens and written the gateway env-file. This selects the probe and
# assembles the pack; nothing above that line differs, which is why the two
# runners share an entrypoint rather than copying an hour of setup.
#
# THE DAEMON IS NOT OPTIONAL HERE. `recordHookShape` has exactly one call site,
# in worker-server.ts, so the in-process path records nothing at all — a run
# without the daemon would probe twelve CLIs and produce an empty pack that
# looks like twelve silent vendors.
#
# There is deliberately NO version gating. The canary skips a CLI whose version
# has not moved because a probe costs LLM credits and the answer cannot have
# changed. The opposite is true here: a vendor version that has not moved is
# exactly the case where we want yesterday's answer confirmed, and the whole
# artifact is a description of the CURRENT contract. A gated run would publish a
# pack whose entries silently date from different weeks.
# ─────────────────────────────────────────────────────────────────────────────
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

REPO="${CANARY_REPO:?CANARY_REPO (built failproofai checkout) required}"
SANDBOX="${CANARY_SANDBOX:-$HERE}"
VOL="${CANARY_VOL:-integration-suite}"
IMAGE="${CANARY_IMAGE:-failproofai-integration-suite:base}"
ENVFILE="${CANARY_ENVFILE:?CANARY_ENVFILE (docker --env-file with gateway creds) required}"
OUT="${CONTRACTS_OUT_DIR:-${CANARY_WORK:-$HERE}/contracts}"
PACK="${CONTRACTS_PACK:-$OUT/pack.json}"

DBIN="${CANARY_DAEMON_BIN:?contracts-runner requires CANARY_DAEMON_BIN — only the warm worker records payload shapes}"
[ -x "$DBIN" ] || { echo "✗ CANARY_DAEMON_BIN=$DBIN is not executable" >&2; exit 2; }
# docker reads a relative -v source as a NAMED VOLUME — absolutize first.
DBIN="$(cd "$(dirname "$DBIN")" && pwd)/$(basename "$DBIN")"

CLIS=("$@")
if [ ${#CLIS[@]} -eq 0 ]; then
  CLIS=(claude codex copilot cursor factory devin antigravity goose opencode pi hermes openclaw)
fi

mkdir -p "$OUT"
rm -f "$OUT"/*.json
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"

echo "── contracts lab: ${#CLIS[@]} CLI(s) ──"

for cli in "${CLIS[@]}"; do
  line="$(docker run --rm --env-file "$ENVFILE" \
      -v "$DBIN:/opt/failproofaid/failproofaid:ro" \
      -v "$REPO:/repo:ro" -v "$SANDBOX:/opt/canary:ro" -v "$VOL:/home/canary" \
      "$IMAGE" bash /opt/canary/contracts-probe.sh "$cli" 2>/dev/null \
      | grep '^CONTRACTS_JSON ' | tail -1)"

  # The probe's exit trap emits a line even when it dies, so an empty one means
  # the CONTAINER never got far enough to run it. Saying so beats a silently
  # missing CLI, which reads as a shorter run rather than a broken one.
  if [ -z "$line" ]; then
    line="CONTRACTS_JSON {\"cli\":\"$cli\",\"verdict\":\"ERROR\",\"note\":\"the probe container produced no verdict\",\"events\":[]}"
  fi
  echo "$line" | tee -a "$SUMMARY"

  # Lift this CLI's table out of the volume before the next probe overwrites it.
  docker run --rm -v "$VOL:/home/canary" "$IMAGE" \
    cat "/home/canary/contracts-out/$cli.json" > "$OUT/$cli.json" 2>/dev/null \
    || rm -f "$OUT/$cli.json"
done

echo
exec bun "$REPO/integration-suite/contracts-pack.mjs" \
  --in "$OUT" --summary "$SUMMARY" --out "$PACK" --repo "$REPO"
