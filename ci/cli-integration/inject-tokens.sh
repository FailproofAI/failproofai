#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Token injection — runs INSIDE the sandbox container, against the fresh per-run
# HOME volume, BEFORE the probes.
#
# On the office box the OAuth logins (cursor / devin / antigravity) live in a
# PERSISTENT volume. GitHub-Actions runners are ephemeral, so instead each of
# those credential trees is captured once (see capture-tokens.sh) into a GitHub
# secret as a base64 gzip-tar rooted at $HOME, decoded by the workflow into
# /opt/tokens/<name>.tgz, and extracted here into the fresh volume's $HOME.
#
# Extraction is rooted at $HOME and the tarballs were created with $HOME-relative
# paths (e.g. `.config/cursor`, `.local/share/devin/credentials.toml`), so each
# file lands exactly where its CLI expects it. Env-var-auth CLIs (gateway key,
# copilot PAT, factory BYOK) need NO file here — they authenticate from env.
# ─────────────────────────────────────────────────────────────────────────────
set -u
TOK="${1:-/opt/tokens}"

if [ ! -d "$TOK" ]; then
  echo "inject-tokens: no token dir at $TOK — nothing to inject (env-var CLIs only)"
  exit 0
fi

shopt -s nullglob
found=0
for t in "$TOK"/*.tgz "$TOK"/*.tar.gz; do
  found=1
  echo "── injecting $(basename "$t") → \$HOME ──"
  if tar -C "$HOME" -xzf "$t"; then
    tar -tzf "$t" 2>/dev/null | sed 's/^/    /' | head -8
  else
    echo "    WARN: extract failed for $t (skipping — that CLI will report ERROR)"
  fi
done
[ "$found" = 0 ] && echo "inject-tokens: token dir present but empty — env-var CLIs only"

echo "── credential files now present in volume ──"
for f in "$HOME/.config/cursor/auth.json" \
         "$HOME/.local/share/devin/credentials.toml" \
         "$HOME/.gemini/antigravity-cli"; do
  [ -e "$f" ] && echo "  ✓ $f" || echo "  ✗ $f (absent)"
done
exit 0
