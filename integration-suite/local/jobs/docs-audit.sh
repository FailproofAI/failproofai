#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The weekly documentation audit (CANARY_JOB=docs-audit), invoked by the runner
# image's baked entrypoint AFTER it has locked, cloned and checked out
# $DOCS_AUDIT_REF into $CANARY_WORK/clone-docs-audit.
#
# It is the cheapest job on the box: no LLM gateway, no push credential, no
# sibling containers. It reads the docs tree and git history and posts what it
# found. That is deliberate — an audit that could also FIX what it finds would
# need write access and a much longer argument about what it is allowed to
# change unattended.
#
# WHAT IT IS FOR, given `mintlify validate` and `validate:mdx` already run per
# PR. Those answer "does this build", on the pages a PR touches. They pass
# happily on a corpus that builds perfectly and is quietly wrong: a page nobody
# has edited since the CLI it documents was rewritten, a page in the nav that no
# longer exists, a page in no nav at all, a link to something renamed, a
# translation still describing last quarter's behaviour. None of that fails a
# build — which is exactly the shape a periodic sweep catches and a per-PR gate
# never will.
#
# The analysis lives in scripts/docs-audit.ts (unit-tested, and runnable by hand
# as `bun run docs:audit`), so this script is only the box wiring around it.
# ─────────────────────────────────────────────────────────────────────────────
set -u

WORK="${CANARY_WORK:?CANARY_WORK missing — runner-entrypoint.sh sets it}"
CLONE="${CANARY_CLONE:-$WORK/clone-docs-audit}"
CACHE_HOME="$WORK/translate"
REPO="${DOCS_AUDIT_REPO:-FailproofAI/failproofai}"
ISSUE_TITLE="[auto] docs audit"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FP_SHA="$(git -C "$CLONE" rev-parse --short HEAD)"
REF_DESC="${DOCS_AUDIT_REF:-origin/main}"

export FAILPROOFAI_TELEMETRY_DISABLED=1
export DOCS_AUDIT_REF="$REF_DESC" DOCS_AUDIT_SHA="$FP_SHA"

echo "── docs-audit $TS: $REF_DESC @ $FP_SHA ──"

STEP="startup"
slack_note() { # $1 = text; best-effort, never fails the run
  [ -n "${CANARY_SLACK_WEBHOOK:-}" ] || { echo "(no webhook set — report above is the whole output)"; return 0; }
  local payload
  payload="$(printf '%s' "$1" | node -e 'const t=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify({text:t}))')"
  curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -X POST \
    -H 'Content-type: application/json' --data "$payload" "$CANARY_SLACK_WEBHOOK" 2>/dev/null || true
}
die() { # $1 = human summary
  echo "✗ $STEP: $1" >&2
  slack_note "🔥 docs audit FAILED at *$STEP* — \`$REF_DESC\` @ \`$FP_SHA\`
$1
\`\`\`
$(tail -15 "${CANARY_LOG:-/dev/null}" 2>/dev/null || echo '(no log)')
\`\`\`"
  exit 1
}
step() { STEP="$1"; echo "── $1 ──"; }

cd "$CLONE" || die "cannot enter $CLONE"

# The audit reports translation drift, which it reads from the same cache the
# nightly translate job maintains. Without this link every page would report as
# never-translated every week — a 672-line finding that is an artefact of where
# the file lives, not a fact about the docs.
step "cache"
if [ -f "$CACHE_HOME/.translation-cache.json" ]; then
  ln -sfn "$CACHE_HOME/.translation-cache.json" \
    "$CLONE/scripts/translate-docs/.translation-cache.json" || die "could not link the cache"
else
  echo "no translation cache yet — translation drift will read as never-translated"
fi

step "install"
bun install --frozen-lockfile --ignore-scripts || die "bun install failed"

step "audit"
REPORT="$(bun run docs:audit)" || die "the audit itself failed to run"
echo "$REPORT"

# ── did the nightly translation actually run? ────────────────────────────────
# The translate job is quiet on success by design, which made "failing every
# night" and "idle every night" the same signal — six days of neither PR nor
# error went unnoticed until this audit reported 28 cached-but-absent pages.
# It now stamps every exit; this reads the stamp's AGE, which is the only thing
# that can catch the failure mode no error handler sees: the job never started.
step "translate-health"
TRANSLATE_HEALTH="$(node -e '
  const fs = require("fs");
  const p = process.argv[1];
  let s;
  try { s = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { process.stdout.write("⚠️ *Nightly translation*: no run stamp at all — the job has not run since this check shipped, or is not scheduled"); process.exit(0); }
  const ageH = (Date.now() - Date.parse(s.at)) / 3.6e6;
  const age = ageH < 48 ? `${Math.round(ageH)}h ago` : `${Math.round(ageH / 24)} days ago`;
  if (s.outcome !== "ok") { process.stdout.write(`🔥 *Nightly translation*: last run ${age} FAILED at \`${s.step}\` — ${s.detail || ""}`); process.exit(0); }
  if (ageH > 48) { process.stdout.write(`⚠️ *Nightly translation*: last successful run was ${age} — it runs daily, so it is not running`); process.exit(0); }
  process.stdout.write(`✅ *Nightly translation*: last ran ${age} (${s.detail || "ok"})`);
