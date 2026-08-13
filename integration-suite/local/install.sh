#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# install.sh — set the box up in ONE command, for every scheduled job.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/FailproofAI/failproofai/main/integration-suite/local/install.sh) ~/secrets.env
#
# Builds the runner image, creates the work dir, installs the env file, and
# writes ONE CRON LINE PER JOB. Idempotent: re-running upgrades the image and
# rewrites those lines rather than adding a second set.
#
# TWO JOBS SHARE THIS BOX, one image and one env file between them:
#
#   canary     the daily CLI integration suite   (default 11:00, ~1h first run)
#   translate  the nightly doc translation       (default 02:00, ~2h first run)
#
# Both moved off GitHub Actions, where runner minutes were their entire cost.
# They are scheduled far apart and hold SEPARATE locks, so neither can swallow
# the other: a canary wedged on a vendor CLI must not silently cost a night of
# translation.
#
# WHY AN INSTALLER AT ALL. The manual path is several commands, and most of them
# have a failure mode that is silent for a day: a work dir mounted at a
# different path inside than out, a secrets file with a stale ref, and a cron
# line that runs but reports nowhere. Each is caught here, at install time,
# in front of a person — instead of at 02:00 tomorrow in front of nobody.
#
# The person running this is not expected to know anything about either job.
# Whoever HAS the credentials fills in secrets.env and sends it; this script
# checks it is complete FOR EACH JOB IT IS ABOUT TO SCHEDULE, and refuses to
# schedule one that cannot work or cannot report.
#
# Flags:
#   --jobs a,b        which jobs to install (default: canary,translate)
#   --now <job>       run that job immediately after installing (foreground)
#   --no-cron         set everything up but do not touch the crontab
#   --dry-run         print what would happen; touch nothing
#   --at-canary "M H"     cron minute and hour for canary    (default "0 11")
#   --at-translate "M H"  cron minute and hour for translate (default "0 2")
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

IMAGE="failproofai-canary-runner"
WORK="${CANARY_WORK:-$HOME/fp-canary}"
GIT_URL="${CANARY_GIT_URL:-https://github.com/FailproofAI/failproofai.git}"
RAW_BASE="https://raw.githubusercontent.com/FailproofAI/failproofai/main/integration-suite/local"
# Marker, not the whole command: cron lines are rewritten on every install, so
# they have to be findable even after the command they contain changes. Per job,
# or installing one would strip the other's line.
CRON_MARKER_BASE="# failproofai-canary"
ALL_JOBS="canary translate"

# Every variable each job cannot run without. The webhook is in both lists on
# purpose — a job that runs and reports nowhere is worse than no job, because
# it looks like coverage.
REQUIRED_canary="CANARY_REF CANARY_LLM_API_KEY COPILOT_GITHUB_TOKEN CANARY_SLACK_WEBHOOK"
REQUIRED_translate="TRANSLATE_REF TRANSLATE_LLM_API_KEY TRANSLATE_LLM_BASE_URL TRANSLATE_GITHUB_TOKEN CANARY_SLACK_WEBHOOK"

SECRETS_SRC="" ; RUN_NOW="" ; DO_CRON=1 ; DRY=0
JOBS="$ALL_JOBS" ; AT_canary="0 11" ; AT_translate="0 2"
while [ $# -gt 0 ]; do
  case "$1" in
    --jobs)         JOBS="$(echo "${2:?--jobs needs a value, e.g. --jobs canary,translate}" | tr ',' ' ')"; shift ;;
    --now)          RUN_NOW="${2:?--now needs a job name, e.g. --now canary}"; shift ;;
    --no-cron)      DO_CRON=0 ;;
    --dry-run)      DRY=1 ;;
    --at-canary)    AT_canary="${2:?--at-canary needs a value, e.g. --at-canary \"0 11\"}"; shift ;;
    --at-translate) AT_translate="${2:?--at-translate needs a value, e.g. --at-translate \"0 2\"}"; shift ;;
    -h|--help)      sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)             echo "unknown flag: $1" >&2; exit 2 ;;
    *)              SECRETS_SRC="$1" ;;
  esac
  shift
done

for j in $JOBS ${RUN_NOW:-}; do
  case " $ALL_JOBS " in *" $j "*) ;; *) echo "unknown job: $j (known: ${ALL_JOBS// /, })" >&2; exit 2 ;; esac
done

say()  { printf '  %s\n' "$*"; }
# Two kinds of statement, deliberately distinguished. `ok` reports something
# CHECKED — true in a dry run as much as a real one, because the check actually
# ran. `did` reports something CHANGED, so under --dry-run it must not claim a ✓
# for work that did not happen: a false success report is the exact failure mode
# this whole canary exists to catch, and it would be embarrassing here.
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
did()  { if [ "${DRY:-0}" = 1 ]; then printf '  \033[2m· would: %s\033[0m\n' "$*";
         else printf '  \033[32m✓\033[0m %s\n' "$*"; fi; }
