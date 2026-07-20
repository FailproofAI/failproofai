#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Tier-0 install probe — runs INSIDE the canary sandbox container.
#
# Installs/upgrades all 12 agent CLIs to @latest into the persistent HOME volume,
# then records which resolve to a runnable binary + their version. This is both
# the daily "fresh upgrade" step AND the Tier-0 canary signal (packaging/binary
# breaks show up here as a FAIL).
#
# Install methods verified 2026-07-16 (see failproofai-cli-canary-design.md).
# Vendor installers scatter binaries across several dirs, so we search an
# expanded PATH and fall back to a bounded `find` under $HOME.
#
# Output: a JSON array at $CANARY_RESULTS (default ~/canary-tier0.json) + a
# human table on stdout. Never `set -e` — one CLI failing must not abort the rest.
# ─────────────────────────────────────────────────────────────────────────────
set -u

RESULTS="${CANARY_RESULTS:-$HOME/canary-tier0.json}"
LOGDIR="${CANARY_LOGDIR:-$HOME/canary-logs}"
mkdir -p "$LOGDIR"

# Cover every dir the vendor installers are known to drop binaries into.
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.factory/bin:$HOME/.hermes/bin:$HOME/.cursor/bin:$HOME/.codex/bin:$HOME/bin:$PATH"

ROWS=()

probe() {
  local id="$1" bin="$2" vflag="$3" install="$4"
  echo "════════════════════ $id ════════════════════"
  local t0 t1 rc=1; t0=$SECONDS
  # Retry transient install failures. Flaky vendor CDNs / HTTP-2 stream resets are
  # common on ephemeral CI runners (e.g. factory's `curl … | sh` dropping the
  # download mid-stream with `curl: (18)`). Break as soon as the binary resolves;
  # otherwise give it up to 3 attempts so one bad download isn't a false FAIL.
  for attempt in 1 2 3; do
    bash -c "$install" >"$LOGDIR/$id.install.log" 2>&1
    rc=$?
    hash -r 2>/dev/null
    command -v "$bin" >/dev/null 2>&1 && break
    find "$HOME" -maxdepth 5 -name "$bin" -type f -perm -u+x 2>/dev/null | grep -q . && break
    [ "$attempt" -lt 3 ] && { echo "  ↻ $id install attempt $attempt failed (rc=$rc) — retrying in 5s"; sleep 5; }
  done
  t1=$SECONDS
  hash -r 2>/dev/null

  # Resolve the binary: PATH first, then a bounded find under $HOME.
  local resolved; resolved="$(command -v "$bin" 2>/dev/null || true)"
  if [ -z "$resolved" ]; then
    resolved="$(find "$HOME" -maxdepth 5 -name "$bin" -type f -perm -u+x 2>/dev/null | head -1)"
  fi

  local ver="" status="FAIL"
  if [ -n "$resolved" ]; then
    status="OK"
    ver="$("$resolved" $vflag 2>&1 | head -1 | tr -cd '[:alnum:] ._+:/-')"
  fi

  printf '  rc=%s  time=%ss  bin=%s  ver=%s  => %s\n' \
    "$rc" "$((t1 - t0))" "${resolved:-<none>}" "${ver:-<none>}" "$status"
  [ "$status" = FAIL ] && echo "  ↳ last install log lines:" && tail -3 "$LOGDIR/$id.install.log" | sed 's/^/    /'

  ROWS+=("$(printf '{"cli":"%s","status":"%s","binary":"%s","version":"%s","install_rc":%s,"secs":%s}' \
    "$id" "$status" "${resolved:-}" "${ver:-}" "$rc" "$((t1 - t0))")")
}

#      id           binary         --ver flag    install command (@latest)
probe  claude       claude         "--version"   'curl -fsSL https://claude.ai/install.sh | bash'
probe  codex        codex          "--version"   'npm install -g @openai/codex@latest'
probe  copilot      copilot        "--version"   'npm install -g @github/copilot@latest'
probe  cursor       cursor-agent   "--version"   'curl https://cursor.com/install -fsS | bash'
probe  opencode     opencode       "--version"   'npm install -g opencode-ai@latest'
probe  pi           pi             "--version"   'npm install -g @mariozechner/pi-coding-agent@latest'
probe  hermes       hermes         "--version"   'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'
probe  openclaw     openclaw       "--version"   'npm install -g openclaw@latest'
probe  factory      droid          "--version"   'curl -fsSL https://app.factory.ai/cli | sh'
probe  devin        devin          "--version"   'curl -fsSL https://cli.devin.ai/install.sh | bash'
probe  antigravity  agy            "--version"   'curl -fsSL https://antigravity.google/cli/install.sh | bash'
probe  goose        goose          "--version"   'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash'

# Emit JSON array.
{ printf '['; IFS=,; printf '%s' "${ROWS[*]}"; printf ']\n'; } > "$RESULTS"

echo
echo "════════════════════ TIER-0 SUMMARY ════════════════════"
ok=0; fail=0
for r in "${ROWS[@]}"; do
  case "$r" in *'"status":"OK"'*) ok=$((ok+1));; *) fail=$((fail+1));; esac
done
printf 'installed OK: %s / 12   failed: %s\n' "$ok" "$fail"
echo "results JSON: $RESULTS"
