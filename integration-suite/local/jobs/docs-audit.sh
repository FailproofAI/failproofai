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

step "report"
slack_note "$REPORT"
echo "── done ──"
