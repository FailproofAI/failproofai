#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Baked into the runner image (Dockerfile.runner). Keep this THIN and stable:
# preflight → work-dir detection → lock → checkout → hand off to
# integration-suite/local/jobs/$CANARY_JOB.sh FROM THE CHECKOUT. Everything
# that evolves with the harness lives in the repo side of that split, so changes
# reach the box through git without anyone rebuilding this image.
#
# ONE IMAGE, SEVERAL JOBS. $CANARY_JOB selects which repo-side script runs
# (default `canary`, the integration suite; `translate` is the nightly doc
# translation). Adding a job is a new file under jobs/ — no rebuild — which is
# why the job name is resolved to a PATH here rather than through a case
# statement that would put job knowledge back in the baked layer.
#
# Everything below that is per-run state is keyed BY JOB — lock, clone, log.
# The lock especially: a single shared lock would let a canary leg wedged on a
# vendor CLI silently swallow the night's translation, and the swallow is a
# clean `exit 0` that reports nowhere.
# ─────────────────────────────────────────────────────────────────────────────
set -u

JOB="${CANARY_JOB:-canary}"
# Validated, not sanitised: this becomes a path component. A rejected name says
# so; a silently-rewritten one runs the wrong job.
case "$JOB" in
  *[!a-z0-9-]* | "" | -*) echo "✗ CANARY_JOB=\"$JOB\" is not a job name (lowercase, digits, dashes)" >&2; exit 1 ;;
esac

SOCK=/var/run/docker.sock

# The ONE host work dir, mounted at an IDENTICAL path inside and out
# (-v "$HOME/fp-canary:$HOME/fp-canary"). Identical is load-bearing FOR THE
# CANARY: paths under it are used both for in-container file ops AND as
# sibling-container `-v` sources, which the HOST daemon resolves against the
# host filesystem.
#
# THE SOCKET IS REQUIRED EXACTLY WHERE IT IS USED, not on principle. Only the
# canary spawns sibling containers; translate and docs-audit are plain
# containers, and demanding a docker socket from them would turn two of three
# cron lines into the long form for nothing. What the socket buys HERE is the
# work-dir recovery below — so it is needed only when CANARY_WORK was not
# passed. A job that genuinely needs docker asserts that for itself
# (jobs/canary.sh), which is where job knowledge belongs.
if [ -z "${CANARY_WORK:-}" ]; then
  [ -S "$SOCK" ] || {
    echo "✗ CANARY_WORK is not set and $SOCK is not mounted, so the work dir cannot be discovered." >&2
    echo "  Pass it:  -e CANARY_WORK=\"\$HOME/fp-canary\" -v \"\$HOME/fp-canary:\$HOME/fp-canary\"" >&2
    exit 1; }
  docker info >/dev/null 2>&1 || { echo "✗ cannot talk to the host docker daemon through $SOCK" >&2; exit 1; }
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
[ -d "$CANARY_WORK" ] || { echo "✗ CANARY_WORK=$CANARY_WORK is not a directory in this container — mount it: -v \"$CANARY_WORK:$CANARY_WORK\"" >&2; exit 1; }
export CANARY_WORK CANARY_JOB="$JOB"
mkdir -p "$CANARY_WORK/logs"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
# ONE log per run, named for the job. Exported so a job's own crash-note can
# tail the run it is dying in rather than opening a second log of its own.
export CANARY_LOG="$CANARY_WORK/logs/$JOB-$TS.log"
exec > >(tee -a "$CANARY_LOG") 2>&1
echo "── $JOB runner $TS (work dir: $CANARY_WORK) ──"

# One run of THIS JOB at a time. The lock file lives on the host work dir, so
# overlapping cron fires — yesterday's run wedged on a vendor CLI — share one
# lock even though each is its own container. Per job, so a wedged canary
# cannot swallow the translation run.
exec 9>"$CANARY_WORK/.lock-$JOB"
flock -n 9 || { echo "another $JOB run holds $CANARY_WORK/.lock-$JOB — exiting"; exit 0; }

slack_note() { # $1 = text; best-effort — the checkout phase's own crash-guard
  [ -n "${CANARY_SLACK_WEBHOOK:-}" ] || return 0
  local payload
  payload="$(printf '%s' "$1" | node -e 'const t=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify({text:t}))')"
  curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -X POST \
    -H 'Content-type: application/json' --data "$payload" "$CANARY_SLACK_WEBHOOK" 2>/dev/null || true
}

# Each job names its own ref through <JOB>_REF — CANARY_REF, TRANSLATE_REF —
# so the two can be pointed at different trees, and so this stays generic
# rather than knowing which jobs exist. Required, no default ON PURPOSE: a
# baked-in ref would silently keep running against a stale branch forever.
# install.sh writes both into the env file.
REF_VAR="$(printf '%s' "$JOB" | tr 'a-z-' 'A-Z_')_REF"
REF="$(eval "printf '%s' \"\${$REF_VAR:-}\"")"
[ -n "$REF" ] || { echo "✗ $REF_VAR missing from --env-file (set it to origin/main)" >&2; exit 1; }

CLONE="$CANARY_WORK/clone-$JOB"
export CANARY_CLONE="$CLONE"
GIT_URL="${CANARY_GIT_URL:-https://github.com/FailproofAI/failproofai.git}"

if [ ! -d "$CLONE/.git" ]; then
  git clone "$GIT_URL" "$CLONE" || { slack_note "🔥 canary box [$JOB]: clone of $GIT_URL failed — no run"; exit 1; }
fi
git -C "$CLONE" fetch --prune origin \
  || { slack_note "🔥 canary box [$JOB]: git fetch failed — no run today"; exit 1; }
{ git -C "$CLONE" checkout --detach --force "$REF" && git -C "$CLONE" reset --hard "$REF"; } \
  || { slack_note "🔥 canary box [$JOB]: checkout of $REF failed — no run"; exit 1; }
# `reset --hard` restores tracked files but leaves whatever the last run wrote
# that git does not track — for translate, that is generated pages for a locale
# whose source has since been deleted, which would be re-committed forever.
# NOT `-x`: ignored paths are the ones deliberately kept across runs
# (node_modules, and the translation cache symlinked into the work dir).
git -C "$CLONE" clean -fd >/dev/null 2>&1 || true

# Box-level housekeeping, so every job gets it rather than whichever one
# remembered to.
find "$CANARY_WORK/logs" -name '*.log' -mtime +14 -delete 2>/dev/null || true

JOB_SCRIPT="$CLONE/integration-suite/local/jobs/$JOB.sh"
[ -f "$JOB_SCRIPT" ] || {
  echo "✗ no such job: $JOB — $REF carries:" >&2
  ls -1 "$CLONE/integration-suite/local/jobs/" 2>/dev/null | sed 's/\.sh$/  /' >&2
  exit 1
}
exec bash "$JOB_SCRIPT"
