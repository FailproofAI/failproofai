#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Baked into each of the three job images. Replaces runner-entrypoint.sh, whose
# job was to clone the repo at run time and hand off to a script from that
# checkout. The image now IS the checkout, so this is what is left: work-dir
# detection → lock → staleness report → exec the baked job script.
#
# WHAT THIS TRADES AWAY, deliberately. The old split let a harness change reach
# the box through git with no image rebuild. That property is gone: CI publishes
# all three images on every push to main, and every cron line carries
# --pull=always, so the box tracks main by pulling rather than by cloning.
#
# WHAT THAT INTRODUCES, and how it is answered. If an image build breaks, the box
# keeps running the last good image and reports green against a commit from days
# ago — a failure the old shape could not have, because it re-cloned nightly. So
# the baked commit and its age are printed at the top of every run and exported
# for the report, and a stale image says so in Slack rather than in nobody's
# terminal. An unreadable build date is treated as stale, not as fresh.
# ─────────────────────────────────────────────────────────────────────────────
set -u

JOB="${CANARY_JOB:?CANARY_JOB missing — it is baked into each image}"
# Validated, not sanitised: this becomes a path component. A rejected name says
# so; a silently-rewritten one runs the wrong job.
case "$JOB" in
  *[!a-z0-9-]* | "" | -*) echo "✗ CANARY_JOB=\"$JOB\" is not a job name (lowercase, digits, dashes)" >&2; exit 1 ;;
esac

CLONE="${CANARY_CLONE:-/opt/failproofai}"
[ -d "$CLONE" ] || { echo "✗ no baked checkout at $CLONE — wrong image?" >&2; exit 1; }
SOCK=/var/run/docker.sock

# The ONE host work dir, mounted at an IDENTICAL path inside and out
# (-v "$HOME/fp-canary:$HOME/fp-canary"). Identical is load-bearing FOR THE
# CANARY: paths under it are used both for in-container file ops AND as
# sibling-container `-v` sources, which the HOST daemon resolves against the host
# filesystem. The socket is only mounted for the canary, so the discovery path
# that needs it stays behind the same "was CANARY_WORK passed" check as before.
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
export CANARY_WORK CANARY_JOB="$JOB" CANARY_CLONE="$CLONE"
mkdir -p "$CANARY_WORK/logs"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
# ONE log per run, named for the job. Exported so a job's own crash-note can
# tail the run it is dying in rather than opening a second log of its own.
export CANARY_LOG="$CANARY_WORK/logs/$JOB-$TS.log"
exec > >(tee -a "$CANARY_LOG") 2>&1

# ── what commit is this, and how old is it ──────────────────────────────────
SHA="${CANARY_BAKED_SHA:-unknown}"
BUILT="${CANARY_BAKED_AT:-unknown}"
AGE_DAYS="$(node -e '
  const b = process.argv[1];
  if (!b || b === "unknown") { process.stdout.write("?"); process.exit(0); }
  const t = Date.parse(b);
  if (Number.isNaN(t)) { process.stdout.write("?"); process.exit(0); }
  process.stdout.write(String(Math.floor((Date.now() - t) / 86400000)));
' "$BUILT" 2>/dev/null || echo "?")"
export CANARY_FP_SHA="$SHA" CANARY_IMAGE_AGE_DAYS="$AGE_DAYS"
# A job that cannot say how old its own code is has to assume the worst: the
# whole point of this line is to catch an image that stopped being rebuilt.
STALE_AFTER="${CANARY_STALE_AFTER_DAYS:-3}"
if [ "$AGE_DAYS" = "?" ] || [ "$AGE_DAYS" -gt "$STALE_AFTER" ] 2>/dev/null; then
  export CANARY_IMAGE_STALE=1
  echo "⚠️  this image was built from $SHA ${BUILT} (${AGE_DAYS} days ago) — the box may be testing stale code"
else
  export CANARY_IMAGE_STALE=0
fi
echo "── $JOB runner $TS (work dir: $CANARY_WORK, image $SHA built $BUILT) ──"

# Every job names its ref for its own report. With the image baked there is no
# ref to check out, so this is a DESCRIPTION rather than an instruction — and it
# names the image, because that is what actually ran.
REF_VAR="$(printf '%s' "$JOB" | tr 'a-z-' 'A-Z_')_REF"
eval "current=\${$REF_VAR:-}"
[ -n "$current" ] || eval "export $REF_VAR=\"image@$SHA\""

# One run of THIS JOB at a time. The lock file lives on the host work dir, so
# overlapping cron fires — yesterday's run wedged on a vendor CLI — share one
# lock even though each is its own container. Per job, so a wedged canary cannot
# swallow the translation run.
exec 9>"$CANARY_WORK/.lock-$JOB"
flock -n 9 || { echo "another $JOB run holds $CANARY_WORK/.lock-$JOB — exiting"; exit 0; }

# Box-level housekeeping, so every job gets it rather than whichever one
# remembered to.
find "$CANARY_WORK/logs" -name '*.log' -mtime +14 -delete 2>/dev/null || true

JOB_SCRIPT="$CLONE/integration-suite/local/jobs/$JOB.sh"
[ -f "$JOB_SCRIPT" ] || {
  echo "✗ no such job in this image: $JOB — it carries:" >&2
  ls -1 "$CLONE/integration-suite/local/jobs/" 2>/dev/null | sed 's/\.sh$/  /' >&2
  exit 1
}
exec bash "$JOB_SCRIPT"