die()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then say "would: $*"; else "$@"; fi; }

# ── 1. preflight ─────────────────────────────────────────────────────────────
# Everything here fails LOUDLY now rather than quietly at 06:17. Docker is the
# only host dependency the box has, so it is the only thing worth checking.
step "Checking the machine"
command -v docker >/dev/null 2>&1 \
  || die "docker is not installed. Install Docker, then re-run this."
docker info >/dev/null 2>&1 \
  || die "docker is installed but this user cannot reach it.
       Try:  sudo usermod -aG docker \$USER   then log out and back in."
ok "docker reachable"

# The runner drives the HOST's docker through this socket (sibling containers,
# not docker-in-docker). No socket, no canary.
[ -S /var/run/docker.sock ] \
  || die "/var/run/docker.sock is missing — the runner needs the host docker socket."
ok "docker socket present"

# ~20 GB: sandbox image + 12 agent CLIs + the daemon build's cargo cache.
avail_kb="$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
if [ "${avail_kb:-0}" -lt 20971520 ]; then
  say "⚠ only $((avail_kb/1048576)) GB free on \$HOME — the canary wants ~20 GB"
else
  ok "$((avail_kb/1048576)) GB free"
fi

# ── 2. work dir ──────────────────────────────────────────────────────────────
step "Preparing $WORK"
run mkdir -p "$WORK"
did "work dir ready"

# ── 3. secrets ───────────────────────────────────────────────────────────────
# Three cases: a file was handed to us, one is already installed, or there is
# none — in which case we fetch the template, say exactly what to fill in, and
# stop. Never schedule a job that cannot possibly work.
step "Installing credentials"
if [ -n "$SECRETS_SRC" ]; then
  [ -f "$SECRETS_SRC" ] || die "no such file: $SECRETS_SRC"
  run cp "$SECRETS_SRC" "$WORK/secrets.env"
  run chmod 600 "$WORK/secrets.env"
  did "installed from $SECRETS_SRC (mode 600)"
elif [ -f "$WORK/secrets.env" ]; then
  run chmod 600 "$WORK/secrets.env"
  did "using the existing $WORK/secrets.env"
else
  say "no secrets file given and none installed — fetching the template"
  if [ "$DRY" = 0 ]; then
    curl -fsSL "$RAW_BASE/secrets.env.example" -o "$WORK/secrets.env" \
      || die "could not download the template from $RAW_BASE"
    chmod 600 "$WORK/secrets.env"
  fi
  die "Fill in $WORK/secrets.env, then re-run this installer.
       Ask whoever set up the gateway for: CANARY_LLM_API_KEY,
       COPILOT_GITHUB_TOKEN, TRANSLATE_LLM_API_KEY, TRANSLATE_LLM_BASE_URL,
       TRANSLATE_GITHUB_TOKEN and CANARY_SLACK_WEBHOOK."
fi

# ── 4. validate the env file ─────────────────────────────────────────────────
# A `docker --env-file` is KEY=value lines, so it can be read without sourcing
# it — which matters, because sourcing a file full of credentials to check it is
# a worse idea than parsing it.
#
# Checked PER JOB, and only for the jobs about to be scheduled: someone
# installing just the canary should not be made to produce a translation PAT,
# and someone installing just the translation should not be blocked on vendor
# CLI credentials.
if [ "$DRY" = 0 ]; then
  getvar() { sed -n "s/^$1=//p" "$WORK/secrets.env" | tail -1; }

  for j in $JOBS; do
    eval "required=\$REQUIRED_$j"
    missing=""
    for v in $required; do
      [ -n "$(getvar "$v")" ] || missing="$missing $v"
    done
    [ -z "$missing" ] || die "the $j job needs these, and they are empty in $WORK/secrets.env:$missing

       CANARY_SLACK_WEBHOOK is required on purpose — a job that runs and
       reports nowhere is worse than no job, because it looks like coverage.
       To install without this job:  --jobs $(echo "$JOBS" | tr ' ' '\n' | grep -v "^$j\$" | paste -sd, -)"
    ok "$j: credentials complete"
  done

  CANARY_REF="$(getvar CANARY_REF)"
  # The shipped template said origin/failproofaid before that branch merged.
  # Left alone it points the box at a ref that no longer moves, so a job would
  # run against a frozen tree forever and never say so.
  for v in CANARY_REF TRANSLATE_REF; do
    case "$(getvar "$v")" in
      origin/failproofaid)
        die "$v is still origin/failproofaid — that branch has merged.
       Set it to:  $v=origin/main" ;;
    esac
  done
  [ -n "$CANARY_REF" ] || CANARY_REF="origin/main"
