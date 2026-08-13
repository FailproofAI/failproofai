#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The nightly doc-translation job (CANARY_JOB=translate), invoked by the runner
# image's baked entrypoint AFTER it has locked, cloned and checked out
# $TRANSLATE_REF into $CANARY_WORK/clone-translate.
#
# It replaces the `prepare` / `translate` / `consolidate` jobs of
# .github/workflows/translate-docs.yml, which keeps only its workflow_dispatch
# as the cloud fallback. THREE THINGS COLLAPSE in the move, and they are the
# reason this file is shorter than the YAML it replaces:
#
#   * The 14-way matrix was runner parallelism, not translation structure.
#     cli.ts already fans out over pages x languages under one concurrency
#     limit, so one process does the whole corpus — which deletes the artifact
#     upload/download round-trip, the per-language cache fragments, and the
#     ~35-line node script that merged them back together.
#   * The GitHub Actions cache layer goes away entirely. The cache is a 13 KB
#     file; here it is a file, symlinked into the work dir. No 10 GiB repo cap,
#     no LRU, no restore-key that silently resolves to a total miss.
#   * `consolidate` re-checked-out main and overlaid artifacts because its
#     siblings ran on different machines. One box, one checkout, no overlay.
#
# WHAT DOES NOT COLLAPSE, and is worth knowing before changing anything here:
# the cache getting evicted between Actions runs was accidentally load-bearing.
# A "translated once" entry whose output file only exists on an unmerged PR
# branch makes `--update-nav` emit nav entries for files that are not there, and
# `mintlify validate` fails — while the cache hit means nothing is regenerated.
# On Actions, eviction eventually forced a full miss and the run went green by
# brute force. Nothing evicts this cache, so that escape hatch is gone: the
# `existsSync` guard in cli.ts/mdx-translator.ts/readme-translator.ts is the
# only thing keeping this job convergent. Do not "optimise" it away.
# ─────────────────────────────────────────────────────────────────────────────
set -u

WORK="${CANARY_WORK:?CANARY_WORK missing — runner-entrypoint.sh sets it}"
CLONE="${CANARY_CLONE:-$WORK/clone-translate}"
LOGS="$WORK/logs"
CACHE_HOME="$WORK/translate"
mkdir -p "$CACHE_HOME" "$LOGS"

REPO="${TRANSLATE_REPO:-FailproofAI/failproofai}"
BASE_BRANCH="${TRANSLATE_BASE:-main}"
PR_TITLE="[auto] update translations"
LANGS="${TRANSLATE_LANGUAGES:-zh,ja,ko,es,pt-br,de,fr,ru,hi,tr,vi,it,ar,he}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FP_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"

# The gateway saturated past ~2 in flight pre-scale (#300, #305) and CI settled
# on a peak of 16: `max-parallel: 4` jobs x cli.ts's default of 4. One process
# reproduces that exact peak at 16 — the number the proxy was sized for, not
# cli.ts's per-process default, which only looked like the limit because the
# matrix multiplied it.
export TRANSLATE_MAX_CONCURRENT="${TRANSLATE_MAX_CONCURRENT:-16}"
export FAILPROOFAI_TELEMETRY_DISABLED=1

# Every exit through here, so the box can never fail silently. GHA gave a
# red-job email for free; a cron line redirected to /dev/null gives nothing.
STEP="startup"
REF_DESC="${TRANSLATE_REF:-origin/$BASE_BRANCH}"
# This job does NOT post to Slack. Its output IS the pull request — a run that
# did something leaves one, and a run that did nothing leaves the previous one
# untouched, so there is nothing a chat message would add that the PR list does
# not already say. Failures go to the run log ($CANARY_LOG) and the exit code.
die() { # $1 = human summary
  echo "✗ $STEP: $1" >&2
  exit 1
}
step() { STEP="$1"; echo "── $1 ──"; }

echo "── translate $TS: $REF_DESC @ $FP_SHA ──"

# ── credentials ──────────────────────────────────────────────────────────────
# Checked up front, together, so a missing one costs a second rather than the
# 40 minutes it takes to discover it at the push.
missing=""
for v in TRANSLATE_LLM_API_KEY TRANSLATE_LLM_BASE_URL TRANSLATE_GITHUB_TOKEN; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || missing="$missing $v"
done
[ -z "$missing" ] || { STEP="credentials"; die "empty in secrets.env:$missing"; }

export ANTHROPIC_API_KEY="$TRANSLATE_LLM_API_KEY"
export ANTHROPIC_BASE_URL="$TRANSLATE_LLM_BASE_URL"

cd "$CLONE" || die "cannot enter $CLONE"

