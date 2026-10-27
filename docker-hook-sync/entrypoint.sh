#!/usr/bin/env bash
#
# failproofai hook-sync entrypoint (runs as PID 1 under dumb-init).
#
# Lifecycle:
#   1. Validate env (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN).
#   2. gh auth setup-git + git identity.
#   3. Clone failproofai --depth=1; cut a fresh auto/sync-cli-harnesses-<UTC> branch.
#   4. Run `claude --effort ultracode -p <prompt>` wrapped in a PTY so
#      --output-format stream-json line-flushes to `kubectl logs -f`. The prompt
#      has the agent commit, push and open the PR itself.
#   5. Publish safety net: if the agent committed but left the branch unpushed or
#      without a PR, push it and open the PR here. Uncommitted edits are never
#      committed by this script — they are logged and fail the run.
#   6. Exit with claude's return code (all output streams to stdout / the pod log).
#
# Exit codes: 0 = agent finished (claude's rc) · 64 = missing required env ·
#             65 = prompt file missing in clone · 66 = unsafe WORKSPACE ·
#             67 = agent left uncommitted changes · 68 = push / PR creation failed ·
#             else = claude's rc.
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
# Fetch the base ref (shallow) so the publish step can count commits ahead of origin/<base>.
git fetch --depth=1 origin "$REPO_BRANCH_FROM" >/dev/null 2>&1 || true
BRANCH="auto/sync-cli-harnesses-$(date -u +%Y%m%dT%H%M%SZ)"
git checkout -b "$BRANCH"
log "working on branch $BRANCH"

# ---------------- 4. invoke claude (ULTRACODE, headless, PTY-wrapped) ----------------
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

# ---------------- 5. publish safety net ----------------
# The prompt tells the agent to commit, push and open the PR. Nothing enforces
# that inside the clone, so finish the job here for any commit it left behind.
# The PR body the agent writes is the real one; the fallback body only points
# reviewers at the commits.
if [ -n "$(git status --porcelain)" ]; then
  log "ERROR: agent left uncommitted changes (not committing them):"
  git status --short
  exit 67
fi

ahead="$(git rev-list --count "origin/$REPO_BRANCH_FROM..HEAD" 2>/dev/null || echo 0)"
if [ "$ahead" -gt 0 ]; then
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)" ]; then
    log "pushing $ahead commit(s) on $BRANCH"
    git push -u origin "$BRANCH" || { log "ERROR: push failed"; exit 68; }
  fi
  if [ -z "$(gh pr list --head "$BRANCH" --state all --json number --jq '.[].number')" ]; then
    log "agent did not open a PR; opening one"
    gh pr create --base "$REPO_BRANCH_FROM" --head "$BRANCH" \
      --title "[auto] sync agent CLI harnesses with upstream docs" \
      --body "$(printf 'Automated hook-sync run. The agent committed these changes but did not open the PR itself; see the commits and the run log for the drift report.\n\n%s\n\nCI must pass and this PR must be reviewed before merging.' "$(git log --format='- %s' "origin/$REPO_BRANCH_FROM..HEAD")")" \
      || { log "ERROR: gh pr create failed"; exit 68; }
  fi
else
  log "no commits on $BRANCH; nothing to publish"
fi

exit "$rc"
