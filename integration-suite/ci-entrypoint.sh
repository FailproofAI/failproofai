#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# failproofai integration suite — CI entrypoint (runs on the GitHub Actions runner).
#
# This is the suite's single front door for CI. The workflow
# (.github/workflows/integration-suite.yml) is a thin trigger: it checks out,
# installs bun, maps secrets into the environment, and calls this script. Every
# step that actually *does* something lives here, so the harness can be read —
# and run — without opening the YAML.
#
# Responsibilities, in order:
#   1. build failproofai under test (dist/index.js + dist/cli.mjs)
#   2. decode the base64 OAuth-token secrets into $TOKENS_DIR
#   3. build the sandbox image and create the per-run HOME volume
#   4. install all 12 CLIs @latest into that volume, then inject the tokens
#   5. assemble the gateway env-file
#   6. hand off to run.sh, which does the version-gating, probing and reporting
#
# Cleanup (env-file + docker volume) runs via trap, so it happens on failure and
# on early exit too — not just on the happy path.
#
# Inputs are all environment variables, so this is runnable outside GH Actions:
#
#   GITHUB_WORKSPACE       repo checkout (default: this script's parent dir)
#   CANARY_LLM_API_KEY     gateway credentials -> written into the env-file
#   CANARY_LLM_BASE_URL    (default https://models.aikin.club)
#   CANARY_LLM_MODEL       (default deepseek-v4-pro)
#   CANARY_CLAUDE_MODEL    (default claude-haiku-4-5)
#   CANARY_PI_MODEL        (default claude-haiku-4-5)
#   CANARY_CODEX_MODEL     (default gpt-5.1-codex-mini)
#   COPILOT_GITHUB_TOKEN   copilot PAT
#   CURSOR_TOKEN_TGZ_B64   } base64 gzip-tars of each OAuth credential tree,
#   DEVIN_TOKEN_TGZ_B64    } rooted at $HOME (see capture-tokens.sh)
#   ANTIGRAVITY_TOKEN_TGZ_B64
#   CANARY_STATE           version-gate state file (restored/saved by the workflow cache)
#   CANARY_SLACK_WEBHOOK   optional; report is POSTed here when set
#   CANARY_FP_SHA          failproofai HEAD, the second version-gate dimension
#   CANARY_VERSION_GATED   "all" (default) | comma-sep list | "none" to force-probe
#   CANARY_CLIS            space-separated CLI subset (empty = all 12)
#   CANARY_SKIP_BUILD      set to 1 to reuse an existing dist/ (local iteration)
#   CANARY_DAEMON          set to 1 to probe the daemon-configured (failproofaid)
#                          hook path: builds the Rust daemon and routes every
#                          probe's hooks through it, fail-closed (see probe-cli.sh)
#   CANARY_DAEMON_DEAD     set to 1 for the fail-closed leg: daemon-configured
#                          but the daemon is never started — every CLI must
#                          DENY. Implies CANARY_DAEMON=1; skips the Rust build.
#   CANARY_CARGO_CACHE     cargo home+target cache dir for the daemon build
#                          (default ~/.cache/failproofai-canary/cargo)
# ─────────────────────────────────────────────────────────────────────────────
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${GITHUB_WORKSPACE:-$(dirname "$HERE")}"

# Each channel gets its OWN volume: installing a pre-release into the same $HOME
# overwrites the stable binary (npm -g, and the vendor installers all rewrite
# their own shims), so the two refs cannot coexist in one volume.
CHANNEL="${CANARY_CHANNEL:-stable}"
SUFFIX=""; [ "$CHANNEL" != stable ] && SUFFIX="-$CHANNEL"
VOL="${CANARY_VOL:-integration-suite$SUFFIX}"
IMAGE="${CANARY_IMAGE:-failproofai-integration-suite:base}"
ENVFILE="${CANARY_ENVFILE:-$REPO/canary$SUFFIX.env}"
TOKENS_DIR="${CANARY_TOKENS_DIR:-$REPO/tokens$SUFFIX}"
STATE="${CANARY_STATE:-$REPO/integration-suite-state$SUFFIX.json}"
# The stable leg's state, so the beta leg can tell "about to break" from
# "already broken" (see report.js). Unset on the stable leg.
PEER_STATE="${CANARY_PEER_STATE:-}"
[ "$CHANNEL" != stable ] && [ -z "$PEER_STATE" ] && PEER_STATE="$REPO/integration-suite-state.json"

step() { echo "── $* ──" >&2; }