else
  CANARY_REF="origin/main"
fi

# ── 5. build the runner image ────────────────────────────────────────────────
# Straight from the git URL — no clone on this machine. Docker takes
# `<repo>#<ref>:<subdir>` as a build context, and the runner re-clones the repo
# itself on every run anyway, so a checkout here would only go stale.
step "Building the runner image"
BUILD_REF="${CANARY_REF#origin/}"
run docker build -t "$IMAGE" \
  -f Dockerfile.runner "$GIT_URL#$BUILD_REF:integration-suite/local"
did "image $IMAGE built from $BUILD_REF"

# ── 6. cron ──────────────────────────────────────────────────────────────────
# The work dir is mounted at an IDENTICAL path inside and out. That is
# load-bearing: paths under it are used both for in-container file ops and as
# sibling-container `-v` sources, which the HOST daemon resolves against the
# host filesystem. Change either side and the sandbox mounts nothing.
job_cmd() { # $1 = job
  printf 'docker run --rm -e CANARY_JOB=%s -v /var/run/docker.sock:/var/run/docker.sock -v "%s:%s" --env-file "%s/secrets.env" %s' \
    "$1" "$WORK" "$WORK" "$WORK" "$IMAGE"
}

if [ "$DO_CRON" = 1 ]; then
  step "Scheduling"
  # cron fires in the HOST's local timezone, not UTC — say which, because
  # "02:00" read as UTC on an IST box is 07:30 and the person reading this is
  # the one who will be surprised.
  TZ_NAME="$( (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || date +%Z) | head -1)"
  for j in $JOBS; do
    eval "at=\$AT_$j"
    marker="$CRON_MARKER_BASE-$j"
    LINE="$at * * * $(job_cmd "$j") >/dev/null 2>&1 $marker"
    if [ "$DRY" = 1 ]; then
      say "would install cron line:"; say "$LINE"
    else
      # Drop the line we installed before FOR THIS JOB, then add the current
      # one — so a re-install upgrades the schedule instead of stacking, and
      # installing one job never strips the other's line.
      { crontab -l 2>/dev/null | grep -vF "$marker" || true; echo "$LINE"; } | crontab -
      did "$j — daily at $(echo "$at" | awk '{printf "%02d:%02d", $2, $1}') $TZ_NAME"
    fi
  done
  if [ "$DRY" = 0 ]; then
    say "cron output goes to /dev/null on purpose: a job that dies before it can"
    say "report sends its own Slack crash-note with the log tail."
  fi
else
  step "Skipping cron (--no-cron)"
fi

# ── 7. done ──────────────────────────────────────────────────────────────────
step "Done"
say "work dir   $WORK"
say "logs       $WORK/logs/        (<job>-<timestamp>.log, pruned after 14 days)"
say "state      $WORK/state/       (which CLI was last green, at which version)"
say "cache      $WORK/translate/   (the translation cache — a 13 KB file)"
printf '\n'
# The runner is root inside the container, so everything it creates under the
# work dir is root-owned on the host. Harmless — the next run is root too — but
# it surprises the first person who tries to read a log or delete the clone, so
# say it here rather than let them find out with a permission error.
say "Everything under the work dir except secrets.env is written by the container"
say "as root, so reading a log or clearing the clone needs sudo:"
say "  sudo tail -f $WORK/logs/\$(sudo ls -t $WORK/logs | head -1)"
printf '\n'
say "Run one now, in the foreground:"
for j in $JOBS; do say "  $(job_cmd "$j")"; done
printf '\n'
say "FIRST RUNS ARE LONG, both of them, and only the first:"
say "  canary     ~1h  — the version gate is empty, so it probes all 12 CLIs."
say "                    After that only a CLI whose version CHANGED is"
say "                    re-probed, so normal days are minutes."
say "  translate  ~2h  — the cache is empty, so it translates the whole corpus"
say "                    in 14 languages. After that only pages whose ENGLISH"
say "                    source changed are re-translated, so normal nights"
say "                    are minutes, and quiet ones do nothing at all."
printf '\n'
say "Both post to Slack every run, including the quiet ones — so silence means"
say "the box did not run, not that everything was fine."

if [ -n "$RUN_NOW" ]; then
  step "Running $RUN_NOW now"
  # Spelled out rather than reusing job_cmd: that one emits a line for a HUMAN
  # to paste into a shell, so its paths carry literal quotes. Word-splitting it
  # back apart here would hand docker a path with quote characters in it.
  run docker run --rm -e "CANARY_JOB=$RUN_NOW" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$WORK:$WORK" \
    --env-file "$WORK/secrets.env" \
    "$IMAGE"
fi
