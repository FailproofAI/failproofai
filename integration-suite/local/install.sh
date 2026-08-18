#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# install.sh — set the box up in ONE command, for every scheduled job.
#
#   git clone https://github.com/FailproofAI/failproofai.git
#   cd failproofai
#   bash integration-suite/local/install.sh ~/secrets.env
#
# There is also a no-clone form for a box you touch once:
#   bash <(curl -fsSL https://raw.githubusercontent.com/FailproofAI/failproofai/main/integration-suite/local/install.sh) ~/secrets.env
#
# Builds the runner image, creates the work dir, installs the env file, and
# writes ONE CRON LINE PER JOB. Idempotent: re-running upgrades the image and
# rewrites those lines rather than adding a second set.
#
# FOUR JOBS SHARE THIS BOX, one image and one env file between them:
#
#   canary      the daily CLI integration suite  (default 11:00, ~1h first run)
#   contracts   the daily hook-contract lab      (default 06:00, ~1h first run)
#               Drives every CLI through one boring tool call and records what
#               each vendor actually sent, so a renamed payload key is caught
#               here rather than by a customer whose policies silently stopped
#               firing. Publishes a pack when — and only when — something moved.
#   translate   the nightly doc translation      (default 02:00, ~2h first run)
#   docs-audit  a weekly sweep of the docs       (default Mondays 04:00, ~1 min)
#               Posts to Slack AND keeps one "[auto] docs audit" tracking issue
#               current — opened when there is something to do, closed when a
#               week comes back clean.
#
# The canary and translate moved off GitHub Actions, where runner minutes were
# their entire cost. They are scheduled far apart and hold SEPARATE locks, so none can
# swallow another: a canary wedged on a vendor CLI must not silently cost a
# night of translation.
#
# docs-audit is the cheap one — no gateway, no sibling containers, and an
# issues-only token. It reads the docs tree and git history and posts what it found:
# pages nobody has touched in months, pages in the nav that are gone, pages in
# no nav at all, links to things that were renamed, translations behind their
# English source. None of that fails a build, which is why a per-PR gate never
# catches it.
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
#   --jobs a,b        which jobs to install (default: all three)
#   --now <job>       run that job immediately after installing (foreground)
#   --no-cron         set everything up but do not touch the crontab
#   --build-local     build the image from this checkout instead of pulling it
#   --dry-run         print what would happen; touch nothing
#   --at <job> <spec> when that job runs. A spec is "M H" (daily) or a full
#                     five-field cron expression, which is how weekly is said.
#                       --at canary "0 11"          daily at 11:00
#                       --at docs-audit "0 4 * * 1" Mondays at 04:00
#                     --at-canary / --at-contracts / --at-translate /
#                     --at-docs-audit also work.
# Defaults: canary "0 11", contracts "0 6", translate "0 2", docs-audit "0 4 * * 1".
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# The published images — ONE PER JOB. `--pull=always` in every cron line means
# the box tracks them with nothing to re-run: no clone, no rebuild, no installer
# second visit. They replaced a single shared toolchain image when the repo
# started being baked in, which is also what lets only the canary carry a docker
# client while the other two cannot reach the host daemon at all.
IMAGE_PREFIX="${CANARY_IMAGE_PREFIX:-ghcr.io/failproofai/failproofai-}"
image_for() { printf '%s%s:%s' "$IMAGE_PREFIX" "$1" "${CANARY_IMAGE_TAG:-latest}"; }
WORK="${CANARY_WORK:-$HOME/fp-canary}"
GIT_URL="${CANARY_GIT_URL:-https://github.com/FailproofAI/failproofai.git}"
# Marker, not the whole command: cron lines are rewritten on every install, so
# they have to be findable even after the command they contain changes. Per job,
# or installing one would strip the other's line.
CRON_MARKER_BASE="# failproofai-canary"
ALL_JOBS="canary contracts translate docs-audit"