# ── the cache lives in the work dir, not the checkout ────────────────────────
# A symlink rather than a copy-in/copy-out pair, so there is no "where do we
# save it" decision to get wrong — cli.ts's writeFileSync follows the link and
# the durable copy is updated the moment the run writes one. It survives the
# entrypoint's `reset --hard` and `clean -fd` because the path is gitignored.
step "cache"
ln -sfn "$CACHE_HOME/.translation-cache.json" \
  "$CLONE/scripts/translate-docs/.translation-cache.json" || die "could not link the cache"
if [ -f "$CACHE_HOME/.translation-cache.json" ]; then
  echo "cache: $(node -e 'try{const c=require(process.argv[1]);console.log(Object.keys(c.translations||{}).length+" entries, last "+(c.lastUpdated||"?"))}catch{console.log("unreadable")}' "$CACHE_HOME/.translation-cache.json")"
else
  echo "cache: none yet — this run translates the full corpus (~2h, once)"
fi

step "install"
bun install --frozen-lockfile --ignore-scripts || die "bun install failed"

step "translate"
FORCE_FLAG=""
[ "${TRANSLATE_FORCE:-0}" = "1" ] && FORCE_FLAG="--force"
# shellcheck disable=SC2086
bun run translate --languages "$LANGS" $FORCE_FLAG || die "translation failed"

# Parses every page AND checks image references resolve on disk — a broken
# image path is valid MDX, so `mintlify validate` passes it to a reader's
# browser. This is the class that shipped every logo broken in 14 READMEs.
step "validate-pages"
bun run validate:mdx || die "translated pages failed validation"

step "prune-and-nav"
bun scripts/translate-docs/cli.ts --prune --languages "$LANGS" || die "prune failed"
bun scripts/translate-docs/cli.ts --update-nav --languages "$LANGS" || die "nav update failed"

step "validate-config"
(cd docs && mintlify validate) || die "mintlify validate failed"
bun run validate:mdx || die "post-nav page validation failed"

# ── publish ──────────────────────────────────────────────────────────────────
step "publish"
git config user.name "failproofai-canary[bot]"
git config user.email "canary@befailproof.ai"
# Credential helper rather than a token in the remote URL: git prints the
# remote back on any push error, and a URL-embedded token would land in the
# run log.
git config credential.helper '!f() { echo username=x-access-token; echo "password=$TRANSLATE_GITHUB_TOKEN"; }; f'
export TRANSLATE_GITHUB_TOKEN

git add -A
if git diff --cached --quiet; then
  echo "no changes — every language is current at $FP_SHA"
  exit 0
fi
CHANGED="$(git diff --cached --name-only | wc -l | tr -d ' ')"
echo "$CHANGED files changed"

api() { # $1 = method, $2 = path, $3 = body (optional)
  # Prints the response body and RETURNS NON-ZERO on anything that is not 2xx,
  # or on a transport failure. That matters most for the lookup below: piping
  # curl straight into a parser that swallows its own errors makes a 401, a 5xx
  # and a timeout indistinguishable from "no open PR" — and the caller answers
  # that by opening ANOTHER one. Two open auto-translation PRs split the
  # generated files while the shared cache marks them done, so the next run
  # validates an incomplete checkout. Exactly the duplicate this reuse exists
  # to prevent, reached by the one path the ls-remote guard cannot cover.
  #
  # The body is passed as ONE argument, never spliced in through `${3:+...}` —
  # a JSON body word-splits on its spaces there and the request silently
  # becomes a different one.
  local method="$1" path="$2" raw status
  local -a args=(
    -sS --connect-timeout 10 --max-time 60 -X "$method" -w '\n%{http_code}'
    -H "Authorization: Bearer $TRANSLATE_GITHUB_TOKEN"
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28"
  )
  [ $# -ge 3 ] && args+=(--data "$3")
  # Overridable so this can be pointed at a GitHub Enterprise host, and so the
  # publish path can be exercised end-to-end against a stand-in API without
  # opening real pull requests to prove it works.
  raw="$(curl "${args[@]}" "${TRANSLATE_API_BASE:-https://api.github.com}/repos/$REPO$path")" || return 1
  status="${raw##*$'\n'}"          # -w appended it on its own line
  printf '%s' "${raw%$'\n'*}"
  # NOT a variable: api() is always called inside $( ), and an assignment there
  # dies with the subshell. stderr reaches the run log, which is where whoever
  # is reading the failure already is.
  case "$status" in
    2??) return 0 ;;
    *)   echo "  api $method $path → HTTP $status" >&2; return 1 ;;
  esac
}

