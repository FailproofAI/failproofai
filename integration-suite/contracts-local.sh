#!/usr/bin/env bash
# Run the contracts probe across every CLI on THIS machine and assemble a pack.
#
# The developer's driver. `contracts-runner.sh` is the box's — same probe, same
# packer, same verdict, but it fans out one container per CLI under
# ci-entrypoint.sh. This one just loops in-process, so a change can be tried
# against a real vendor without the image, the volume or the cron.
#
# The pack is deliberately THE SAME SHAPE as `~/.failproofai/contracts/observed.json`
# — `{clis: {<cli>: {version, hooks}}}` — because then `contract-compare.ts`
# reads a pack captured here and a table captured on a customer's machine with
# no second parser and no second set of bugs. Per-CLI probe metadata rides along
# under `probe`, which the comparator ignores; tolerating unknown fields is a
# property it is tested for, so a newer lab can add to this file without
# breaking an older client.
#
# ── The thing this must never do ─────────────────────────────────────────────
# Report a clean day when it did not test anything. A gateway that rotates model
# names, an expired key, an image missing a CLI — each yields a run where every
# probe is INCONCLUSIVE or ERROR and no vendor was actually exercised. That is
# indistinguishable from twelve healthy CLIs unless somebody checks, so it is
# checked here: a run where nothing reached OK exits non-zero and says so.
set -uo pipefail

REPO_DIR="${CONTRACTS_REPO_DIR:-/repo}"
OUT_DIR="${CONTRACTS_OUT_DIR:-$HOME/contracts-out}"
PACK="${CONTRACTS_PACK:-$OUT_DIR/pack.json}"
PROBE="$REPO_DIR/integration-suite/contracts-probe.sh"

# Every CLI the probe can drive. Override to run a subset.
ALL_CLIS="claude opencode goose hermes pi codex cursor copilot devin antigravity factory openclaw"
CLIS="${CONTRACTS_CLIS:-$ALL_CLIS}"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/*.json

SUMMARY_FILE="$OUT_DIR/summary.txt"
: > "$SUMMARY_FILE"

for cli in $CLIS; do
  line="$(CONTRACTS_REPO_DIR="$REPO_DIR" CONTRACTS_OUT_DIR="$OUT_DIR" \
            bash "$PROBE" "$cli" 2>/dev/null | grep '^CONTRACTS_JSON ' | tail -1)"
  # The probe's exit trap guarantees a line even when it dies, so an empty one
  # means the probe could not be started at all — worth saying plainly rather
  # than silently skipping the CLI.
  [ -z "$line" ] && line="CONTRACTS_JSON {\"cli\":\"$cli\",\"verdict\":\"ERROR\",\"note\":\"probe produced no output\",\"events\":[]}"
  echo "$line" | tee -a "$SUMMARY_FILE"
done

# Assembly, comparison and the verdict all live in contracts-pack.mjs, shared
# with the box job so a laptop and the cron produce identical packs.
exec bun "$REPO_DIR/integration-suite/contracts-pack.mjs" \
  --in "$OUT_DIR" --summary "$SUMMARY_FILE" --out "$PACK" --repo "$REPO_DIR"