# A job name is a path component (jobs/<name>.sh) and so may carry a dash;
# a shell variable name may not. One conversion, used everywhere a per-job
# variable is looked up, rather than a rule to remember at each site.
vn() { printf '%s' "${1//-/_}"; }

# Every variable each job cannot run without. The webhook is required by the
# jobs whose only output IS the report — a job that runs and reports nowhere is
# worse than no job, because it looks like coverage. docs-audit needs nothing
# else: it reads the tree and git history and posts what it found, so it is the
# one job installable on a machine holding no credentials at all.
REQUIRED_canary="CANARY_REF CANARY_LLM_API_KEY COPILOT_GITHUB_TOKEN CANARY_SLACK_WEBHOOK"
# translate is the exception: it does NOT post to Slack. Its output is the pull
# request it opens, so there is nothing a chat message would add that the PR
# list does not already say.
REQUIRED_translate="TRANSLATE_REF TRANSLATE_LLM_API_KEY TRANSLATE_LLM_BASE_URL TRANSLATE_GITHUB_TOKEN"
REQUIRED_docs_audit="DOCS_AUDIT_REF CANARY_SLACK_WEBHOOK DOCS_AUDIT_GITHUB_TOKEN"
# contracts drives the same CLIs as the canary and needs the same credentials to
# reach them. CONTRACTS_REPO / CONTRACTS_TOKEN are deliberately NOT required:
# without them the lab still runs and still reports to Slack, it just does not
# publish — which is exactly the state to be installable in before the pack repo
# exists.
REQUIRED_contracts="CONTRACTS_REF CANARY_LLM_API_KEY COPILOT_GITHUB_TOKEN CANARY_SLACK_WEBHOOK"

SECRETS_SRC="" ; RUN_NOW="" ; DO_CRON=1 ; DRY=0 ; BUILD_LOCAL=0
JOBS="$ALL_JOBS" ; AT_canary="0 11" ; AT_contracts="0 6" ; AT_translate="0 2" ; AT_docs_audit="0 4 * * 1"
while [ $# -gt 0 ]; do
  case "$1" in
    --jobs)          JOBS="$(echo "${2:?--jobs needs a value, e.g. --jobs canary,translate}" | tr ',' ' ')"; shift ;;
    --now)           RUN_NOW="${2:?--now needs a job name, e.g. --now canary}"; shift ;;
    --no-cron)       DO_CRON=0 ;;
    --build-local)   BUILD_LOCAL=1 ;;
    --dry-run)       DRY=1 ;;
    --at)            # --at <job> <spec>
                     at_job="$(vn "${2:?--at needs a job and a spec, e.g. --at canary \"0 11\"}")"
                     eval "AT_$at_job=\"\${3:?--at needs a spec after the job name}\""; shift 2 ;;
    --at-canary)     AT_canary="${2:?--at-canary needs a value, e.g. --at-canary \"0 11\"}"; shift ;;
    --at-contracts)  AT_contracts="${2:?--at-contracts needs a value, e.g. --at-contracts \"0 6\"}"; shift ;;
    --at-translate)  AT_translate="${2:?--at-translate needs a value, e.g. --at-translate \"0 2\"}"; shift ;;
    --at-docs-audit) AT_docs_audit="${2:?--at-docs-audit needs a value, e.g. --at-docs-audit \"0 4 * * 1\"}"; shift ;;
    -h|--help)       sed -n '2,58p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)              echo "unknown flag: $1" >&2; exit 2 ;;
    *)               SECRETS_SRC="$1" ;;
  esac
  shift
done

for j in $JOBS ${RUN_NOW:-}; do
  case " $ALL_JOBS " in *" $j "*) ;; *) echo "unknown job: $j (known: ${ALL_JOBS// /, })" >&2; exit 2 ;; esac
done

