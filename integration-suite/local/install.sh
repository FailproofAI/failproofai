#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-time (and safely re-runnable) setup for the canary BOX.
#
# Copies run-local.sh OUTSIDE the runner clone (the clone is hard-reset on
# every run, so nothing that survives a run may live inside it), installs the
# systemd user units, prepares the state dirs, and writes a secrets template.
# Re-running refreshes the installed copies but NEVER touches an existing
# secrets.env.
# ─────────────────────────────────────────────────────────────────────────────
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CONF_DIR="${CANARY_CONF_DIR:-$HOME/.config/failproofai-canary}"
STATE_DIR="${CANARY_STATE_DIR:-$HOME/.local/state/failproofai-canary}"
UNIT_DIR="$HOME/.config/systemd/user"
ME="${USER:-$(id -un)}"

echo "── checking box requirements ──"
missing=0
for bin in docker git bun node curl flock; do
  command -v "$bin" >/dev/null 2>&1 || { echo "  ✗ $bin not found on PATH"; missing=1; }
done
if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo "  ✗ docker daemon not reachable as $ME (docker group membership?)"; missing=1
fi
[ "$missing" = 0 ] && echo "  ✓ docker git bun node curl flock all present"

echo "── installing ──"
mkdir -p "$CONF_DIR/bin" "$STATE_DIR/logs" "$UNIT_DIR"
install -m 755 "$HERE/run-local.sh" "$CONF_DIR/bin/run-local.sh"
install -m 644 "$HERE/failproofai-canary.service" "$HERE/failproofai-canary.timer" "$UNIT_DIR/"
echo "  ✓ $CONF_DIR/bin/run-local.sh"
echo "  ✓ $UNIT_DIR/failproofai-canary.{service,timer}"
systemctl --user daemon-reload 2>/dev/null \
  || echo "  ⚠ systemctl --user unavailable in this shell — run 'systemctl --user daemon-reload' from a login session"

if [ ! -f "$CONF_DIR/secrets.env" ]; then
  (
    umask 177
    cat > "$CONF_DIR/secrets.env" <<'EOF'
# failproofai canary — box configuration. chmod 600; sourced by run-local.sh.
# Same variables the GHA `cli-integration` Environment supplied — see
# integration-suite/ci-entrypoint.sh's header for what each one does.

# ── gateway + PAT credentials ────────────────────────────────────────────────
CANARY_LLM_API_KEY=
#CANARY_LLM_BASE_URL=https://models.aikin.club
#CANARY_LLM_MODEL=deepseek-v4-pro
#CANARY_CLAUDE_MODEL=claude-haiku-4-5
#CANARY_PI_MODEL=claude-haiku-4-5
#CANARY_CODEX_MODEL=gpt-5.1-codex-mini
COPILOT_GITHUB_TOKEN=

# ── OAuth credential trees (base64 gzip-tars rooted at $HOME) ────────────────
# Produce these on a LOGGED-IN machine with integration-suite/capture-tokens.sh
# and paste the output here; the box itself never needs vendor logins. An empty
# value just makes that CLI report ERROR (can't auth), not a failed run.
CURSOR_TOKEN_TGZ_B64=
DEVIN_TOKEN_TGZ_B64=
ANTIGRAVITY_TOKEN_TGZ_B64=

# ── reporting ────────────────────────────────────────────────────────────────
CANARY_SLACK_WEBHOOK=

# ── what to test ─────────────────────────────────────────────────────────────
# REQUIRED. Deliberately explicit (no baked-in default): flip to origin/main
# once the failproofaid branch (#632) merges.
CANARY_REF=origin/failproofaid
# Stable leg probes the daemon-configured (failproofaid) hook path; beta stays
# in-process. Flip these to move the daemon dimension between legs.
#CANARY_DAEMON_STABLE=1
#CANARY_DAEMON_BETA=0
#CANARY_GIT_URL=https://github.com/FailproofAI/failproofai.git
#CANARY_CLONE=$HOME/canary/failproofai
EOF
  )
  echo "  ✓ wrote template $CONF_DIR/secrets.env (fill it in)"
else
  echo "  ✓ kept existing $CONF_DIR/secrets.env"
fi

cat <<EOF

Next steps:
  1. Fill in $CONF_DIR/secrets.env
  2. loginctl enable-linger $ME          # timer fires without a login session
  3. systemctl --user enable --now failproofai-canary.timer
  4. Shakedown (probes all 12 CLIs, ~1h):
       CANARY_VERSION_GATED=none $CONF_DIR/bin/run-local.sh
  Watch runs:  journalctl --user -u failproofai-canary.service -f
EOF