' "$CACHE_HOME/last-run.json" 2>/dev/null || echo "")"
[ -n "$TRANSLATE_HEALTH" ] && echo "$TRANSLATE_HEALTH"

step "report"
slack_note "$REPORT${TRANSLATE_HEALTH:+

$TRANSLATE_HEALTH}"

# ── tracking issue ───────────────────────────────────────────────────────────
# Optional: with no token the job is exactly what it was, a Slack post. The
# issue is a SECOND channel, not a replacement — Slack is read the morning it
# arrives, an issue is what someone finds three weeks later while wondering why
# a page is unreachable.
#
# An ISSUE and not a PR, deliberately. A report is not a change: a weekly PR
# would either sit open forever or auto-merge a file nobody reads. And an audit
# that opened a FIXING PR would have almost nothing safe to put in it — a
# dangling nav entry might mean "delete the entry" or "restore the page", an
# orphan page might be deliberately unlisted, and a broken link has no
# inferable target. Every one of those is a judgement this job cannot make.
if [ -z "${DOCS_AUDIT_GITHUB_TOKEN:-}" ]; then
  echo "no DOCS_AUDIT_GITHUB_TOKEN — Slack only, no tracking issue"
  echo "── done ──"
  exit 0
fi

step "issue"
export DOCS_AUDIT_AT="$TS"
COUNT="$(bun scripts/docs-audit.ts --count)" || die "could not count findings"
BODY="$(bun scripts/docs-audit.ts --markdown)" || die "could not render the report"
echo "actionable findings: $COUNT"

api() { # $1 = method, $2 = path, $3 = body (optional)
  # The body is passed as ONE argument, never spliced in — a JSON body
  # word-splits on its spaces and the request silently becomes a different one.
  # Prints the body and RETURNS NON-ZERO on anything that is not 2xx. Without
  # that, the lookup below cannot tell a 401 or a 5xx from "no open issue" — and
  # the answer to "no open issue" is to open one, so a bad token would file a
  # duplicate every week until somebody noticed the pile.
  local method="$1" path="$2" raw status
  local -a args=(
    -sS --connect-timeout 10 --max-time 60 -X "$method" -w '\n%{http_code}'
    -H "Authorization: Bearer $DOCS_AUDIT_GITHUB_TOKEN"
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28"
  )
  [ $# -ge 3 ] && args+=(--data "$3")
  raw="$(curl "${args[@]}" "${DOCS_AUDIT_API_BASE:-https://api.github.com}/repos/$REPO$path")" || return 1
  status="${raw##*$'\n'}"
  printf '%s' "${raw%$'\n'*}"
  # NOT a variable: api() is always called inside $( ), and an assignment there
  # dies with the subshell. stderr reaches the run log, which is where whoever
  # is reading the failure already is.
  case "$status" in
    2??) return 0 ;;
    *)   echo "  api $method $path → HTTP $status" >&2; return 1 ;;
  esac
}

# /issues returns PULL REQUESTS too — every PR is an issue to this endpoint —
# so entries carrying a `pull_request` key are filtered out. Without that, an
# open PR that happened to share the title would be updated instead.
ISSUE_LIST="$(api GET "/issues?state=open&per_page=100")" \
  || die "could not list open issues — refusing to open a
       duplicate on a lookup failure. The Slack report above still went out."
EXISTING="$(printf '%s' "$ISSUE_LIST" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{
      const a=JSON.parse(s);
      const m=(Array.isArray(a)?a:[]).find(x=>!x.pull_request && x.title===process.argv[1]);
      process.stdout.write(m?String(m.number):"");
    }catch{process.stdout.write("")}})' "$ISSUE_TITLE")"

mkbody() { node -e 'process.stdout.write(JSON.stringify({title:process.argv[1],body:process.argv[2]}))' "$ISSUE_TITLE" "$BODY"; }

if [ "$COUNT" -gt 0 ]; then
  if [ -n "$EXISTING" ]; then
    api PATCH "/issues/$EXISTING" "$(mkbody)" >/dev/null || die "could not update issue #$EXISTING"
    echo "updated https://github.com/$REPO/issues/$EXISTING"
  else
    NUM="$(api POST /issues "$(mkbody)" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.number?String(j.number):"")}catch{process.stdout.write("")}})')"
    [ -n "$NUM" ] || die "could not open the tracking issue — check the PAT's issues:write scope"
    echo "opened https://github.com/$REPO/issues/$NUM"
  fi
elif [ -n "$EXISTING" ]; then
  # Clean week: say so on the issue and close it, so an open issue always means
  # "there is something to do" rather than "this ran once, months ago".
  api POST "/issues/$EXISTING/comments" \
    "$(node -e 'process.stdout.write(JSON.stringify({body:process.argv[1]}))' \
      "Clean as of \`$FP_SHA\` — closing. The weekly audit will reopen this if anything returns.")" \
    >/dev/null || true
  api PATCH "/issues/$EXISTING" '{"state":"closed"}' >/dev/null \
    || die "could not close issue #$EXISTING"
  echo "closed https://github.com/$REPO/issues/$EXISTING (nothing to report)"
else
  echo "nothing to report, and no open issue — no GitHub action taken"
fi

echo "── done ──"