# A schedule is either "M H" (daily, the form the box shipped with) or a full
# five-field cron expression — weekly needs the day-of-week field, and silently
# appending "* * *" to a five-field spec would schedule it wrong rather than
# refuse it.
normalize_cron() { # $1 = spec -> five fields
  case "$(printf '%s' "$1" | wc -w | tr -d ' ')" in
    2) printf '%s * * *' "$1" ;;
    5) printf '%s' "$1" ;;
    *) echo "✗ schedule \"$1\" is neither \"M H\" nor a five-field cron expression" >&2; exit 2 ;;
  esac
}
describe_cron() { # $1 = five fields -> human
  printf '%s' "$1" | awk '{
    t = sprintf("%02d:%02d", $2, $1)
    split("Sunday Monday Tuesday Wednesday Thursday Friday Saturday", d, " ")
    if ($5 != "*")      printf "%s, weekly on %s", t, ($5 ~ /^[0-6]$/ ? d[$5+1] : $5)
    else if ($3 != "*") printf "%s, monthly on day %s", t, $3
    else                printf "%s, daily", t
  }'
}

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
  # Re-running the installer on a box that is already set up is the UPGRADE
  # path, and the obvious way to type it names the file already in place —
  # `cp x x` fails, and a failed install here is a box left half-migrated.
  if [ "$SECRETS_SRC" -ef "$WORK/secrets.env" ]; then
    say "credentials already at $WORK/secrets.env — leaving them alone"
  else
    run cp "$SECRETS_SRC" "$WORK/secrets.env"
  fi
  run chmod 600 "$WORK/secrets.env"
  did "installed from $SECRETS_SRC (mode 600)"
elif [ -f "$WORK/secrets.env" ]; then
  run chmod 600 "$WORK/secrets.env"
  did "using the existing $WORK/secrets.env"
else
  # No template file ships in this repo, and none is fetched. A file that LOOKS
  # like a credentials file is one `git add -A` from being committed by whoever
  # fills it in, so the variable list is printed instead — derived from the same
  # REQUIRED_ lists the checks below use, which means it cannot drift out of
  # date the way a checked-in example silently does.
  say "no credentials file given, and none installed at $WORK/secrets.env"
  printf '\n'
  say "Create one — plain KEY=value lines, no quotes — with:"
  printf '\n'
  for j in $JOBS; do
    eval "required=\$REQUIRED_$(vn "$j")"
    printf '    \033[2m# %s\033[0m\n' "$j"
    for v in $required; do
      case "$v" in
        *_REF) printf '    %s=origin/main\n' "$v" ;;
        *)     printf '    %s=\n' "$v" ;;
      esac
    done
  done
  printf '\n'
  die "Then re-run this installer with the path to it:
         bash \$0 ~/secrets.env

       Whoever set up the gateway has the LLM values; the GitHub tokens are
       fine-grained PATs on this repo (translate needs Contents + Pull requests,
       docs-audit needs Issues). Keep the file at mode 600 and OUT of any
       checkout."
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
    eval "required=\$REQUIRED_$(vn "$j")"
    missing=""
    for v in $required; do
      [ -n "$(getvar "$v")" ] || missing="$missing $v"
    done
    if [ -n "$missing" ]; then
      # Only explain the webhook when the webhook is what is missing. Printing
      # that rationale under a list that does not contain it reads as though
      # the job wants a webhook it does not — and `translate` deliberately
      # does not, since it reports by opening a pull request.
      why=""
      case " $missing " in *" CANARY_SLACK_WEBHOOK "*)
        why="

       CANARY_SLACK_WEBHOOK is required on purpose — a job that runs and
       reports nowhere is worse than no job, because it looks like coverage." ;;
      esac
      die "the $j job needs these, and they are empty in $WORK/secrets.env:$missing$why

       To install without this job:  --jobs $(echo "$JOBS" | tr ' ' '\n' | grep -v "^$j\$" | paste -sd, -)"
    fi
    ok "$j: credentials complete"
  done

  # A ref that no longer moves is the whole silent-failure class this installer
  # exists for: the box runs happily against a frozen tree forever and says
  # nothing. Checking the NAME against one known-stale branch only ever caught
  # that one branch — a merged feature branch (`origin/feat/…`) sailed through.
  # So ask the REMOTE whether the branch still exists, which catches every
  # deleted branch without naming any of them, and warn on anything that is not
  # main, which is a legitimate choice for a one-off but not for a cron line.
  for j in $JOBS; do
    v="$(printf '%s' "$(vn "$j")" | tr 'a-z' 'A-Z')_REF"
    ref="$(getvar "$v")"
    [ -n "$ref" ] || continue
    branch="${ref#origin/}"
    if ! git ls-remote --heads "$GIT_URL" "$branch" 2>/dev/null | grep -q .; then
      die "$v is $ref, and $branch does not exist on the remote.
       It was probably merged and deleted, so the box would run against a
       frozen tree forever and never say so.
       Set it to:  $v=origin/main"
    fi
    [ "$ref" = "origin/main" ] \
      || say "⚠ $v is $ref, not origin/main — deliberate for a one-off, rarely right for a cron line"
  done
  CANARY_REF="$(getvar CANARY_REF)"
  [ -n "$CANARY_REF" ] || CANARY_REF="origin/main"