cleanup() {
  local rc=$?
  step "cleanup"
  rm -f "$ENVFILE"
  rm -rf "$TOKENS_DIR"
  docker volume rm "$VOL" -f >/dev/null 2>&1 || true
  exit "$rc"
}
trap cleanup EXIT

# ── 0. adopt legacy version-gate state (rename transition) ──────────────────
# This harness was renamed from `cli-integration`, which took the Actions cache
# key with it. The workflow restores the legacy cache alongside the new one; if
# only the legacy file is present, adopt it so the version-gate keeps its
# baseline instead of re-probing all 12 CLIs and reporting every one as changed.
# Safe to delete (with the workflow's legacy restore step) once a run has saved
# state under the new key.
LEGACY_STATE="${CANARY_LEGACY_STATE:-$REPO/cli-integration-state.json}"
if [ ! -s "$STATE" ] && [ -s "$LEGACY_STATE" ]; then
  step "adopting legacy version-gate state from $(basename "$LEGACY_STATE")"
  cp "$LEGACY_STATE" "$STATE" || echo "  WARN: copy failed — gate starts empty" >&2
fi

# ── 1. build failproofai under test ─────────────────────────────────────────
if [ "${CANARY_SKIP_BUILD:-0}" = 1 ]; then
  step "skipping build (CANARY_SKIP_BUILD=1)"
else
  step "building failproofai under test (dist/index.js + dist/cli.mjs — no dashboard)"
  (
    cd "$REPO" || exit 1
    # --ignore-scripts, or the package `prepare` hook runs `bun run build` —
    # the FULL build, Next.js dashboard and all — before the two narrow builds
    # below, on every leg of every run. The step above says "no dashboard"; this
    # flag is what makes that true. Same guard translate-docs.yml carries, for
    # the same reason. Caught by running the box end to end: the log showed
    # `next build` compiling 3 static pages under a step that claims not to.
    bun install --frozen-lockfile --ignore-scripts || exit 1
    bun build --target=node --format=cjs --outfile=dist/index.js src/index.ts || exit 1
    bun run build:cli || exit 1
  ) || { echo "✗ build failed" >&2; exit 1; }
fi
if [ ! -s "$REPO/dist/index.js" ] || [ ! -s "$REPO/dist/cli.mjs" ]; then
  echo "✗ dist/index.js and dist/cli.mjs must both be non-empty" >&2
  exit 1
fi

# ── 1b. build failproofaid under test (daemon mode only) ────────────────────
# Built in a rust:1-bookworm container, NOT on the host: the sandbox image is
# node:22-bookworm-slim (glibc 2.36), and a binary linked against a newer host
# glibc would fail to load inside it. The repo mounts read-only — cargo writes
# only to the mounted cache (registry + target), so the checkout stays clean.
# The DEAD (fail-closed) leg needs no binary — the daemon is never started.
[ "${CANARY_DAEMON_DEAD:-0}" = 1 ] && CANARY_DAEMON=1
if [ "${CANARY_DAEMON:-0}" = 1 ] && [ "${CANARY_DAEMON_DEAD:-0}" != 1 ]; then
  step "building failproofaid (daemon) under test"
  if [ ! -f "$REPO/crates/failproofaid/Cargo.toml" ]; then
    echo "✗ CANARY_DAEMON=1 but $REPO has no crates/failproofaid — this ref predates the daemon; unset CANARY_DAEMON or pick a ref that carries it" >&2
    exit 1
  fi
  CARGO_CACHE="${CANARY_CARGO_CACHE:-$HOME/.cache/failproofai-canary/cargo}"
  mkdir -p "$CARGO_CACHE/home" "$CARGO_CACHE/target"
  docker run --rm -u "$(id -u):$(id -g)" \
    -e HOME=/cargo/home -e CARGO_HOME=/cargo/home -e CARGO_TARGET_DIR=/cargo/target \
    -v "$CARGO_CACHE:/cargo" -v "$REPO:/src:ro" -w /src \
    rust:1-bookworm cargo build --release --locked -p failproofaid \
    || { echo "✗ failproofaid build failed" >&2; exit 1; }
  export CANARY_DAEMON_BIN="$CARGO_CACHE/target/release/failproofaid"
  [ -x "$CANARY_DAEMON_BIN" ] || { echo "✗ built failproofaid missing at $CANARY_DAEMON_BIN" >&2; exit 1; }
fi

