#!/usr/bin/env bash
# End-to-end: a REAL layout-1 home, upgraded by the REAL CLI, with the inode
# checked before and after. Units can assert the move; only this shows a user's
# history surviving an upgrade driven by the actual binary.
set -uo pipefail
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
H=/tmp/fpai-mig-home
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "${2:-}"; }

rm -rf "$H"; mkdir -p "$H/cache/hook-activity" "$H/cache/audit" "$H/cursors" "$H/policies"

# A layout-1 home: activity pages, an audit cache, cursors, a policy config.
for i in 0 1 2; do
  printf '{"timestamp":%s,"eventType":"PreToolUse","toolName":"Bash","decision":"deny","reason":"page-%s"}\n' \
    "$((1785000000000+i))" "$i" > "$H/cache/hook-activity/page-1785000000-$i.jsonl"
done
printf '{"timestamp":1785999999999,"eventType":"PreToolUse","toolName":"Bash","decision":"allow","reason":"live"}\n' \
  > "$H/cache/hook-activity/current.jsonl"
printf '4\n' > "$H/cache/hook-activity/current.count"
printf '{"total":4}\n' > "$H/cache/hook-activity/stats.json"
printf '{"enabledPolicies":["block-sudo"]}' > "$H/policies-config.json"
printf '{"files":[{"path":"x","dev":1,"inode":2,"offset":10}]}' > "$H/cursors/hooks.json"
printf '{}' > "$H/cache/audit/report.json"

printf '\n\033[1m── layout 1, before ──\033[0m\n'
printf '  activity pages: %s\n' "$(ls "$H/cache/hook-activity"/*.jsonl | wc -l)"
INO_BEFORE=$(stat -c %i "$H/cache/hook-activity/page-1785000000-0.jsonl")
printf '  inode of page-0: %s\n' "$INO_BEFORE"

printf '\n\033[1m── run the REAL CLI (triggers the layout reset) ──\033[0m\n'
# NOT --version or --help: both are deliberately exempt from the layout check,
# so neither triggers a reset. `config --status` is an ordinary command.
OUT=$(FAILPROOFAI_HOME="$H" node "$R/dist/cli.mjs" config --status 2>&1)
printf '%s\n' "$OUT" | sed 's/^/    /' | head -10

printf '\n\033[1m── did the history survive? ──\033[0m\n'
COUNT=$(ls "$H/hook-activity"/*.jsonl 2>/dev/null | wc -l)
[ "$COUNT" -eq 4 ] && ok "all 4 pages carried over (3 pages + current)" || bad "4 pages" "got $COUNT"
grep -qr "page-0" "$H/hook-activity" 2>/dev/null && ok "the oldest page's records are intact" || bad "records intact"
grep -qr '"live"' "$H/hook-activity" 2>/dev/null && ok "the legacy current.jsonl was carried too" || bad "current carried"

printf '\n\033[1m── INODE PRESERVED (no re-ship) ──\033[0m\n'
MOVED=$(grep -lr "page-0" "$H/hook-activity" 2>/dev/null | head -1)
if [ -n "$MOVED" ]; then
  INO_AFTER=$(stat -c %i "$MOVED")
  [ "$INO_AFTER" = "$INO_BEFORE" ] && ok "inode unchanged ($INO_AFTER) — cursors still resume" \
    || bad "inode preserved" "before=$INO_BEFORE after=$INO_AFTER (a COPY would do this)"
else
  bad "found the moved page" "none"
fi

printf '\n\033[1m── cursors kept ──\033[0m\n'
[ -f "$H/cursors/hooks.json" ] && ok "the cursor file survived the reset" || bad "cursors kept"

printf '\n\033[1m── and the rest of layout 1 IS gone ──\033[0m\n'
[ -d "$H/cache/audit" ] && bad "audit cache removed" "still there" || ok "audit cache removed"
# Layout 3 puts the CURRENT policy config back at layout 1's path and CARRIES
# the user's selection into it, so its presence is the correct outcome — the
# same reason layout-reset.sh asserts the carry rather than the deletion.
[ -f "$H/policies-config.json" ] && ok "policy config carried to the layout-3 path" \
  || bad "policy config carried to the layout-3 path" "missing"
[ -d "$H/cache/hook-activity" ] && printf '  (legacy dir left in place, now empty — harmless)\n' || true

printf '\n\033[1m── the message tells the user ──\033[0m\n'
printf '%s' "$OUT" | grep -qi "decision history were kept" && ok "says the history was kept" || bad "message" "$(printf '%s' "$OUT"|head -3)"
printf '%s' "$OUT" | grep -qi "Carried .* page" && ok "…and how many pages" || bad "page count in message"

printf '\n\033[1m═══ %s passed, %s failed ═══\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
