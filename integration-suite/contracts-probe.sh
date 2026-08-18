#!/usr/bin/env bash
# Capture what ONE agent CLI's hook contract actually looks like today.
#
# This answers a different question from probe-cli.sh. That one asks "is
# enforcement working" and needs a deny to observe. This one asks "does the
# vendor still accept the config we install, and what do its payloads look
# like" — which needs no deny at all, only a tool call and a look at what
# arrived.
#
# ── The oracle ───────────────────────────────────────────────────────────────
# The agent is asked to create a file. What happened is then read off two
# independent witnesses — the file, and the events we received — with no
# judgement of the model's output at all:
#
#   file created + PreToolUse seen   the vendor still calls us            OK   0
#   file created + PreToolUse absent the tool RAN without us — DRIFT           1
#   no file      + events seen       hooks work, model idle       INCONCLUSIVE 0
#   no file      + nothing + rc≠0    the CLI never ran                 ERROR   2
#   no file      + nothing + rc=0    ran, told us nothing              ERROR   2
#
# Row 2 is the whole point, and it is the one class no customer machine can
# report: when a vendor rejects our config, nothing reaches us, so silence at
# our end looks identical to a quiet day. The created file is the independent
# witness that separates "nothing happened" from "something happened without
# us".
#
# Rows 4 and 5 are loud on purpose. Everything upstream — credentials, install
# — is deliberately non-fatal, so a CLI that never started yields an empty
# observation table byte-identical to a healthy CLI that was simply idle. Only
# the exit status tells them apart, and a lab that reports "clean" when it is
# actually broken is worse than no lab.
#
# ── Two things that would silently invalidate a run ──────────────────────────
# 1. `observed.json` ACCUMULATES. It unions keys and never forgets, which is
#    right for a real machine and fatal here: a CLI whose hooks stopped firing
#    would still show yesterday's events and read as healthy forever. It is
#    deleted before every run so the table describes THIS run only.
# 2. Writes are throttled (60s) and the daemon SIGKILLs the worker, so a whole
#    probe's observations can die unwritten. FAILPROOFAI_OBSERVE_INTERVAL_MS=0
#    makes every discovery hit disk immediately.
#
# Only the warm worker records — `recordHookShape` has one call site, in
# worker-server.ts — so this ALWAYS runs the daemon path. The in-process path
# records nothing.
set -uo pipefail

CLI="${1:?usage: contracts-probe.sh <cli>}"
BASE="$HOME/contracts-$CLI"

# Overridable so this can be exercised outside the sandbox image. In the
# container both defaults are what run.sh mounts; a script that can only run in
# CI is a script that ships untested.
REPO_DIR="${CONTRACTS_REPO_DIR:-/repo}"
FAILPROOFAID_BIN="${CONTRACTS_DAEMON_BIN:-/opt/failproofaid/failproofaid}"
# NOT under $REPO_DIR: the canary mounts /repo READ-ONLY, and an artifact
# directory that cannot be written is one the run silently produces nothing in.
OUT_DIR="${CONTRACTS_OUT_DIR:-$HOME/contracts-out}"
GW="${CANARY_LLM_BASE_URL:-https://models.aikin.club}"; GW="${GW%/}"
MARKER="PROBE_OK"
PROMPT="Create a file named ${MARKER} in the current directory containing the word ready. Then stop."

EMITTED=0
verdict() { # $1 = OK|DRIFT|INCONCLUSIVE|ERROR  $2 = note
  EMITTED=1
  printf 'CONTRACTS_JSON {"cli":"%s","verdict":"%s","note":"%s","events":%s}\n' \
    "$CLI" "$1" "$2" "${EVENTS_JSON:-[]}"
  [ "$1" = DRIFT ] && exit 1
  [ "$1" = ERROR ] && exit 2
  exit 0
}

