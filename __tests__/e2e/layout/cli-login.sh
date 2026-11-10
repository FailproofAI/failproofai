#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# `failproofai config` → "Log in to FailproofAI Cloud", end to end, for real.
#
# The real wizard runs in a real pseudo-terminal (cli-login-driver.py) inside a
# systemd container, as an unprivileged user, and installs a real daemon. A
# person's half — signing in, approving, denying — happens through the real
# AgentEye dashboard API, with the sign-in code read out of mailpit. Then it
# checks what landed: the machine's key, the daemon checking in with it, and
# what the server recorded. Nothing is mocked.
#
# Needs, all local:
#   - an AgentEye stack: dashboard on $DASH, mailpit API on $MAILPIT, and its
#     Postgres reachable through `docker exec $PG_CONTAINER psql`
#   - an older Cloud on $OLD_CLOUD that answers requests but has no CLI login routes
#   - this repo built: `bun run build` (dist/) and
#     `cargo build --release --bin failproofaid`
#   - Docker. The container uses the HOST network, because the CLI only sends
#     a key over plain http to loopback, so it must see the dashboard there.
#
# Not part of `bun run test:e2e`: like the other harnesses here, it is run
# deliberately (see README.md in this directory).
#
#   DASH=http://localhost:3000 MAILPIT=http://localhost:8026 \
#     PG_CONTAINER=agenteye-postgres-1 bash __tests__/e2e/layout/cli-login.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DASH=${DASH:-http://localhost:3000}
MAILPIT=${MAILPIT:-http://localhost:8026}
OLD_CLOUD=${OLD_CLOUD:-http://localhost:28080}
PG_CONTAINER=${PG_CONTAINER:-agenteye-postgres-1}
C=${C:-fpai-e2e-login}
KEEP=${KEEP:-0}  # 1 = leave the container up afterwards, for poking at
STAMP=$(date +%s)
OUT=$(mktemp -d)

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "${2:-}"; }
has()   { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1" "missing [$3] in: $(printf '%s' "$2" | tr '\n' ' ' | tail -c 400)"; fi; }
hasnt() { if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1" "unexpected [$3]"; else ok "$1"; fi; }
eq()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want [$3] got [$2]"; fi; }
head1() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
jqp() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }
sql() { docker exec "$PG_CONTAINER" psql -U postgres -d agenteye -tAc "$1"; }
dex() { docker exec "$C" bash -lc "$1"; }

cleanup() {
  [ "$KEEP" = 1 ] || docker rm -f "$C" >/dev/null 2>&1
  rm -rf "$OUT"
}
trap cleanup EXIT

# ── A person, through the dashboard ──────────────────────────────────────────

# Sign <email> in through the real email-code flow and print its session.
sign_in() {
  local email=$1 id code
  curl -s -X DELETE "$MAILPIT/api/v1/search?query=to:$email" >/dev/null || true
  curl -s -X POST "$DASH/api/auth/otp/request" -H 'content-type: application/json' -d "{\"email\":\"$email\"}" >/dev/null
  for _ in $(seq 1 40); do
    id=$(curl -s "$MAILPIT/api/v1/search?query=to:$email&limit=1" | jqp '["messages"][0]["ID"]')
    [ -n "$id" ] && break
    sleep 0.5
  done
  code=$(curl -s "$MAILPIT/api/v1/message/$id" | python3 -c 'import sys,json,re;print(re.search(r"\b(\d{6})\b",json.load(sys.stdin)["Text"]).group(1))')
  curl -s -D - -o /dev/null -X POST "$DASH/api/auth/otp/verify" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"code\":\"$code\"}" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: ae_session=\([^;]*\).*/\1/p'
}

person() { # <session> <action> <json> -> body; status in $OUT/status
  curl -s -o "$OUT/body" -w '%{http_code}' -X POST "$DASH/api/auth/cli/$2" -b "ae_session=$1" \
    -H "origin: $DASH" -H 'content-type: application/json' -d "$3" > "$OUT/status"
  cat "$OUT/body"
}

link_token() { python3 -c 'import sys,urllib.parse as u;print(u.parse_qs(u.urlparse(sys.argv[1]).query)["r"][0])' "$1"; }

# ── The machine, through a real terminal ─────────────────────────────────────

# Run `failproofai config` under the pty driver in the background.
# <name> <script> [extra env...]; transcript -> $OUT/<name>.log, rc -> $OUT/<name>.rc
run_config() {
  local name=$1 script=$2; shift 2
  dex "rm -f /tmp/$name.log /tmp/$name.url"
  ( docker exec -u dev -w /home/dev "$C" env HOME=/home/dev \
      FAILPROOFAI_CLOUD_URL="$DASH" \
      FAILPROOFAI_DAEMON_BINARY=/repo/target/release/failproofaid \
      FAILPROOFAI_TELEMETRY_DISABLED=1 FAILPROOFAI_NO_AUTO_AUDIT=1 NO_COLOR=1 "$@" \
      python3 /repo/__tests__/e2e/layout/cli-login-driver.py "$script" "/tmp/$name.log" "/tmp/$name.url" \
      -- failproofai config ; echo $? > "$OUT/$name.rc" ) &
}

wait_url() { # <name> -> the authorize link the CLI printed
  local u=""
  for _ in $(seq 1 120); do
    u=$(dex "cat /tmp/$1.url 2>/dev/null")
    [ -n "$u" ] && { dex "rm -f /tmp/$1.url"; echo "$u"; return; }
    sleep 0.5
  done
}

wait_done() { # <name> -> transcript
  for _ in $(seq 1 240); do [ -f "$OUT/$1.rc" ] && break; sleep 0.5; done
  dex "cat /tmp/$1.log 2>/dev/null" | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g'
}

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 0 — preconditions"
curl -s -m 5 -o /dev/null "$DASH/login" && ok "dashboard is up on $DASH" || bad "dashboard is up" "$DASH/login"
curl -s -m 5 -o /dev/null "$MAILPIT/api/v1/messages" && ok "mailpit is up on $MAILPIT" || bad "mailpit is up" "$MAILPIT"
curl -s -m 5 -o /dev/null "$OLD_CLOUD" && ok "older cloud is up on $OLD_CLOUD" || bad "older cloud is up" "$OLD_CLOUD"
[ -n "$(sql 'select 1' 2>/dev/null)" ] && ok "Postgres reachable via $PG_CONTAINER" || bad "Postgres reachable" "$PG_CONTAINER"
[ -f "$R/dist/cli.mjs" ] && ok "CLI built" || bad "CLI built" "run: bun run build"
[ -x "$R/target/release/failproofaid" ] && ok "daemon built" || bad "daemon built" "run: cargo build --release --bin failproofaid"
[ "$FAIL" = 0 ] || { echo "preconditions failed"; exit 1; }

if ! docker ps --format '{{.Names}}' | grep -qx "$C"; then
  docker run -d --name "$C" --privileged --cgroupns=host --network=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
    -v "$R":/repo:ro jrei/systemd-ubuntu:24.04 >/dev/null
  until docker exec "$C" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded'; do sleep 1; done
  dex 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null; apt-get install -y -qq sudo curl ca-certificates python3 >/dev/null 2>&1
       curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/n.sh && bash /tmp/n.sh >/dev/null 2>&1 && apt-get install -y -qq nodejs >/dev/null 2>&1
       id dev >/dev/null 2>&1 || useradd -m -s /bin/bash dev
       echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev && chmod 440 /etc/sudoers.d/dev'
fi
# Claude Code "installed": detection is a binary on PATH, and a detected agent
# is what the agents screen opens ticked — so Enter there is the final OK.
dex 'printf "#!/bin/sh\nexit 0\n" > /usr/local/bin/claude && chmod +x /usr/local/bin/claude'
# `failproofai` on PATH, as `npm i -g` would put it: hook install writes that
# command into each agent's settings and refuses to run without it.
dex 'ln -sf /repo/dist/cli.mjs /usr/local/bin/failproofai' 
# A fresh machine every run: no daemon, no failproofai home.
dex 'systemctl disable --now failproofaid@dev.service >/dev/null 2>&1; rm -f /etc/systemd/system/failproofaid@dev.service; systemctl daemon-reload; rm -rf /home/dev/.failproofai /home/dev/.claude'
eq "container up, with systemd" "$(dex 'systemctl is-system-running' | tr -d '\r')" "running"
# The label setup sends is the hostname (`--machine-label` alone RENAMES a
# connected machine, so it is not a setup option here).
LABEL=$(dex hostname | tr -d '\r')

EMAIL="ada-$STAMP@example.test"
SLUG="e2e-$STAMP"
SESSION=$(sign_in "$EMAIL")
[ -n "$SESSION" ] && ok "approver signed in through the email code" || bad "approver signed in" "no session"
ORG_ID=$(curl -s -X POST "$DASH/api/orgs" -b "ae_session=$SESSION" -H 'content-type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"name\":\"E2E Co\"}" | jqp '["id"]')
[ -n "$ORG_ID" ] && ok "approver created org $SLUG" || bad "approver created an org" "no id"
USER_ID=$(sql "select id from users where email = '$EMAIL'")
keys_in_org() { sql "select count(*) from api_keys where org_id = '$ORG_ID' and created_via = 'cli_login'"; }

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 1 — a fresh machine starts the login by itself, and setup finishes on its own"
run_config fresh "wait:CONNECT TO CLOUD,url,wait:WHICH AGENTS SHOULD FAILPROOFAI TRACE?,key:enter"
URL=$(wait_url fresh)
has "the CLI printed the authorize link" "$URL" "$DASH/cli/authorize?r="
LINK=$(link_token "$URL")
PAGE=$(person "$SESSION" lookup "{\"link_token\":\"$LINK\"}")
eq "the page sees a pending request" "$(echo "$PAGE" | jqp '["status"]')" "pending"
eq "…for this machine" "$(echo "$PAGE" | jqp '["machine"]["label"]')" "$LABEL"
eq "nothing is minted before approval" "$(keys_in_org)" "0"
person "$SESSION" approve "{\"link_token\":\"$LINK\",\"org_id\":\"$ORG_ID\"}" >/dev/null
eq "approve answered 200" "$(cat "$OUT/status")" "200"
T=$(wait_done fresh)
eq "config exited 0" "$(cat "$OUT/fresh.rc")" "0"
has "no display here, so it printed the link to open anywhere" "$T" "Open this link in any browser to connect $LABEL"
hasnt "no menu before the login on a fresh machine" "$T" "Paste an API key"
has "tab is offered as the way to the other options" "$T" "tab more options"
has "the CLI shows who approved it, and where" "$T" "Logged in as $EMAIL · E2E Co ($SLUG)"
has "the daemon installed" "$T" "failproofaid installed and running"
has "the cloud connection was written" "$T" "Connected as"
eq "exactly one key minted, at the end of setup" "$(keys_in_org)" "1"
eq "attributed to the approver" "$(sql "select created_by_user_id from api_keys where org_id = '$ORG_ID' and created_via = 'cli_login'")" "$USER_ID"
eq "the request is spent" "$(sql "select status from cli_login_requests where link_token_hash = encode(sha256('$LINK'::bytea), 'hex')")" "claimed"
eq "daemon running under systemd" "$(dex 'systemctl is-active failproofaid@dev' | tr -d '\r')" "active"
KEY=$(dex "python3 -c 'import json;d=json.load(open(\"/home/dev/.failproofai/credentials.json\"));print(d[\"cloud\"][\"token\"])'" | tr -d '\r')
WHO=$(curl -s "$DASH/v1/auth/introspect" -H "authorization: Bearer $KEY")
eq "the machine's key works, in the approved org" "$(echo "$WHO" | jqp '["org_slug"]')" "$SLUG"
has "…with jev, which the approver holds" "$WHO" "jev:evaluate"
for _ in $(seq 1 30); do
  [ "$(sql "select count(*) from enforcement_machines where org_id = '$ORG_ID'")" = 1 ] && break; sleep 1
done
eq "the daemon checked in with that key" "$(sql "select count(*) from enforcement_machines where org_id = '$ORG_ID'")" "1"
hasnt "the key never appears in the terminal" "$T" "$KEY"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 2 — a connected machine is offered 'keep' first; logging in again makes a new key"
run_config relogin "wait:Keep current connection,key:down,key:enter,url,wait:WHICH AGENTS SHOULD FAILPROOFAI TRACE?,key:enter"
LINK=$(link_token "$(wait_url relogin)")
person "$SESSION" approve "{\"link_token\":\"$LINK\",\"org_id\":\"$ORG_ID\"}" >/dev/null
T=$(wait_done relogin)
eq "config exited 0" "$(cat "$OUT/relogin.rc")" "0"
has "the menu named the saved key" "$T" "key ****"
has "it says the old key still works" "$T" "Your previous key for this machine still works"
eq "a second key, the first one still live" "$(sql "select count(*) from api_keys where org_id = '$ORG_ID' and created_via = 'cli_login' and revoked_at is null")" "2"
has "the second key carries a suffix, not a clash" "$(sql "select string_agg(name, ',' order by name) from api_keys where org_id = '$ORG_ID' and created_via = 'cli_login'")" "-2"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 3 — not authorized in the browser, retried from the terminal"
run_config deny "wait:Keep current connection,key:down,key:enter,url,wait:Not authorized in the browser.,key:enter,url,wait:WHICH AGENTS SHOULD FAILPROOFAI TRACE?,key:enter"
LINK1=$(link_token "$(wait_url deny)")
person "$SESSION" deny "{\"link_token\":\"$LINK1\"}" >/dev/null
eq "deny answered 200" "$(cat "$OUT/status")" "200"
LINK2=$(link_token "$(wait_url deny)")
[ "$LINK1" != "$LINK2" ] && ok "enter fetched a NEW link" || bad "enter fetched a new link" "same token"
person "$SESSION" approve "{\"link_token\":\"$LINK2\",\"org_id\":\"$ORG_ID\"}" >/dev/null
T=$(wait_done deny)
eq "config exited 0" "$(cat "$OUT/deny.rc")" "0"
eq "the denied request stays denied" "$(sql "select status from cli_login_requests where link_token_hash = encode(sha256('$LINK1'::bytea), 'hex')")" "denied"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 4 — approved, then the run is abandoned: no key is minted"
BEFORE=$(keys_in_org)
run_config abandon "wait:Keep current connection,key:down,key:enter,url,wait:WHICH AGENTS SHOULD FAILPROOFAI TRACE?,key:ctrl-c"
LINK=$(link_token "$(wait_url abandon)")
person "$SESSION" approve "{\"link_token\":\"$LINK\",\"org_id\":\"$ORG_ID\"}" >/dev/null
T=$(wait_done abandon)
eq "no key minted for an approval nobody claimed" "$(keys_in_org)" "$BEFORE"
eq "the request is approved, never claimed" "$(sql "select status from cli_login_requests where link_token_hash = encode(sha256('$LINK'::bytea), 'hex')")" "approved"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 5 — tab leaves the login for the options without touching anything"
BEFORE=$(keys_in_org)
run_config esc "wait:Keep current connection,key:down,key:enter,url,key:tab,wait:Keep current connection,key:enter,wait:WHICH AGENTS SHOULD FAILPROOFAI TRACE?,key:enter"
LINK=$(link_token "$(wait_url esc)")
T=$(wait_done esc)
eq "config exited 0 after keeping the connection" "$(cat "$OUT/esc.rc")" "0"
eq "no key minted" "$(keys_in_org)" "$BEFORE"
eq "the abandoned link is still just pending" "$(sql "select status from cli_login_requests where link_token_hash = encode(sha256('$LINK'::bytea), 'hex')")" "pending"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 6 — a link that expires offers a fresh one"
run_config expire "wait:Keep current connection,key:down,key:enter,url,wait:That link expired.,key:enter,url,wait:WHICH AGENTS SHOULD FAILPROOFAI TRACE?,key:enter"
LINK1=$(link_token "$(wait_url expire)")
sql "update cli_login_requests set expires_at = now() - interval '1 second' where link_token_hash = encode(sha256('$LINK1'::bytea), 'hex')" >/dev/null
LINK2=$(link_token "$(wait_url expire)")
person "$SESSION" approve "{\"link_token\":\"$LINK2\",\"org_id\":\"$ORG_ID\"}" >/dev/null
T=$(wait_done expire)
eq "config exited 0 on the fresh link" "$(cat "$OUT/expire.rc")" "0"
person "$SESSION" approve "{\"link_token\":\"$LINK1\",\"org_id\":\"$ORG_ID\"}" >/dev/null
eq "the expired link can no longer be approved" "$(cat "$OUT/status")" "410"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 7 — a saved key that was revoked: logging in again starts by itself"
# Revoke every live CLI key, so whichever one this machine holds is dead.
for id in $(curl -s "$DASH/api/keys" -b "ae_session=$SESSION" -H "x-agenteye-org: $SLUG" | python3 -c '
import sys,json
for k in json.load(sys.stdin):
    if k.get("created_via")=="cli_login" and not k.get("revoked_at"): print(k["id"])'); do
  curl -s -o /dev/null -X POST "$DASH/api/keys/$id/disable" -b "ae_session=$SESSION" -H "x-agenteye-org: $SLUG" \
    -H "origin: $DASH" -H 'content-type: application/json' -d '{}'
done
sleep 2
run_config revoked "wait:saved key no longer works,url,key:ctrl-c"
T=$(wait_done revoked)
has "a refused saved key starts the login by itself, and says why" "$T" "Your saved key no longer works:"
has "…logging in again" "$T" "Logging in again."
has "…with a fresh link" "$T" "/cli/authorize?r="

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 8 — a cloud without browser login says so, and offers the rest"
run_config old "wait:doesn't support logging in from here yet,wait:Paste an API key,key:ctrl-c" \
  FAILPROOFAI_CLOUD_URL="$OLD_CLOUD"
T=$(wait_done old)
has "an older server is reported, and the key route stays open" "$T" "doesn't support logging in from here yet. Paste an API key instead."
hasnt "…and login is not offered again" "$T" "Log in again"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 9 — the person side refuses what it must"
EVIL=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/approve" -b "ae_session=$SESSION" \
  -H 'origin: https://evil.example' -H 'content-type: application/json' -d "{\"link_token\":\"x\",\"org_id\":\"$ORG_ID\"}")
eq "a cross-site approve is refused" "$EVIL" "403"
FORM=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/approve" -b "ae_session=$SESSION" \
  -H "origin: $DASH" -H 'content-type: application/x-www-form-urlencoded' -d 'link_token=x')
eq "a form-encoded approve is refused" "$FORM" "403"
NOSESS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/approve" -H "origin: $DASH" \
  -H 'content-type: application/json' -d '{}')
eq "no session, no approve" "$NOSESS" "401"
for _ in $(seq 1 12); do
  LAST=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/start" -H 'x-forwarded-for: 198.51.100.7' \
    -H 'content-type: application/json' -d '{"machine_label":"flood"}')
done
eq "starts from one address are rate-limited" "$LAST" "429"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
