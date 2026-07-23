#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Tier-0 install probe — runs INSIDE the canary sandbox container.
#
# Installs/upgrades the agent CLIs into the persistent HOME volume, then records
# which resolve to a runnable binary + their version. This is both the daily
# "fresh upgrade" step AND the Tier-0 canary signal (packaging/binary breaks show
# up here as a FAIL).
#
# CANARY_CHANNEL selects WHICH ref of each CLI to install:
#   stable (default) — what users get. All 12 CLIs.
#   beta             — the vendor's public pre-release ref, for early warning.
#                      Only the CLIs that actually publish one; the rest are
#                      SKIPPED, never silently re-installed at stable (that would
#                      be duplicate work reported as coverage).
#
# Every beta ref below was verified live against the vendor's registry/CDN on
# 2026-07-23; see ~/Desktop/failproofai-integration-suite-beta-channels-design.md
# for the evidence, lead times, and the CLIs that have no pre-release ref at all
# (factory, antigravity, pi, opencode, devin, hermes).
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
CHANNEL="${CANARY_CHANNEL:-stable}"
mkdir -p "$LOGDIR"

# Cover every dir the vendor installers are known to drop binaries into.
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.factory/bin:$HOME/.hermes/bin:$HOME/.cursor/bin:$HOME/.codex/bin:$HOME/bin:$PATH"

ROWS=()

# probe <id> <binary> <--version flag> <stable install cmd> [beta install cmd]
# Omitting the 5th argument declares "this CLI has no public pre-release ref",
# which skips it entirely on the beta channel.
probe() {
  local id="$1" bin="$2" vflag="$3" install="$4" beta="${5:-}"
  if [ "$CHANNEL" != stable ]; then
    if [ -z "$beta" ]; then
      echo "════════════════════ $id ════════════════════"
      echo "  skipped — no public pre-release ref for this CLI"
      return 0
    fi
    install="$beta"
  fi
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

#      id           binary         --ver flag    stable ref                                          beta ref (omitted = none exists)
#
# claude is the one CLI whose channels run BACKWARDS: nothing ships ahead of
# `latest`, which is the bleeding edge (~1 release/day). What exists is `stable`,
# ~13 days behind. So the stable leg pins `stable` — both to test what
# conservative users actually run and to stop a same-day Anthropic release
# red-lighting an unrelated PR — and `latest` becomes the early-warning ref.
probe  claude       claude         "--version"   'curl -fsSL https://claude.ai/install.sh | bash -s stable' \
                                                 'curl -fsSL https://claude.ai/install.sh | bash'
probe  codex        codex          "--version"   'npm install -g @openai/codex@latest' \
                                                 'npm install -g @openai/codex@alpha'
probe  copilot      copilot        "--version"   'npm install -g @github/copilot@latest' \
                                                 'npm install -g @github/copilot@prerelease'
# Cursor validates the channel server-side: only prod/lab/static/prod-stable-internal
# return 200, anything else is a 400. `lab` is Anysphere's own dogfood channel.
probe  cursor       cursor-agent   "--version"   'curl https://cursor.com/install -fsS | bash' \
                                                 'curl "https://cursor.com/install?channel=lab" -fsS | bash'
# opencode's beta/dev tags are ~31 branch snapshots a day (0.0.0-<branch>-<ts>),
# not release candidates — deliberately no beta ref.
probe  opencode     opencode       "--version"   'npm install -g opencode-ai@latest'
probe  pi           pi             "--version"   'npm install -g @mariozechner/pi-coding-agent@latest'
# hermes install.sh git-clones main, which is ALSO what every hermes user gets —
# its tags are markers nobody installs. So there is nothing ahead of us to probe,
# and pinning a tag would test something no user runs.
probe  hermes       hermes         "--version"   'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'
probe  openclaw     openclaw       "--version"   'npm install -g openclaw@latest' \
                                                 'npm install -g openclaw@beta'
probe  factory      droid          "--version"   'curl -fsSL https://app.factory.ai/cli | sh'
probe  devin        devin          "--version"   'curl -fsSL https://cli.devin.ai/install.sh | bash'
probe  antigravity  agy            "--version"   'curl -fsSL https://antigravity.google/cli/install.sh | bash'
# goose's canary is a ROLLING TAG (prerelease:false), selected by env var — not a
# GitHub prerelease, so channel detection that scans for prerelease:true misses it.
probe  goose        goose          "--version"   'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash' \
                                                 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CANARY=true CONFIGURE=false bash'

# Emit JSON array.
{ printf '['; IFS=,; printf '%s' "${ROWS[*]}"; printf ']\n'; } > "$RESULTS"

echo
echo "════════════════════ TIER-0 SUMMARY ════════════════════"
ok=0; fail=0
for r in "${ROWS[@]}"; do
  case "$r" in *'"status":"OK"'*) ok=$((ok+1));; *) fail=$((fail+1));; esac
done
printf 'channel: %s   installed OK: %s / %s   failed: %s\n' "$CHANNEL" "$ok" "$((ok + fail))" "$fail"
echo "results JSON: $RESULTS"