else
  CANARY_REF="origin/main"
fi

# ── 4b. the cron wrapper ─────────────────────────────────────────────────────
# It owns its own log, which closes a real trap: cron evaluates a `>>` redirect
# BEFORE the command runs, so a missing logs/ directory meant the job silently
# never started — and the container could not create the directory its own
# redirect needed.
step "Installing the runner script"
WRAPPER_SRC="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)/run-job.sh"
if [ -f "$WRAPPER_SRC" ]; then
  run cp "$WRAPPER_SRC" "$WORK/run.sh"
else
  run curl -fsSL "https://raw.githubusercontent.com/FailproofAI/failproofai/main/integration-suite/local/run-job.sh" -o "$WORK/run.sh"
fi
run chmod +x "$WORK/run.sh"
did "$WORK/run.sh"

# ── 5. the runner image ──────────────────────────────────────────────────────
# Normally there is nothing to build: the image is published to GHCR and every
# cron line carries `--pull=always`, so the box tracks it without anyone
# re-running anything. `--build-local` builds from this checkout instead, for
# testing a change to the baked entrypoint before it is published.
step "Job images"
for j in $JOBS; do
  img="$(image_for "$j")"
  if [ "${BUILD_LOCAL:-0}" = 1 ]; then
    HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
    ROOT="$(cd "$HERE/../.." 2>/dev/null && pwd || true)"
    [ -n "$HERE" ] && [ -f "$HERE/Dockerfile.$j" ] \
      || die "--build-local needs to run from a checkout; $0 is not inside one"
    # The build context is the REPO ROOT, because the image bakes the checkout.
    # That is also why this path is for testing only: the repo's .dockerignore
    # and each Dockerfile's own assertion keep run-time credential files out of
    # a context that, unlike CI's, is somebody's working tree.
    img="${CANARY_LOCAL_IMAGE_PREFIX:-failproofai-}$j:local"
    run docker build -t "$img" -f "$HERE/Dockerfile.$j" \
      --build-arg "FP_SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)" \
      --build-arg "BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ROOT"
    eval "export CANARY_IMAGE_$(vn "$j" | tr 'a-z' 'A-Z')=\"$img\""
    did "built $img from this checkout"
  else
    # Pulled now rather than at 02:00, so a bad tag or a private package is a
    # problem in front of a person instead of a silent missed run.
    run docker pull -q "$img" >/dev/null 2>&1 || true
    if [ "$DRY" = 0 ] && ! docker image inspect "$img" >/dev/null 2>&1; then
      die "could not pull $img.
       If the package is private the box needs:  docker login ghcr.io
       To build from this checkout instead:      --build-local"
    fi
    did "using $img (each run re-pulls it)"
  fi
done