# Push onto an already-open auto-translation PR rather than dropping this run's
# work beside it. Two runs landing on two branches means the second's cache
# says "done" for pages only the first branch carries — the deadlock described
# in the header, self-inflicted.
# Two statements, not one pipeline: the lookup has to be able to FAIL. Piped
# straight into the parser a 401 or a 5xx becomes an empty string and reads as
# "no open PR" — see api() above for why that is the worst possible answer.
PR_LIST="$(api GET "/pulls?state=open&base=$BASE_BRANCH&per_page=100")" \
  || die "could not list open pull requests — refusing to open
       a second one on a lookup failure. Nothing was pushed; a re-run is safe."
EXISTING="$(printf '%s' "$PR_LIST" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);const m=(Array.isArray(p)?p:[]).find(x=>x.title===process.argv[1]);process.stdout.write(m?m.number+" "+m.head.ref:"")}catch{process.stdout.write("")}})' "$PR_TITLE")"

PR_NUMBER=""; BRANCH=""
if [ -n "$EXISTING" ]; then
  PR_NUMBER="${EXISTING%% *}"; BRANCH="${EXISTING#* }"
  # An open PR whose BRANCH is gone is a real state — someone deleted the
  # branch without closing the PR. Dying here would die again every night,
  # because the branch never comes back: non-convergent, and it costs a night
  # of translation each time.
  #
  # It has to be told apart from a remote we simply could not REACH, which must
  # NOT fall through to a new branch. That would open a second PR on a
  # transient network error, and two open auto-translation PRs is precisely
  # what reusing one exists to prevent: the next run picks one, and the pages
  # only the other carries read as cached-but-absent forever.
  remote_refs="$(git ls-remote --heads origin "$BRANCH" 2>/dev/null)"; ls_rc=$?
  if [ "$ls_rc" -ne 0 ]; then
    die "PR #$PR_NUMBER is open but the remote could not be reached to check its branch"
  elif [ -z "$remote_refs" ]; then
    echo "⚠ PR #$PR_NUMBER is open but its branch $BRANCH no longer exists —" >&2
    echo "  opening a new PR; close the stale one at $REPO/pull/$PR_NUMBER" >&2
    PR_NUMBER=""; BRANCH=""
  fi
fi

if [ -n "$PR_NUMBER" ]; then
  echo "updating open PR #$PR_NUMBER on $BRANCH"
  # Snapshot this run's output, move onto the PR branch, replay on top — newer
  # English source wins over whatever that branch already had.
  git reset HEAD >/dev/null
  tar -czf /tmp/translations.tar.gz docs/ || die "could not snapshot docs/"
  git fetch origin "$BRANCH" || die "could not fetch $BRANCH"
  git checkout -f -B "$BRANCH" "origin/$BRANCH" || die "could not check out $BRANCH"
  tar -xzf /tmp/translations.tar.gz && rm -f /tmp/translations.tar.gz
  # Validate again: after the overlay the tree is neither what we validated
  # above nor what the PR branch had, and it is what gets committed.
  (cd docs && mintlify validate) || die "mintlify validate failed after overlaying $BRANCH"
  bun run validate:mdx || die "page validation failed after overlaying $BRANCH"
else
  BRANCH="auto/translate-docs-$(date -u +%Y%m%d-%H%M)"
  git checkout -b "$BRANCH" || die "could not create $BRANCH"
fi

git add -A
if git diff --cached --quiet; then
  echo "nothing new relative to $BRANCH"
  exit 0
fi
git commit -m "docs: update translations for changed English sources" || die "commit failed"
git push origin "$BRANCH" || die "push to $BRANCH failed — check the PAT's contents:write scope"

if [ -z "$PR_NUMBER" ]; then
  BODY="Automated translation update from the canary box, triggered by changes to English documentation sources.

- Only changed pages were re-translated (content-hash cache)
- All 14 languages across 3 tiers
- Box run \`$TS\` against \`$REF_DESC\` @ \`$FP_SHA\`"
    CREATED="$(api POST /pulls "$(node -e 'process.stdout.write(JSON.stringify({title:process.argv[1],body:process.argv[2],base:process.argv[3],head:process.argv[4]}))' \
    "$PR_TITLE" "$BODY" "$BASE_BRANCH" "$BRANCH")" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s);process.stdout.write(p.number?String(p.number):"")}catch{process.stdout.write("")}})')"
  [ -n "$CREATED" ] || die "pushed $BRANCH but could not open the PR — check the PAT's pull-requests:write scope"
  PR_NUMBER="$CREATED"
  echo "opened https://github.com/$REPO/pull/$PR_NUMBER with $CHANGED files"
else
  echo "pushed $CHANGED files to https://github.com/$REPO/pull/$PR_NUMBER"
fi

echo "── done: PR #$PR_NUMBER on $BRANCH ──"
