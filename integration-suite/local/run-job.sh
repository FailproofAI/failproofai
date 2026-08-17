#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ~/fp-canary/run.sh <job> — the one line cron actually calls.
#
# WHY THIS EXISTS. A crontab entry must be a SINGLE line: the format has no
# continuation, so the docker invocation cannot be wrapped. That produced a
# ~380-character line per job — unreadable in a crontab, and mangled by every
# chat client it was ever pasted through on the way to the person setting the
# box up. Here the command can breathe, and the crontab reads:
#
#   0 11 * * * $HOME/fp-canary/run.sh canary
#   0  2 * * * $HOME/fp-canary/run.sh translate
#   0  4 * * 1 $HOME/fp-canary/run.sh docs-audit
#
# It also OWNS ITS OWN LOG, which closes a trap: cron evaluates a `>>` redirect
# before the command runs, so a missing logs/ directory meant the job silently
# never started — and the container could not create the directory its own
# redirect needed. Redirecting in here happens after mkdir, in the right order.
# ─────────────────────────────────────────────────────────────────────────────
set -u

JOB="${1:-}"
W="${CANARY_WORK:-$HOME/fp-canary}"

case "$JOB" in
  # Only the canary reaches the host's docker — it builds the sandbox image and
  # runs the 12 probe containers as siblings. The other two are plain
  # containers, and handing them the daemon would be scope for nothing.
  # Timeouts sit an hour past the slowest observed first run, so a wedged vendor
  # CLI cannot still hold the lock at tomorrow's fire.
  canary)     SOCK=(-v /var/run/docker.sock:/var/run/docker.sock); TMO=9000 ;;
  translate)  SOCK=();                                             TMO=16200 ;;
  docs-audit) SOCK=();                                             TMO=1800 ;;
  *) echo "usage: $0 canary|translate|docs-audit" >&2; exit 2 ;;
esac

# ONE IMAGE PER JOB. They used to share a toolchain image that cloned the repo at
# run time; each now bakes the commit it runs, so they version independently —
# and only this one carries a docker client to go with the socket above.
#
# CANARY_IMAGE still overrides, for pinning a box to :sha-<short> after a bad
# publish or pointing a test box at a locally built tag. It is read per job so a
# pin cannot silently redirect the other two at the same image.
IMAGE_VAR="CANARY_IMAGE_$(printf '%s' "$JOB" | tr 'a-z-' 'A-Z_')"
IMAGE="${!IMAGE_VAR:-${CANARY_IMAGE:-ghcr.io/failproofai/failproofai-$JOB:latest}}"

[ -f "$W/secrets.env" ] || { echo "✗ no credentials at $W/secrets.env" >&2; exit 1; }

mkdir -p "$W/logs"
exec >> "$W/logs/cron-$JOB.log" 2>&1
echo "── $(date -u +%Y-%m-%dT%H:%M:%SZ) starting $JOB ──"

# --pull=always: the box tracks the published image with nothing to re-run.
exec timeout "$TMO" docker run --rm --pull=always --name "fp-$JOB" \
  -e CANARY_JOB="$JOB" \
  -e CANARY_WORK="$W" \
  "${SOCK[@]}" \
  -v "$W:$W" \
  --env-file "$W/secrets.env" \
  "$IMAGE"