# ── 6. cron ──────────────────────────────────────────────────────────────────
# The work dir is mounted at an IDENTICAL path inside and out. That is
# load-bearing: paths under it are used both for in-container file ops and as
# sibling-container `-v` sources, which the HOST daemon resolves against the
# host filesystem. Change either side and the sandbox mounts nothing.
job_cmd() { # $1 = job — what the crontab line runs
  # A crontab entry must be ONE line, so the docker invocation lives in
  # run.sh instead: readable here, readable there, and it survives being pasted
  # through a chat client on the way to whoever sets the box up.
  printf '%s/run.sh %s' "$WORK" "$1"
}

if [ "$DO_CRON" = 1 ]; then
  step "Scheduling"
  # cron fires in the HOST's local timezone, not UTC — say which, because
  # "02:00" read as UTC on an IST box is 07:30 and the person reading this is
  # the one who will be surprised.
  TZ_NAME="$( (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || date +%Z) | head -1)"
  for j in $JOBS; do
    eval "at=\$AT_$(vn "$j")"
    at="$(normalize_cron "$at")"
    marker="$CRON_MARKER_BASE-$j"
    LINE="$at $(job_cmd "$j") $marker"
    if [ "$DRY" = 1 ]; then
      say "would install cron line:"; say "$LINE"
    else
      # Drop the line we installed before FOR THIS JOB, then add the current
      # one — so a re-install upgrades the schedule instead of stacking, and
      # installing one job never strips the other's line.
      #
      # TWO patterns, because the marker is younger than some installs. Boxes set
      # up before it existed carry a long-form inline `docker run … -e
      # CANARY_JOB=<job> …` line with no marker at all, and matching only the
      # marker would leave it there — six cron entries, each job scheduled twice,
      # one on the old image and one on the new. The per-job flock keeps that
      # from doing damage (the loser exits clean) but which image actually runs
      # becomes a coin toss, which is the hardest kind of wrong to notice.
      # `CANARY_JOB=<job>` is specific enough that it cannot match anything else
      # in an operator's crontab.
      { crontab -l 2>/dev/null | grep -vF "$marker" | grep -vF "CANARY_JOB=$j" || true; echo "$LINE"; } | crontab -
      did "$j — $(describe_cron "$at") $TZ_NAME"
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
say "FIRST RUNS ARE LONG, and only the first:"
say "  canary      ~1h  — the version gate is empty, so it probes all 12 CLIs."
say "                     After that only a CLI whose version CHANGED is"
say "                     re-probed, so normal days are minutes."
say "  translate   ~2h  — the cache is empty, so it translates the whole corpus"
say "                     in 14 languages. After that only pages whose ENGLISH"
say "                     source changed are re-translated, so normal nights"
say "                     are minutes, and quiet ones do nothing at all."
say "  docs-audit  ~1min every week."
printf '\n'
say "canary and docs-audit post to Slack on EVERY run, including the quiet ones,"
say "so silence from them means the box did not run rather than that all was"
say "well. translate is quiet when it succeeds — its output is the pull request"
say "it opens — but it POSTS ON FAILURE, and stamps translate/last-run.json on"
say "every exit, whose age the weekly docs audit reports. Silence from all three"
say "at once means the box itself stopped."

if [ -n "$RUN_NOW" ]; then
  step "Running $RUN_NOW now"
  # Spelled out rather than reusing job_cmd: that one emits a line for a HUMAN
  # to paste into a shell, so its paths carry literal quotes. Word-splitting it
  # back apart here would hand docker a path with quote characters in it.
  sock_args=()
  [ "$RUN_NOW" = canary ] && sock_args=(-v /var/run/docker.sock:/var/run/docker.sock)
  now_img="$(image_for "$RUN_NOW")"
  eval "override=\${CANARY_IMAGE_$(vn "$RUN_NOW" | tr 'a-z' 'A-Z'):-}"
  [ -n "$override" ] && now_img="$override"
  run docker run --rm --pull=always -e "CANARY_JOB=$RUN_NOW" -e "CANARY_WORK=$WORK" \
    "${sock_args[@]}" -v "$WORK:$WORK" --env-file "$WORK/secrets.env" "$now_img"
fi