# ── 2. decode OAuth token secrets ───────────────────────────────────────────
# Each is a base64 gzip-tar rooted at $HOME. A missing secret is NOT fatal: that
# CLI simply reports ERROR (can't auth) rather than taking the whole run down.
step "decoding OAuth token secrets"
mkdir -p "$TOKENS_DIR"
chmod 700 "$TOKENS_DIR"
decode_token() {
  local name="$1" b64="$2"
  if [ -z "$b64" ]; then
    echo "  ✗ $name: no secret set (that CLI will report ERROR)"
    return 0
  fi
  if printf '%s' "$b64" | base64 -d > "$TOKENS_DIR/$name.tgz" 2>/dev/null; then
    echo "  ✓ $name: $(wc -c < "$TOKENS_DIR/$name.tgz") bytes"
  else
    echo "  ✗ $name: base64 decode FAILED (that CLI will report ERROR)"
    rm -f "$TOKENS_DIR/$name.tgz"
  fi
}
decode_token cursor      "${CURSOR_TOKEN_TGZ_B64:-}"
decode_token devin       "${DEVIN_TOKEN_TGZ_B64:-}"
decode_token antigravity "${ANTIGRAVITY_TOKEN_TGZ_B64:-}"

# ── 3. sandbox image + per-run volume ───────────────────────────────────────
step "building sandbox image ($IMAGE)"
docker build -t "$IMAGE" "$HERE/" || { echo "✗ sandbox image build failed" >&2; exit 1; }

step "creating per-run HOME volume ($VOL)"
docker volume rm "$VOL" -f >/dev/null 2>&1 || true
docker volume create "$VOL" >/dev/null || { echo "✗ volume create failed" >&2; exit 1; }

# ── 4. install CLIs @latest, then inject tokens ─────────────────────────────
step "installing CLIs (channel=$CHANNEL) into the fresh volume"
docker run --rm -e CANARY_CHANNEL="$CHANNEL" -v "$VOL:/home/canary" -v "$HERE:/opt/canary:ro" \
  "$IMAGE" bash /opt/canary/install-clis.sh \
  || { echo "✗ CLI install failed" >&2; exit 1; }

step "injecting OAuth credential files"
docker run --rm -v "$VOL:/home/canary" \
  -v "$HERE:/opt/canary:ro" -v "$TOKENS_DIR:/opt/tokens:ro" \
  "$IMAGE" bash /opt/canary/inject-tokens.sh \
  || { echo "✗ token injection failed" >&2; exit 1; }

# ── 5. gateway env-file ─────────────────────────────────────────────────────
# umask 077 so the file with the gateway key is never group/world readable.
step "assembling gateway env-file"
(
  umask 077
  {
    echo "CANARY_LLM_API_KEY=${CANARY_LLM_API_KEY:-}"
    echo "CANARY_LLM_BASE_URL=${CANARY_LLM_BASE_URL:-https://models.aikin.club}"
    echo "CANARY_LLM_MODEL=${CANARY_LLM_MODEL:-deepseek-v4-pro}"
    echo "CANARY_CLAUDE_MODEL=${CANARY_CLAUDE_MODEL:-claude-haiku-4-5}"
    echo "CANARY_PI_MODEL=${CANARY_PI_MODEL:-claude-haiku-4-5}"
    # Without this line probe-cli.sh's CANARY_CODEX_MODEL override was dead plumbing:
    # the var is read inside the container, and only what is written here crosses into it.
    echo "CANARY_CODEX_MODEL=${CANARY_CODEX_MODEL:-gpt-5.1-codex-mini}"
    echo "COPILOT_GITHUB_TOKEN=${COPILOT_GITHUB_TOKEN:-}"
  } > "$ENVFILE"
)

# ── 6. probe + report ───────────────────────────────────────────────────────
# run.sh word-splits CANARY_CLIS into args; unquoted on purpose. It owns the
# exit code (non-zero iff a hard FAIL verdict is present), which the trap
# preserves.
step "running integration probes + report"
# shellcheck disable=SC2086
CANARY_REPO="$REPO" \
CANARY_SANDBOX="$HERE" \
CANARY_VOL="$VOL" \
CANARY_IMAGE="$IMAGE" \
CANARY_STATE="$STATE" \
CANARY_ENVFILE="$ENVFILE" \
CANARY_CHANNEL="$CHANNEL" \
CANARY_PEER_STATE="$PEER_STATE" \
CANARY_DAEMON="${CANARY_DAEMON:-0}" \
CANARY_DAEMON_DEAD="${CANARY_DAEMON_DEAD:-0}" \
CANARY_DAEMON_BIN="${CANARY_DAEMON_BIN:-}" \
  bash "$HERE/run.sh" ${CANARY_CLIS:-}
