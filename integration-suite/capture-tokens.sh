#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# capture-tokens.sh — run on the OFFICE BOX (has the logged-in canary volume).
#   ./capture-tokens.sh <owner/repo>
#
# Captures each OAuth CLI's credential tree from the persistent HOME volume as a
# base64 gzip-tar rooted at $HOME, and stores it as a GitHub Actions secret on
# the canary repo. The CI workflow decodes it back onto the ephemeral runner's
# volume (see sandbox/inject-tokens.sh), so cursor/devin/antigravity authenticate
# in CI without an interactive login.
#
# Re-run this whenever the canary reports ERROR (not-logged-in / 401) for one of
# these CLIs — i.e. after you re-login on the box — to refresh the secret.
#
# NB: these are real credentials for internal@exosphere.host. They live only in
# GitHub *encrypted secrets*, never in the repo tree.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
REPO="${1:?usage: capture-tokens.sh <owner/repo>}"
VOL="${CANARY_VOL:-failproofai-canary-home}"
IMAGE="${CANARY_IMAGE:-failproofai-canary:base}"

# secret-name   →   $HOME-relative path(s) to tar from the volume
capture() {
  local secret="$1"; shift
  local paths=("$@")
  echo "── $secret  ($(printf '%s ' "${paths[@]}"))"
  # Tar the paths (rooted at $HOME) inside the container, gzip, base64 → host.
  local b64
  b64="$(docker run --rm -v "$VOL:/home/canary" "$IMAGE" bash -c "
    cd \$HOME || exit 1
    miss=1
    for p in ${paths[*]}; do [ -e \"\$p\" ] && miss=0; done
    [ \$miss = 1 ] && { echo 'MISSING' >&2; exit 3; }
    tar -czf - ${paths[*]} 2>/dev/null | base64 -w0
  ")" || { echo "    ⚠️  none of the paths exist in the volume — skipping (login first)"; return 0; }
  if [ -z "$b64" ]; then echo "    ⚠️  empty capture — skipping"; return 0; fi
  printf '%s' "$b64" | gh secret set "$secret" --repo "$REPO" --body -
  echo "    ✓ set $secret (${#b64} b64 chars)"
}

echo "Capturing OAuth credential trees from volume '$VOL' → secrets on $REPO"
capture CURSOR_TOKEN_TGZ_B64       .config/cursor
capture DEVIN_TOKEN_TGZ_B64        .local/share/devin/credentials.toml
# antigravity: capture ONLY the small OAuth token file — the full ~/.gemini tree
# is ~15 MB (CLI binary + brain/ + logs), far over GitHub's 48 KB secret cap.
capture ANTIGRAVITY_TOKEN_TGZ_B64  .gemini/antigravity-cli/antigravity-oauth-token
echo "done."
