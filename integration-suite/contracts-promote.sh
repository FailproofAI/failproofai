#!/usr/bin/env bash
# Ask this machine whether it agrees with the lab, and open the promotion pull
# request if it does.
#
#   contracts-promote.sh
#   env: CONTRACTS_REPO=<owner/name>   CONTRACTS_TOKEN=<token with pull-requests: write>
#        FAILPROOFAI_BIN=<path>        (default: failproofai on PATH)
#
# ── Where this belongs ───────────────────────────────────────────────────────
# On a machine that RUNS the agent CLIs for real, not on the lab box. The whole
# value is a second, independent measurement: the lab drove each CLI once in a
# container, and this asks whether something using those CLIs day to day saw the
# same thing. Running it on the box would compare the lab's run against the
# lab's own leftovers and always agree, which is worse than not checking at all
# — it would look like corroboration while supplying none.
#
# ── What it will not do ──────────────────────────────────────────────────────
# It does not merge, and it cannot: the org ruleset requires a reviewed pull
# request on main, and that review is the promotion decision. This only gets the
# diff in front of a human, and only when a real machine has already agreed with
# it. A pack that nothing corroborates simply stays on the internal channel,
# which is the correct resting place for a measurement nobody has confirmed.
set -uo pipefail

REPO="${CONTRACTS_REPO:?CONTRACTS_REPO (owner/name) required}"
TOKEN="${CONTRACTS_TOKEN:?CONTRACTS_TOKEN required}"
BIN="${FAILPROOFAI_BIN:-failproofai}"
HEAD_BRANCH="${CONTRACTS_BRANCH:-packs}"
BASE_BRANCH="${CONTRACTS_BASE:-main}"

api() { # $1 = method, $2 = path, $3 = optional body
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" --data "$body" \
      "https://api.github.com/repos/$REPO/$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$REPO/$path"
  fi
}

# ── 1. Does this machine agree? ──────────────────────────────────────────────
# Exit 0 corroborated, 1 contradicted, 2 nothing comparable. Only 0 proceeds:
# "we could not check" is not evidence, and promoting on it would make the gate
# decorative.
echo "── asking this machine whether it agrees with the lab ──"
verdict_out="$(FAILPROOFAI_CONTRACTS_CHANNEL=internal "$BIN" doctor --corroborate 2>&1)"
rc=$?
echo "$verdict_out"
if [ "$rc" -ne 0 ]; then
  echo "not promoting: this machine did not corroborate the pack (exit $rc)"
  exit "$rc"
fi

# ── 2. Is there anything to promote? ─────────────────────────────────────────
ahead="$(api GET "compare/$BASE_BRANCH...$HEAD_BRANCH" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const c=JSON.parse(s); process.stdout.write(String(c.ahead_by ?? 0)); }
    catch { process.stdout.write("0"); }
  })')"
if [ "${ahead:-0}" = 0 ]; then
  echo "nothing to promote: $HEAD_BRANCH is not ahead of $BASE_BRANCH"
  exit 0
fi

# ── 3. Is one already open? ──────────────────────────────────────────────────
# A daily job that opens a pull request every day teaches everyone to ignore
# them, which costs exactly the review this design depends on.
existing="$(api GET "pulls?state=open&base=$BASE_BRANCH&head=${REPO%%/*}:$HEAD_BRANCH" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const a=JSON.parse(s); process.stdout.write(a.length ? String(a[0].number) : ""); }
    catch { process.stdout.write(""); }
  })')"
if [ -n "$existing" ]; then
  echo "already open: #$existing — a machine has corroborated it again, nothing new to raise"
  exit 0
fi

# ── 4. Raise it ──────────────────────────────────────────────────────────────
body="$(printf '%s' "A vendor's hook contract moved, and an independent machine that runs these CLIs agrees with what the lab recorded.

\`\`\`
$verdict_out
\`\`\`

Merging publishes this to \`releases/latest/download/pack.json\`, which is what every client machine fetches. Review the diff to \`pack.json\` — it is the vendor's own key names, so a change here is a change somebody else shipped." \
  | node -e 'const t=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify(t))')"

payload="$(node -e '
  const [head, base, body] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    title: "Promote the contracts pack",
    head, base, body: JSON.parse(body),
  }));' "$HEAD_BRANCH" "$BASE_BRANCH" "$body")"

number="$(api POST pulls "$payload" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const p=JSON.parse(s); process.stdout.write(p.number ? String(p.number) : "ERR:"+(p.message||"unknown")); }
    catch { process.stdout.write("ERR:unparseable response"); }
  })')"

case "$number" in
  ERR:*) echo "could not open the pull request: ${number#ERR:}" >&2; exit 2 ;;
  *)     echo "opened #$number — promotion now needs a human review, which is the gate" ;;
esac