# Every death produces a verdict line, including the ones nobody planned for.
# `set -u` turns one unset `CANARY_*` model variable into an immediate exit
# from inside drive(), and the outer job would otherwise collect NOTHING for
# that CLI — no line, no artifact, nothing to distinguish it from a CLI that
# was never scheduled. Silence is the one report this lab must never produce.
on_exit() {
  rc=$?
  [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null
  [ "$EMITTED" = 1 ] && return $rc
  printf 'CONTRACTS_JSON {"cli":"%s","verdict":"ERROR","note":"probe died before reaching a verdict (exit %s)","events":%s}\n' \
    "$CLI" "$rc" "${EVENTS_JSON:-[]}"
  # 2 is the contract's "could not check". The original status is in the note,
  # but 1 would read as "findings remain" — a claim this run cannot support.
  exit 2
}
trap on_exit EXIT

# ── The oracle, on its own ───────────────────────────────────────────────────
# `--decide <cli> <acted> <events-json> <rc>` runs only the decision and exits.
# DRIFT is the one outcome no real CLI produces on demand — reaching it live
# requires a vendor to actually break — so asking for it directly is the only
# way it is ever exercised. Pinned by `contracts-verdict.test.ts`.
decide() { # $1 = 1|0 acted ; $2 = events json ; $3 = the CLI's exit status
  ACTED="$1"; EVENTS_JSON="$2"; DRIVE_RC="$3"
  SAW_PRETOOL=0; case "$EVENTS_JSON" in *'"PreToolUse"'*) SAW_PRETOOL=1 ;; esac
  SAW_ANY=0;     [ "$EVENTS_JSON" != "[]" ] && SAW_ANY=1

  if [ "$ACTED" = 1 ] && [ "$SAW_PRETOOL" = 1 ]; then
    verdict OK "tool ran and we were called"
  elif [ "$ACTED" = 1 ]; then
    # The decisive case. Something executed a tool and no PreToolUse reached us.
    verdict DRIFT "the tool RAN and no PreToolUse arrived - config format moved"
  elif [ "$SAW_ANY" = 1 ]; then
    # Hooks demonstrably work; the model simply did not do the thing. The one
    # genuinely benign miss, and the only quiet non-OK outcome.
    verdict INCONCLUSIVE "hooks fired but the model never created the file"
  elif [ "$DRIVE_RC" != 0 ]; then
    # Nothing arrived AND the CLI failed. Loud on purpose: the credential and
    # install steps upstream are deliberately non-fatal, so a CLI that never
    # started would otherwise produce an empty table indistinguishable from a
    # quiet, healthy day.
    verdict ERROR "could not run the CLI (exit $DRIVE_RC) - see drive.log"
  else
    # It ran, it exited clean, and we heard nothing at all - not even a session
    # event. That is what a rejected config looks like, but with no tool call to
    # witness it we cannot say so. Either way it is not a clean run.
    verdict ERROR "the CLI ran and we received no events at all - see drive.log"
  fi
}

if [ "$CLI" = "--decide" ]; then CLI="${2:?}"; decide "${3:?}" "${4:?}" "${5:?}"; fi

# Same dist preparation probe-cli.sh does: /repo may be mounted read-only, and
# the custom-policy loader needs somewhere writable.
FP_DIST="$HOME/fp-dist-contracts"
rm -rf "$FP_DIST"; mkdir -p "$FP_DIST"
cp -r "$REPO_DIR/dist/." "$FP_DIST/" || { echo "could not prepare dist from $REPO_DIR/dist" >&2; exit 1; }
export FAILPROOFAI_DIST_PATH="$FP_DIST" FAILPROOFAI_TELEMETRY_DISABLED=1
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.factory/bin:$PATH"

mkdir -p "$HOME/bin"
printf '#!/bin/sh\nexec bun %s/bin/failproofai.mjs "$@"\n' "$REPO_DIR" > "$HOME/bin/failproofai"
chmod +x "$HOME/bin/failproofai"
export FAILPROOFAI_BINARY_OVERRIDE="$HOME/bin/failproofai"

fp() { bun "$REPO_DIR/bin/failproofai.mjs" "$@"; }

