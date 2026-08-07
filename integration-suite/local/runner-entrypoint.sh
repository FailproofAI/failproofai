#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Baked into the runner image (Dockerfile.runner). Keep this THIN and stable:
# preflight → work-dir detection → lock → checkout $CANARY_REF → hand off to
# integration-suite/local/runner-daily.sh FROM THE CHECKOUT. Everything that
# evolves with the harness lives in the repo side of that split, so changes
# reach the box through git without anyone rebuilding this image.
# ─────────────────────────────────────────────────────────────────────────────
set -u

SOCK=/var/run/docker.sock
[ -S "$SOCK" ] || { echo "✗ docker socket not mounted — add: -v /var/run/docker.sock:/var/run/docker.sock" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "✗ cannot talk to the host docker daemon through $SOCK" >&2; exit 1; }

# The ONE host work dir, mounted at an IDENTICAL path inside and out
# (-v "$HOME/fp-canary:$HOME/fp-canary"). Identical is load-bearing: paths
# under it are used both for in-container file ops AND as sibling-container
# `-v` sources, which the HOST daemon resolves against the host filesystem.
# Auto-detected from this container's own mounts; CANARY_WORK settles it if
# more than one identical-path mount is present.
if [ -z "${CANARY_WORK:-}" ]; then
  parity="$(docker inspect "$(cat /etc/hostname)" \
      --format '{{range .Mounts}}{{if eq .Source .Destination}}{{.Destination}}{{"\n"}}{{end}}{{end}}' 2>/dev/null \
    | grep -v '^/var/run/docker.sock$' | grep -v '^$' || true)"
  case "$(printf '%s\n' "$parity" | grep -c .)" in
    1) CANARY_WORK="$parity" ;;
    0) echo "✗ no work dir found — mount one at an identical path: -v \"\$HOME/fp-canary:\$HOME/fp-canary\"" >&2; exit 1 ;;
    *) echo "✗ several identical-path mounts found — set CANARY_WORK to the one to use:" >&2
       printf '%s\n' "$parity" >&2; exit 1 ;;
  esac
fi
export CANARY_WORK
mkdir -p "$CANARY_WORK/logs"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
exec > >(tee -a "$CANARY_WORK/logs/run-$TS.log") 2>&1
echo "── canary runner $TS (work dir: $CANARY_WORK) ──"

# One run at a time. The lock file lives on the host work dir, so overlapping
# cron fires — yesterday's run wedged on a vendor CLI — share one lock even
# though each is its own container.
exec 9>"$CANARY_WORK/.lock"
flock -n 9 || { echo "another canary run holds $CANARY_WORK/.lock — exiting"; exit 0; }

slack_note() { # $1 = text; best-effort — the checkout phase's own crash-guard
  [ -n "${CANARY_SLACK_WEBHOOK:-}" ] || return 0
  local payload
  payload="$(printf '%s' "$1" | node -e 'const t=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify({text:t}))')"
  curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -X POST \
    -H 'Content-type: application/json' --data "$payload" "$CANARY_SLACK_WEBHOOK" 2>/dev/null || true
}

# Required, no default ON PURPOSE: a baked-in ref would silently keep probing a
# stale branch after the daemon branch merges to main. The env file states it.
: "${CANARY_REF:?CANARY_REF missing from --env-file (origin/failproofaid until #632 merges, then origin/main)}"
CLONE="$CANARY_WORK/clone"
GIT_URL="${CANARY_GIT_URL:-https://github.com/FailproofAI/failproofai.git}"

if [ ! -d "$CLONE/.git" ]; then
  git clone "$GIT_URL" "$CLONE" || { slack_note "🔥 canary box: clone of $GIT_URL failed — no run"; exit 1; }
fi
git -C "$CLONE" fetch --prune origin \
  || { slack_note "🔥 canary box: git fetch failed — no run today"; exit 1; }
{ git -C "$CLONE" checkout --detach --force "$CANARY_REF" && git -C "$CLONE" reset --hard "$CANARY_REF"; } \
  || { slack_note "🔥 canary box: checkout of $CANARY_REF failed — no run"; exit 1; }

exec bash "$CLONE/integration-suite/local/runner-daily.sh"
