#!/usr/bin/env bash
#
# failproofai hook-sync entrypoint (runs as PID 1 under dumb-init).
#
# Lifecycle:
#   1. Validate env (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN).
#   2. gh auth setup-git + git identity.
#   3. Clone failproofai --depth=1; cut a fresh auto/sync-cli-harnesses-<UTC> branch.
#   4. NEUTRALIZE two policies in the THROWAWAY clone's .failproofai config
#      (require-ci-green-before-stop, block-read-outside-cwd) via jq, then
#      `git update-index --skip-worktree` so the edit is invisible to
#      git status/add and never enters the agent's commit/PR — while failproofai
#      reads the edited WORKTREE file at runtime and sees them gone. The
#      require-commit/push/pr-before-stop gates stay ACTIVE (dogfooding).
#   5. exec `claude --effort ultracode -p <prompt>` wrapped in a PTY so
#      --output-format stream-json line-flushes to `kubectl logs -f`.
#   6. Exit with claude's return code (all output streams to stdout / the pod log).
#
# Exit codes: 0 = agent finished (claude's rc) · 64 = missing required env ·
#             65 = prompt file missing in clone · 66 = unsafe WORKSPACE · else = claude's rc.
set -euo pipefail

CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}"
GH_TOKEN="${GH_TOKEN:-}"
REPO_URL="${REPO_URL:-https://github.com/failproofai/failproofai.git}"
REPO_BRANCH_FROM="${REPO_BRANCH_FROM:-main}"
WORKSPACE="${WORKSPACE:-/workspace}"
PROMPT_PATH="${PROMPT_PATH:-scripts/sync-agent-cli-harnesses-prompt.md}"
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-opus-4-8}"

export HOME="${HOME:-/home/appuser}"
export CLAUDE_CODE_OAUTH_TOKEN
export GH_TOKEN
export GITHUB_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"
export FAILPROOFAI_TELEMETRY_DISABLED=1
# Keep ultracode background subagents alive in headless -p mode (default is ~10 min).
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-1800000}"

log() { printf '[entrypoint %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ---------------- 1. env validation ----------------
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then log "ERROR: CLAUDE_CODE_OAUTH_TOKEN not set"; exit 64; fi
if [ -z "$GH_TOKEN" ]; then log "ERROR: GH_TOKEN not set"; exit 64; fi

# ---------------- 2. gh + git auth ----------------
log "authenticating gh"
gh auth setup-git >/dev/null
git config --global user.name  "failproofai-hook-sync"
git config --global user.email "hook-sync-bot@exosphere.host"
git config --global init.defaultBranch main

# ---------------- 3. clone + fresh branch ----------------
case "$WORKSPACE" in
  ""|"/"|"."|"..") log "ERROR: refusing unsafe WORKSPACE '$WORKSPACE'"; exit 66 ;;
esac
mkdir -p "$WORKSPACE"
if [ -n "$(ls -A "$WORKSPACE" 2>/dev/null)" ]; then
  find "$WORKSPACE" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
fi
log "cloning $REPO_URL@$REPO_BRANCH_FROM -> $WORKSPACE"
git clone --depth=1 --branch "$REPO_BRANCH_FROM" "$REPO_URL" "$WORKSPACE"
cd "$WORKSPACE"
# Fetch the base ref (shallow) so require-*-before-stop can diff against origin/<base>.
git fetch --depth=1 origin "$REPO_BRANCH_FROM" >/dev/null 2>&1 || true
BRANCH="auto/sync-cli-harnesses-$(date -u +%Y%m%dT%H%M%SZ)"
git checkout -b "$BRANCH"
log "working on branch $BRANCH"

# ---------------- 4. policy-config neutralization ----------------
# enabledPolicies is a UNION across scopes with no disable field, so a policy must
# be removed from the file that lists it. --skip-worktree then hides that edit from
# git status/add (so it never lands in the PR) while failproofai still reads the
# edited worktree file at runtime. Keeps require-commit/push/pr-before-stop active.
CFG=".failproofai/policies-config.json"
if [ -f "$CFG" ]; then
  cfg_tmp="$(mktemp)"
  jq '.enabledPolicies |= map(select(. != "require-ci-green-before-stop" and . != "block-read-outside-cwd"))' "$CFG" > "$cfg_tmp" && mv "$cfg_tmp" "$CFG"
  git update-index --skip-worktree "$CFG"
  log "neutralized require-ci-green-before-stop + block-read-outside-cwd for this run (skip-worktree; not committed)"
else
  log "WARN: $CFG not found; running with the repo's default policy set"
fi

# ---------------- 5. invoke claude (ULTRACODE, headless, PTY-wrapped) ----------------
PROMPT_FILE="$WORKSPACE/$PROMPT_PATH"
if [ ! -f "$PROMPT_FILE" ]; then log "ERROR: prompt missing at $PROMPT_FILE"; exit 65; fi

# Node block-buffers stdout when it's a pipe; `script -qefc ... /dev/null` gives
# claude a PTY so --output-format stream-json line-flushes to the pod logs. `-e`
# ties script's exit code to claude's.
RUN_SH="$(mktemp /tmp/run-claude.XXXXXX.sh)"
cat >"$RUN_SH" <<EOF
#!/usr/bin/env bash
exec claude --effort ultracode --model ${CLAUDE_MODEL} \\
    --verbose --output-format stream-json \\
    --dangerously-skip-permissions \\
    -p "\$(cat "$PROMPT_FILE")" 2>&1
EOF
chmod +x "$RUN_SH"

log "invoking claude --effort ultracode --model ${CLAUDE_MODEL} (prompt: $PROMPT_PATH)"
set +e
script -qefc "$RUN_SH" /dev/null
rc=$?
set -e
rm -f "$RUN_SH"
log "claude exited $rc"

exit "$rc"