# ── Per-CLI invocation ───────────────────────────────────────────────────────
# Copied verbatim from probe-cli.sh's drive(). `contracts-drive-parity.test.ts`
# asserts the two stay byte-identical per CLI, so this cannot drift silently —
# probe-cli.sh is the canary's working code and is not refactored from here.
drive() { # $1 = prompt ; run ONE prompt headless, executing tools without approval
  # An escape hatch for the box: when a vendor changes its invocation between
  # image builds, the run can be unblocked without a release. Also how the
  # plumbing is exercised without a vendor or credentials.
  if [ -n "${CONTRACTS_DRIVE_CMD:-}" ]; then
    ( cd "$BASE" && PROMPT="$1" sh -c "$CONTRACTS_DRIVE_CMD" 2>&1 )
    return $?
  fi
  case "$CLI" in
    claude)   ( cd "$BASE" && claude -p "$1" --model "$CANARY_CLAUDE_MODEL" --dangerously-skip-permissions 2>&1 ) ;;
    opencode) ( cd "$BASE" && opencode run --auto -m "gw/$CANARY_LLM_MODEL" "$1" 2>&1 ) ;;
    goose)    ( cd "$BASE" && goose run --no-session -t "$1" 2>&1 ) ;;
    hermes)   ( cd "$BASE" && hermes --yolo -z "$1" 2>&1 ) ;;
    pi)       ( cd "$BASE" && pi --provider openai --model "openai/$CANARY_PI_MODEL" --api-key "$CANARY_LLM_API_KEY" -p "$1" 2>&1 ) ;;
    codex)    ( cd "$BASE" && codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust \
                  -c model_providers.gw.name="gw" -c model_providers.gw.base_url="$GW/v1" -c model_providers.gw.wire_api="responses" \
                  -c model_providers.gw.env_key="CANARY_LLM_API_KEY" -c model_provider="gw" \
                  -c model="$CANARY_CODEX_MODEL" "$1" 2>&1 ) ;;
    cursor)   ( cd "$BASE" && cursor-agent -p --force "$1" 2>&1 ) ;;
    copilot)  ( cd "$BASE" && copilot -p "$1" --allow-all-tools 2>&1 ) ;;
    devin)    ( cd "$BASE" && devin -p "$1" --permission-mode dangerous --respect-workspace-trust false 2>&1 ) ;;
    antigravity) ( cd "$BASE" && agy -p "$1" --model "${CANARY_ANTIGRAVITY_MODEL:-Gemini 3.5 Flash (Low)}" --dangerously-skip-permissions 2>&1 ) ;;
    factory)  ( cd "$BASE" && droid exec --auto high -m "custom:gw-haiku-0" "$1" 2>&1 ) ;;
    openclaw) ( cd "$BASE" && timeout 150 openclaw agent --local --session-key "contracts-$RANDOM$RANDOM" --model "gw/$CANARY_LLM_MODEL" -m "$1" 2>&1 ) ;;
    *) echo "drive: $CLI not implemented" >&2; return 3 ;;
  esac
}

rm -rf "$BASE"; mkdir -p "$BASE"

# ── A run must describe only itself ──────────────────────────────────────────
OBSERVED="$HOME/.failproofai/contracts/observed.json"
rm -f "$OBSERVED"

# Kept, not discarded: "could not install hooks" without the reason is a dead
# end for whoever reads the report tomorrow morning.
if ! fp policies --install --cli "$CLI" --scope user > "$BASE/install.log" 2>&1; then
  verdict ERROR "could not install hooks for $CLI - see install.log"
fi

# Mark the machine daemon-configured, the way `failproofai config` would. The
# observer only records on this path.
mkdir -p "$HOME/.failproofai"
printf '{"layout":4,"cli":"probe","daemon":"probe"}' > "$HOME/.failproofai/VERSION"
bun -e "const{updateConfig}=await import('$REPO_DIR/src/hooks/fp-config.ts');updateConfig({daemon:{configured:true}})" \
  >/dev/null 2>&1 || verdict ERROR "could not mark the machine daemon-configured"

export FAILPROOFAI_OBSERVE_INTERVAL_MS=0   # every discovery hits disk; see header
export FAILPROOFAI_OBSERVE_VERSIONS=1      # record the vendor's version too

FAILPROOFAI_WORKER_CMD="bun $REPO_DIR/bin/failproofai-worker.mjs" \
  "$FAILPROOFAID_BIN" >> "$BASE/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do [ -S "$HOME/.failproofai/run/failproofaid.sock" ] && break; sleep 0.2; done
if ! [ -S "$HOME/.failproofai/run/failproofaid.sock" ]; then
  verdict ERROR "daemon did not come up"
fi

DRIVE_OUT="$(drive "$PROMPT")"; DRIVE_RC=$?
# Enough to see why a run failed: the useful error is often well above the
# last few lines of an agent's output.
echo "$DRIVE_OUT" | tail -200 > "$BASE/drive.log"

kill "$DAEMON_PID" 2>/dev/null; wait "$DAEMON_PID" 2>/dev/null

# ── Read what arrived ────────────────────────────────────────────────────────
export OBSERVED CLI
EVENTS_JSON="$(bun -e '
  const fs = require("node:fs");
  try {
    const t = JSON.parse(fs.readFileSync(process.env.OBSERVED, "utf8"));
    console.log(JSON.stringify(Object.keys(t.clis?.[process.env.CLI]?.hooks ?? {}).sort()));
  } catch { console.log("[]"); }
' 2>/dev/null)" || EVENTS_JSON="[]"

ACTED=0; [ -f "$BASE/$MARKER" ] && ACTED=1

# Publish whatever we captured, even on a bad verdict: a table from a run that
# went wrong is still evidence, and withholding it hides the diff that explains
# why.
mkdir -p "$OUT_DIR"
cp -f "$OBSERVED" "$OUT_DIR/$CLI.json" 2>/dev/null || true

decide "$ACTED" "$EVENTS_JSON" "$DRIVE_RC"
