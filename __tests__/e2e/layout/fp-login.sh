#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# `fp login` from a browser, end to end, for real.
#
# The real `fp` runs in a real pseudo-terminal (cli-login-driver.py). A person's
# half — signing in, approving, denying — happens through the real AgentEye
# dashboard API, with sign-in codes read out of mailpit. Then it checks what
# landed: the saved session, that it works, what the server recorded, and which
# emails went out. Nothing is mocked except a stand-in for a Cloud older than any
# of this, which only has to answer 404.
#
# Needs, all local:
#   - an AgentEye stack: dashboard on $DASH, mailpit API on $MAILPIT, and its
#     containers reachable through `docker exec` / `docker logs`
#   - fp-cloud-cli synced (`uv sync --locked --extra dev`), or FP=<path to fp>
#   - optionally a Cloud with `failproofai config`'s login but not `fp`'s, on
#     $CLOUD_1090 with its Postgres in $PG_1090. Skipped when unset.
#   - optionally the same dashboard image with DASHBOARD_TRUSTED_INGRESS=1 on
#     $TRUSTED_DASH, for the different-network warning. This script plays the ingress
#     by setting the header itself. Skipped when unset.
#
# Not part of `bun run test:e2e`: like the other harnesses here, it is run
# deliberately (see README.md in this directory). It stops and restarts the
# dashboard container once, to test a dropped connection.
#
#   DASH=http://127.0.0.1:43000 MAILPIT=http://127.0.0.1:48026 \
#     STACK=agenteye-fp-login bash __tests__/e2e/layout/fp-login.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DASH=${DASH:-http://127.0.0.1:3000}
MAILPIT=${MAILPIT:-http://127.0.0.1:8026}
STACK=${STACK:-agenteye}
PG_CONTAINER=${PG_CONTAINER:-$STACK-postgres-1}
SERVER_CONTAINER=${SERVER_CONTAINER:-$STACK-server-1}
DASH_CONTAINER=${DASH_CONTAINER:-$STACK-dashboard-1}
REDIS_CONTAINER=${REDIS_CONTAINER:-$STACK-redis-1}
FP=${FP:-$R/fp-cloud-cli/.venv/bin/fp}
CLOUD_1090=${CLOUD_1090:-}
PG_1090=${PG_1090:-}
TRUSTED_DASH=${TRUSTED_DASH:-}
PERSON_DASH=$DASH  # which dashboard a person's calls go to
KEEP=${KEEP:-0}  # 1 = leave the temp dir behind, for reading transcripts
STAMP=$(date +%s)
OUT=$(mktemp -d)
FP_DIR="$OUT/fp-home"
STUB_PID=""
HELD_PID=""
DASH_STOPPED=0

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n       %s\n' "$1" "${2:-}"; }
# Not `printf | grep -q`: on input bigger than a pipe buffer grep exits at the first match,
# printf dies of SIGPIPE, and under pipefail a found string reads as a missing one.
has()   { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1" "missing [$3] in: $(printf '%s' "$2" | tr '\n' ' ' | tail -c 400)"; fi; }
hasnt() { if [[ "$2" == *"$3"* ]]; then bad "$1" "unexpected [$3]"; else ok "$1"; fi; }
eq()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "want [$3] got [$2]"; fi; }
head1() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
jqp() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }
sql() { docker exec "$PG_CONTAINER" psql -U postgres -d agenteye -tAc "$1"; }

cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  [ -n "$HELD_PID" ] && kill "$HELD_PID" 2>/dev/null
  # An interrupted run must not leave someone's stack without its dashboard.
  [ "$DASH_STOPPED" = 1 ] && docker start "$DASH_CONTAINER" >/dev/null 2>&1
  if [ "$KEEP" = 1 ]; then echo "kept: $OUT"; else rm -rf "$OUT"; fi
}
trap cleanup EXIT

# ── A person, through the dashboard ──────────────────────────────────────────

otp_code() { # <email> -> the code from the newest sign-in email
  local email=$1 id="" _
  for _ in $(seq 1 40); do
    id=$(curl -s "$MAILPIT/api/v1/search?query=to:$email&limit=1" | jqp '["messages"][0]["ID"]')
    [ -n "$id" ] && break
    sleep 0.5
  done
  # The CLI's email spaces its digits out; the browser's does not.
  curl -s "$MAILPIT/api/v1/message/$id" | python3 -c 'import sys,json,re;print(re.search(r"\b(\d(?: ?\d){5})\b",json.load(sys.stdin)["Text"]).group(1).replace(" ",""))'
}

# Starts are limited to 10 a minute per address, and with nothing in front of the
# dashboard every local caller is one address. This script starts far more than that.
unthrottle() {
  docker exec "$REDIS_CONTAINER" sh -c "redis-cli --scan --pattern 'ratelimit:cli_login_start:*' | xargs -r redis-cli del; redis-cli --scan --pattern 'ratelimit:cli_login:decide:*' | xargs -r redis-cli del" >/dev/null
}

sign_in() { # <email> -> its session, through the real email-code flow
  local email=$1 code
  curl -s -X DELETE "$MAILPIT/api/v1/search?query=to:$email" >/dev/null || true
  curl -s -X POST "$DASH/api/auth/otp/request" -H 'content-type: application/json' -d "{\"email\":\"$email\"}" >/dev/null
  code=$(otp_code "$email")
  curl -s -D - -o /dev/null -X POST "$DASH/api/auth/otp/verify" -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"code\":\"$code\"}" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: ae_session=\([^;]*\).*/\1/p'
}

person() { # <session> <action> <json> [address] -> body; status in $OUT/status
  local xff=()
  [ -n "${4:-}" ] && xff=(-H "x-forwarded-for: $4")
  curl -s -o "$OUT/body" -w '%{http_code}' -X POST "$PERSON_DASH/api/auth/cli/$2" -b "ae_session=$1" \
    "${xff[@]}" -H "origin: $PERSON_DASH" -H 'content-type: application/json' -d "$3" > "$OUT/status"
  cat "$OUT/body"
}

new_org() { # <session> <slug>
  curl -s -X POST "$DASH/api/orgs" -b "ae_session=$1" -H 'content-type: application/json' \
    -d "{\"slug\":\"$2\",\"name\":\"$2\"}" | jqp '["id"]'
}

link_token() { python3 -c 'import sys,urllib.parse as u;print(u.parse_qs(u.urlparse(sys.argv[1]).query)["r"][0])' "$1"; }
sessions_of() { sql "select count(*) from sessions where user_id = (select id from users where email = '$1')"; }
request_status() { sql "select status from cli_login_requests where link_token_hash = encode(sha256('$1'::bytea), 'hex')"; }
sign_in_mails() { # <email> -> how many sign-in alerts it received
  curl -s -G "$MAILPIT/api/v1/search" --data-urlencode "query=to:$1 subject:\"new sign-in\"" | jqp '["messages_count"]'
}
wait_sign_in_mail() { for _ in $(seq 1 30); do [ "$(sign_in_mails "$1")" != 0 ] && return; sleep 0.5; done; }
sign_in_mail_text() {
  local id
  id=$(curl -s -G "$MAILPIT/api/v1/search" --data-urlencode "query=to:$1 subject:\"new sign-in\"" | jqp '["messages"][0]["ID"]')
  curl -s "$MAILPIT/api/v1/message/$id" | jqp '["Text"]'
}

# ── The terminal ─────────────────────────────────────────────────────────────

# Run `fp` under the pty driver in the background. No display and an SSH marker by
# default, so nothing here ever opens a browser on the machine running it.
# <name> <script> <base-url> [env assignments...] -- <fp args...>
run_fp() {
  local name=$1 script=$2 base=$3; shift 3
  local extra=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  rm -f "$OUT/$name".*
  unthrottle
  ( env -u DISPLAY -u WAYLAND_DISPLAY -u SSH_CONNECTION -u SSH_CLIENT -u FP_TOKEN -u FP_API_KEY -u FP_ORG \
      -u FP_DASHBOARD_URL -u FAILPROOFAI_HOME \
      SSH_TTY=e2e TERM=xterm-256color NO_COLOR=1 FP_ANALYTICS_DISABLED=1 FP_HOME="$FP_DIR" "${extra[@]}" \
      python3 "$R/__tests__/e2e/layout/cli-login-driver.py" "$script" "$OUT/$name.log" "$OUT/$name.url" \
      -- "$FP" --base-url "$base" "$@" ; echo $? > "$OUT/$name.rc" ) 2>"$OUT/$name.err" &
}

wait_url() { # <name> -> the link fp printed
  local _
  for _ in $(seq 1 120); do
    if [ -s "$OUT/$1.url" ]; then cat "$OUT/$1.url"; rm -f "$OUT/$1.url"; return; fi
    sleep 0.25
  done
}

wait_done() { # <name> -> transcript with the terminal codes taken out
  local _
  for _ in $(seq 1 480); do [ -f "$OUT/$1.rc" ] && break; sleep 0.25; done
  transcript "$1"
}
transcript() { sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$OUT/$1.log" 2>/dev/null | tr -d '\r'; }

fp_plain() { # <base-url> <fp args...>, no terminal
  local base=$1; shift
  env -u FP_TOKEN -u FP_API_KEY -u FP_ORG -u FP_DASHBOARD_URL -u FAILPROOFAI_HOME \
    NO_COLOR=1 FP_ANALYTICS_DISABLED=1 FP_HOME="$FP_DIR" "$FP" --base-url "$base" "$@"
}

saved() { python3 -c "import json;print(json.load(open('$FP_DIR/cli-auth.json')).get('$1') or '')" 2>/dev/null; }
reset_fp() { rm -rf "$FP_DIR"; }

EMAIL_STEP=wait:tab\ browser\ or\ SSO

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 0 — preconditions"
curl -s -m 5 -o /dev/null "$DASH/login" && ok "dashboard is up on $DASH" || bad "dashboard is up" "$DASH/login"
curl -s -m 5 -o /dev/null "$MAILPIT/api/v1/messages" && ok "mailpit is up on $MAILPIT" || bad "mailpit is up" "$MAILPIT"
[ -n "$(sql 'select 1' 2>/dev/null)" ] && ok "Postgres reachable via $PG_CONTAINER" || bad "Postgres reachable" "$PG_CONTAINER"
[ -x "$FP" ] && ok "fp is built" || bad "fp is built" "cd fp-cloud-cli && uv sync --locked --extra dev"
[ "$FAIL" = 0 ] || { echo "preconditions failed"; exit 1; }

ONE="fp-one-$STAMP@example.test"
ONE_SESSION=$(sign_in "$ONE")
[ -n "$(new_org "$ONE_SESSION" "fp-one-$STAMP")" ] && ok "a person with one org" || bad "a person with one org" "no org"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 1 — browser login: the link, the approval, and the terminal finishes alone"
run_fp first "$EMAIL_STEP,key:tab,url" "$DASH" -- login
URL=$(wait_url first)
has "fp printed the authorize link" "$URL" "$DASH/cli/authorize?r="
LINK=$(link_token "$URL")
PAGE=$(person "$ONE_SESSION" lookup "{\"link_token\":\"$LINK\"}")
eq "the page sees a pending request" "$(echo "$PAGE" | jqp '["status"]')" "pending"
eq "…of the session kind" "$(echo "$PAGE" | jqp '["kind"]')" "session"
eq "…for this machine" "$(echo "$PAGE" | jqp '["machine"]["label"]')" "$(hostname)"
eq "…offering no org to pick" "$(echo "$PAGE" | jqp '["orgs"]')" "[]"
BEFORE=$(sessions_of "$ONE")
sleep 3
eq "nothing is created while it waits" "$(sessions_of "$ONE")" "$BEFORE"
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
eq "approve answered 200" "$(cat "$OUT/status")" "200"
T=$(wait_done first)
eq "fp exited 0" "$(cat "$OUT/first.rc")" "0"
has "it opens on the email, offering the browser" "$T" "tab browser or SSO"
has "…and saying enter sends a code" "$T" "send a code"
has "no display here, so it says the link works anywhere" "$T" "open this link on any device"
has "it waited with a countdown" "$T" "waiting for you to authorize"
has "it says it signed in" "$T" "signed in"
has "…as the person who approved" "$T" "$ONE"
# In the raw bytes: the window is 100 wide, the link wider, and nothing but the terminal may
# wrap it. A line break from Rich would break it for a click or a copy, and so would writing it
# again with the spinner, which clears a selection.
LINE=$(grep -caP '^(\r|\x1b\[[0-9;?]*[A-Za-z])*  (\x1b\[[0-9;]*m)?https?://\S+/cli/authorize\?r=[0-9a-f]{64}(\x1b\[[0-9;]*m)?\r?$' "$OUT/first.log")
eq "the link is one unbroken run on its own line, in the box" "$LINE" "1"
eq "…written once, not again with the spinner" "$(grep -ao 'cli/authorize?r=' "$OUT/first.log" | wc -l)" "1"
eq "one more session on the server" "$(sessions_of "$ONE")" "$((BEFORE + 1))"
eq "the request is spent" "$(request_status "$LINK")" "claimed"
eq "no machine key came of it" "$(sql "select count(*) from api_keys where created_by_user_id = (select id from users where email = '$ONE')")" "0"
TOKEN=$(saved session_token)
[ -n "$TOKEN" ] && ok "the session was saved" || bad "the session was saved" "cli-auth.json"
eq "saved owner-only" "$(stat -c '%a' "$FP_DIR/cli-auth.json")" "600"
eq "saved the org it auto-picked" "$(saved org)" "fp-one-$STAMP"
hasnt "the token never appears in the terminal" "$T" "$TOKEN"
WHO=$(fp_plain "$DASH" --json whoami)
eq "the saved session works" "$(echo "$WHO" | jqp '["email"]')" "$ONE"
eq "…as a person, not a key" "$(echo "$WHO" | jqp '["auth_mode"]')" "session"
ORGS=$(fp_plain "$DASH" --json orgs list 2>&1)
has "a command an API key is refused works" "$ORGS" "fp-one-$STAMP"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 2 — signed in already: no asking; --force asks again"
run_fp again "wait:$ONE" "$DASH" -- login
T=$(wait_done again)
eq "fp exited 0" "$(cat "$OUT/again.rc")" "0"
hasnt "no asking someone already signed in" "$T" "tab browser or SSO"
run_fp force "$EMAIL_STEP,key:esc" "$DASH" -- login --force
T=$(wait_done force)
eq "--force asks, and esc leaves it" "$(cat "$OUT/force.rc")" "0"
has "…saying nothing changed" "$T" "cancelled"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 3 — several orgs: picked in the terminal, or by --org"
TWO="fp-two-$STAMP@example.test"
TWO_SESSION=$(sign_in "$TWO")
new_org "$TWO_SESSION" "fp-a-$STAMP" >/dev/null
new_org "$TWO_SESSION" "fp-b-$STAMP" >/dev/null
reset_fp
run_fp pick "$EMAIL_STEP,key:tab,url,wait:choose your org,key:down,key:enter" "$DASH" -- login
LINK=$(link_token "$(wait_url pick)")
person "$TWO_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
T=$(wait_done pick)
eq "fp exited 0" "$(cat "$OUT/pick.rc")" "0"
PICKED=$(saved org)
[ "$PICKED" = "fp-a-$STAMP" ] || [ "$PICKED" = "fp-b-$STAMP" ] && ok "the org picked in the terminal was saved" || bad "the org was saved" "$PICKED"
reset_fp
run_fp flag "$EMAIL_STEP,key:tab,url" "$DASH" -- login --org "fp-b-$STAMP"
LINK=$(link_token "$(wait_url flag)")
person "$TWO_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
T=$(wait_done flag)
eq "--org skips the picker" "$(saved org)" "fp-b-$STAMP"
hasnt "…no picker shown" "$T" "choose your org"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 4 — the email code still works, from the first screen and with --email"
reset_fp
MAILED="fp-mail-$STAMP@example.test"
curl -s -X DELETE "$MAILPIT/api/v1/search?query=to:$MAILED" >/dev/null || true
rm -f "$OUT/code"
run_fp menu_mail "$EMAIL_STEP,type:$MAILED,key:enter,wait:enter the 6-digit code,typefile:$OUT/code,key:enter" "$DASH" -- login
CODE=$(otp_code "$MAILED"); echo "$CODE" > "$OUT/code"
T=$(wait_done menu_mail)
eq "fp exited 0" "$(cat "$OUT/menu_mail.rc")" "0"
eq "the emailed code signed in" "$(saved email)" "$MAILED"
hasnt "no link was offered" "$T" "/cli/authorize"
eq "the email code path sends no sign-in alert" "$(sign_in_mails "$MAILED")" "0"
reset_fp
curl -s -X DELETE "$MAILPIT/api/v1/search?query=to:$MAILED" >/dev/null || true
rm -f "$OUT/code"
run_fp flag_mail "wait:enter the 6-digit code,typefile:$OUT/code,key:enter" "$DASH" -- login --email "$MAILED"
CODE=$(otp_code "$MAILED"); echo "$CODE" > "$OUT/code"
T=$(wait_done flag_mail)
eq "--email signed in" "$(saved email)" "$MAILED"
hasnt "--email skips the asking" "$T" "tab browser or SSO"
reset_fp
OUTPUT=$(env -u FP_TOKEN -u FP_API_KEY NO_COLOR=1 FP_ANALYTICS_DISABLED=1 FP_HOME="$FP_DIR" "$FP" --base-url "$DASH" login </dev/null 2>&1)
hasnt "no terminal: no offer of a browser" "$OUTPUT" "tab browser or SSO"
hasnt "no terminal: no link" "$OUTPUT" "/cli/authorize"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 5 — not authorized: enter for a new link, tab back to the email, esc to leave"
reset_fp
run_fp deny "$EMAIL_STEP,key:tab,url,wait:not authorized,key:enter,url" "$DASH" -- login
LINK1=$(link_token "$(wait_url deny)")
person "$ONE_SESSION" deny "{\"link_token\":\"$LINK1\"}" >/dev/null
eq "deny answered 200" "$(cat "$OUT/status")" "200"
LINK2=$(link_token "$(wait_url deny)")
[ -n "$LINK2" ] && [ "$LINK1" != "$LINK2" ] && ok "enter fetched a NEW link" || bad "enter fetched a new link" "$LINK2"
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK2\"}" >/dev/null
T=$(wait_done deny)
eq "fp exited 0 on the new link" "$(cat "$OUT/deny.rc")" "0"
eq "signed in" "$(saved email)" "$ONE"
eq "the denied request stays denied" "$(request_status "$LINK1")" "denied"
reset_fp
BEFORE=$(sessions_of "$ONE")
run_fp back "$EMAIL_STEP,key:tab,url,wait:not authorized,key:tab,$EMAIL_STEP,key:esc" "$DASH" -- login
LINK=$(link_token "$(wait_url back)")
person "$ONE_SESSION" deny "{\"link_token\":\"$LINK\"}" >/dev/null
T=$(wait_done back)
eq "tab went back to the email, and esc left" "$(cat "$OUT/back.rc")" "0"
has "…calmly" "$T" "cancelled"
eq "…with nothing saved" "$(saved session_token)" ""
reset_fp
run_fp leave "$EMAIL_STEP,key:tab,url,wait:not authorized,key:esc" "$DASH" -- login
LINK=$(link_token "$(wait_url leave)")
person "$ONE_SESSION" deny "{\"link_token\":\"$LINK\"}" >/dev/null
T=$(wait_done leave)
eq "esc at not authorized leaves, like everywhere else" "$(cat "$OUT/leave.rc")" "0"
has "…calmly" "$T" "cancelled"

# Tab goes to the link and back, and it stays the same link: another each time would spend the
# rate limit, leave rows behind, and open another browser tab.
reset_fp
ROWS=$(sql "select count(*) from cli_login_requests")
run_fp toggle "$EMAIL_STEP,type:half@,key:tab,url,wait:waiting for you,key:tab,wait:half@,key:tab,url,wait:waiting for you" "$DASH" -- login
LINK=$(link_token "$(wait_url toggle)")
until [ "$(grep -ao 'cli/authorize?r=' "$OUT/toggle.log" | wc -l)" = 2 ]; do sleep 0.1; done
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
T=$(wait_done toggle)
eq "tab there and back still signs in" "$(cat "$OUT/toggle.rc")" "0"
has "…what was typed came back" "$(transcript toggle | sed -n '/waiting for you/,$p')" "half@"
eq "…the same link both times" "$(grep -aoP 'authorize\?r=\K[0-9a-f]{64}' "$OUT/toggle.log" | sort -u | wc -l)" "1"
eq "…one request on the server" "$(sql "select count(*) from cli_login_requests")" "$((ROWS + 1))"
eq "…signed in" "$(saved email)" "$ONE"

# Approved while the person was back at the email: coming back finds it.
reset_fp
run_fp later "$EMAIL_STEP,key:tab,url,wait:waiting for you,key:tab,wait:send a code,sleep:4,key:tab" "$DASH" -- login
LINK=$(link_token "$(wait_url later)")
until transcript later | sed -n '/waiting for you/,$p' | grep -q 'send a code'; do sleep 0.1; done
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
sleep 1
eq "an approval given at the email waits" "$(request_status "$LINK")" "approved"
T=$(wait_done later)
eq "…and coming back collects it" "$(cat "$OUT/later.rc")" "0"
eq "…signed in" "$(saved email)" "$ONE"
eq "…the request spent" "$(request_status "$LINK")" "claimed"

# Left at the email with the approval unclaimed: nobody collects it, so it makes nothing.
reset_fp
BEFORE=$(sessions_of "$ONE")
run_fp nocollect "$EMAIL_STEP,key:tab,url,wait:waiting for you,key:tab,wait:send a code,sleep:3,key:esc" "$DASH" -- login
LINK=$(link_token "$(wait_url nocollect)")
until transcript nocollect | sed -n '/waiting for you/,$p' | grep -q 'send a code'; do sleep 0.1; done
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
T=$(wait_done nocollect)
eq "esc at the email with an approval waiting exits 0" "$(cat "$OUT/nocollect.rc")" "0"
eq "…and no session is made" "$(sessions_of "$ONE")" "$BEFORE"
eq "…nothing saved" "$(saved session_token)" ""
eq "…and no session" "$(sessions_of "$ONE")" "$BEFORE"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 6 — a link that expires offers a fresh one"
reset_fp
run_fp expire "$EMAIL_STEP,key:tab,url,wait:that link expired,key:enter,url" "$DASH" -- login
LINK1=$(link_token "$(wait_url expire)")
sql "update cli_login_requests set expires_at = now() - interval '1 second' where link_token_hash = encode(sha256('$LINK1'::bytea), 'hex')" >/dev/null
LINK2=$(link_token "$(wait_url expire)")
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK2\"}" >/dev/null
T=$(wait_done expire)
eq "fp exited 0 on the fresh link" "$(cat "$OUT/expire.rc")" "0"
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK1\"}" >/dev/null
eq "the expired link can no longer be approved" "$(cat "$OUT/status")" "410"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 7 — leaving: esc, ctrl-c, and an approval nobody collects"
reset_fp
run_fp esc "$EMAIL_STEP,key:tab,url,wait:waiting for you,key:esc" "$DASH" -- login
LINK=$(link_token "$(wait_url esc)")
T=$(wait_done esc)
eq "esc while waiting exits 0" "$(cat "$OUT/esc.rc")" "0"
has "…calmly" "$T" "cancelled"
eq "…with nothing saved" "$(saved session_token)" ""
BEFORE=$(sessions_of "$ONE")
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
eq "the abandoned link can still be approved" "$(cat "$OUT/status")" "200"
sleep 3
eq "…but no session ever exists: nobody claimed it" "$(sessions_of "$ONE")" "$BEFORE"
eq "…and it stays unclaimed" "$(request_status "$LINK")" "approved"
run_fp ctrlc "$EMAIL_STEP,key:tab,url,wait:waiting for you,key:ctrl-c" "$DASH" -- login
wait_url ctrlc >/dev/null
T=$(wait_done ctrlc)
eq "ctrl-c while waiting exits 0" "$(cat "$OUT/ctrlc.rc")" "0"
has "…calmly" "$T" "cancelled"

# A person who presses esc while a poll is in flight has said no, even if that poll comes
# back approved. Only a stand-in can hold a poll open, so this one records every claim.
python3 - "$OUT/held.port" "$OUT/held.claims" "$OUT/held.mode" "$OUT/held.starts" <<'PY' &
import http.server, json, os, sys, time
def mode():
    return open(sys.argv[3]).read().strip() if os.path.exists(sys.argv[3]) else ""
class H(http.server.BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.reply(200, {"id": "u1", "email": "held@example.test", "is_instance_admin": False, "memberships": []})
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.path.endswith("/start"):
            open(sys.argv[4], "a").write("start\n")
            if mode() == "slow-start":
                time.sleep(8)
            self.reply(201, {"verification_url": f"http://{self.headers['host']}/cli/authorize?r=" + "a" * 64,
                             "poll_secret": "p", "expires_in": 600, "interval": 1, "kind": "session"})
        elif self.path.endswith("/poll"):
            if mode() != "slow-claim":
                time.sleep(4)
            self.reply(200, {"status": "denied" if mode() == "denied" else "approved"})
        elif self.path.endswith("/claim"):
            open(sys.argv[2], "a").write("claim\n")
            if mode() == "slow-claim":
                time.sleep(8)
            self.reply(201, {"session_token": "HELD-TOKEN", "expires_in_secs": 3600,
                             "user": {"id": "u1", "email": "held@example.test"}})
    def log_message(self, *a): pass
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_address[1]))
s.serve_forever()
PY
HELD_PID=$!
for _ in $(seq 1 40); do [ -s "$OUT/held.port" ] && break; sleep 0.1; done
HELD="http://127.0.0.1:$(cat "$OUT/held.port")"
reset_fp
run_fp held "$EMAIL_STEP,key:tab,url,wait:waiting for you,sleep:2,key:esc" "$HELD" -- login
wait_url held >/dev/null
T=$(wait_done held)
eq "esc during a poll that comes back approved exits 0" "$(cat "$OUT/held.rc")" "0"
has "…calmly" "$T" "cancelled"
eq "…with no claim" "$(cat "$OUT/held.claims" 2>/dev/null | wc -l)" "0"
eq "…and nothing saved" "$(saved session_token)" ""
reset_fp
run_fp heldutf "$EMAIL_STEP,key:tab,url,wait:waiting for you,sleep:1,type:é,key:esc" "$HELD" -- login
wait_url heldutf >/dev/null
T=$(wait_done heldutf)
has "esc after a non-ASCII key, same poll: calm too" "$T" "cancelled"
eq "…with no claim" "$(cat "$OUT/held.claims" 2>/dev/null | wc -l)" "0"
eq "…and nothing saved" "$(saved session_token)" ""
reset_fp
run_fp notheld "$EMAIL_STEP,key:tab,url" "$HELD" -- login
wait_url notheld >/dev/null
T=$(wait_done notheld)
eq "the same poll with no key pressed does claim, so the stand-in is a fair test" "$(cat "$OUT/held.claims" 2>/dev/null | wc -l)" "1"

# Enter pressed during a poll that comes back denied was pressed at a screen that's gone.
reset_fp
echo denied > "$OUT/held.mode"
rm -f "$OUT/held.starts"
run_fp heldenter "$EMAIL_STEP,key:tab,url,wait:waiting for you,sleep:1,key:enter,wait:not authorized,sleep:2,key:esc" "$HELD" -- login
wait_url heldenter >/dev/null
T=$(wait_done heldenter)
eq "enter during a poll that comes back denied doesn't take a new link" "$(wc -l < "$OUT/held.starts")" "1"
has "…the denial stays on screen until it's answered" "$T" "new link"
eq "…and the person can still leave" "$(cat "$OUT/heldenter.rc")" "0"
reset_fp
rm -f "$OUT/held.starts"
run_fp heldescdeny "$EMAIL_STEP,key:tab,url,wait:waiting for you,sleep:1,key:esc" "$HELD" -- login
wait_url heldescdeny >/dev/null
T=$(wait_done heldescdeny)
eq "esc during a poll that comes back denied exits 0" "$(cat "$OUT/heldescdeny.rc")" "0"
has "…calmly, as the screen promised" "$T" "cancelled"
eq "…with one link" "$(wc -l < "$OUT/held.starts")" "1"

# Ctrl-C at any request, not only during a poll.
reset_fp
echo slow-start > "$OUT/held.mode"
run_fp heldstart "$EMAIL_STEP,key:tab,wait:asking for a link,sleep:1,key:ctrl-c" "$HELD" -- login
T=$(wait_done heldstart)
eq "ctrl-c while asking for a link exits 0" "$(cat "$OUT/heldstart.rc")" "0"
has "…calmly" "$T" "cancelled"
reset_fp
echo slow-claim > "$OUT/held.mode"
rm -f "$OUT/held.claims"
run_fp heldclaim "$EMAIL_STEP,key:tab,url,wait:finishing sign-in,sleep:1,key:ctrl-c" "$HELD" -- login
wait_url heldclaim >/dev/null
T=$(wait_done heldclaim)
eq "ctrl-c while finishing exits 0" "$(cat "$OUT/heldclaim.rc")" "0"
has "…calmly" "$T" "cancelled"
eq "…and saves nothing" "$(saved session_token)" ""
kill "$HELD_PID" 2>/dev/null

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 8 — a dropped connection is not an answer"
reset_fp
run_fp drop "$EMAIL_STEP,key:tab,url,wait:waiting for you,wait:reconnecting,wait:waiting for you" "$DASH" -- login
LINK=$(link_token "$(wait_url drop)")
DASH_STOPPED=1
docker stop -t 0 "$DASH_CONTAINER" >/dev/null
sleep 5
docker start "$DASH_CONTAINER" >/dev/null
DASH_STOPPED=0
for _ in $(seq 1 60); do curl -s -m 2 -o /dev/null "$DASH/login" && break; sleep 0.5; done
ok "the dashboard went away and came back"
# Only once it says it's waiting again, or the very next poll is the approval and it never does.
for _ in $(seq 1 60); do
  sed 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$OUT/drop.log" | grep -a -E 'reconnecting|waiting for you' | tail -1 | grep -q 'waiting for you' && break
  sleep 0.5
done
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
T=$(wait_done drop)
eq "fp finished on the same link" "$(cat "$OUT/drop.rc")" "0"
has "…after saying it was reconnecting" "$T" "reconnecting"
eq "…and signed in" "$(saved email)" "$ONE"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 9 — where a browser can open, it opens"
reset_fp
mkdir -p "$OUT/bin"
printf '#!/bin/sh\necho "$@" > "%s/opened"\n' "$OUT" > "$OUT/bin/xdg-open"
chmod +x "$OUT/bin/xdg-open"
rm -f "$OUT/opened"
run_fp opens "$EMAIL_STEP,key:tab,url,wait:waiting for you,key:esc" "$DASH" DISPLAY=:99 SSH_TTY= PATH="$OUT/bin:$PATH" -- login
URL=$(wait_url opens)
T=$(wait_done opens)
for _ in $(seq 1 20); do [ -s "$OUT/opened" ] && break; sleep 0.25; done
eq "the handler got exactly the link" "$(cat "$OUT/opened" 2>/dev/null)" "$URL"
has "…and the link is on screen as well" "$T" "if nothing appears, open this link"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 10 — a Cloud without this: the email code takes over, and nothing is minted"
python3 - "$OUT/stub.port" <<'PY' &
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def _404(self):
        self.send_response(404); self.send_header("content-length", "0"); self.end_headers()
    do_GET = do_POST = _404
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_address[1]))
s.serve_forever()
PY
STUB_PID=$!
for _ in $(seq 1 40); do [ -s "$OUT/stub.port" ] && break; sleep 0.1; done
reset_fp
run_fp old404 "$EMAIL_STEP,key:tab,wait:no browser login,wait:send a code,key:esc" "http://127.0.0.1:$(cat "$OUT/stub.port")" -- login
T=$(wait_done old404)
eq "a Cloud with no such route falls through to the email step" "$(cat "$OUT/old404.rc")" "0"
has "…saying why" "$T" "this Cloud has no browser login yet"
if [ -n "$CLOUD_1090" ]; then
  reset_fp
  KEYS_BEFORE=$(docker exec "$PG_1090" psql -U postgres -d agenteye -tAc "select count(*) from api_keys where created_via = 'cli_login'")
  STARTED_BEFORE=$(docker exec "$PG_1090" psql -U postgres -d agenteye -tAc "select count(*) from cli_login_requests")
  run_fp old1090 "$EMAIL_STEP,key:tab,wait:no browser login,wait:send a code,key:esc" "$CLOUD_1090" -- login
  T=$(wait_done old1090)
  eq "a Cloud with only \`failproofai config\`'s login falls through too" "$(cat "$OUT/old1090.rc")" "0"
  has "…saying why" "$T" "this Cloud has no browser login yet"
  hasnt "…never offering its machine-key link" "$T" "/cli/authorize"
  eq "…its request is left pending, for nobody" "$(docker exec "$PG_1090" psql -U postgres -d agenteye -tAc "select count(*) from cli_login_requests where status <> 'pending'")" "0"
  eq "…one row, as the old route always makes" "$(docker exec "$PG_1090" psql -U postgres -d agenteye -tAc "select count(*) from cli_login_requests")" "$((STARTED_BEFORE + 1))"
  eq "…and no key" "$(docker exec "$PG_1090" psql -U postgres -d agenteye -tAc "select count(*) from api_keys where created_via = 'cli_login'")" "$KEYS_BEFORE"
else
  printf '  \033[33mSKIP\033[0m a Cloud with only failproofai config'"'"'s login (set CLOUD_1090 and PG_1090)\n'
fi

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 11 — no trusted ingress: no address is believed, and the email always goes out"
api_start() { # <dashboard> <address> -> start response
  unthrottle
  curl -s -X POST "$1/api/auth/cli/start" -H "x-forwarded-for: $2" -H 'content-type: application/json' \
    -d '{"machine_label":"e2e-box","machine_os":"linux","cli_version":"fp e2e","kind":"session"}'
}
api_claim() { curl -s -X POST "$1/api/auth/cli/claim" -H 'content-type: application/json' -d "{\"poll_secret\":\"$2\"}"; }
requester_of() { sql "select coalesce(requester_address, 'none') from cli_login_requests where link_token_hash = encode(sha256('$1'::bytea), 'hex')"; }

# What a forger would do with nothing in front of the dashboard: write the victim's own
# address on the request that starts the login.
FORGED="fp-forged-$STAMP@example.test"
FORGED_SESSION=$(sign_in "$FORGED")
S=$(api_start "$DASH" 203.0.113.7)
LINK=$(link_token "$(echo "$S" | jqp '["verification_url"]')")
SECRET=$(echo "$S" | jqp '["poll_secret"]')
eq "a forged address is not stored" "$(requester_of "$LINK")" "none"
PAGE=$(person "$FORGED_SESSION" lookup "{\"link_token\":\"$LINK\"}" 203.0.113.7)
eq "…and the page has nothing to compare" "$(echo "$PAGE" | jqp '["different_network"]')" "False"
eq "…so it names no address" "$(echo "$PAGE" | jqp '["requester_address"]')" "None"
person "$FORGED_SESSION" approve "{\"link_token\":\"$LINK\"}" 203.0.113.7 >/dev/null
C=$(api_claim "$DASH" "$SECRET")
has "the session is handed over" "$C" "session_token"
CLAIMED_TOKEN=$(echo "$C" | jqp '["session_token"]')
wait_sign_in_mail "$FORGED"
eq "…and matching forged addresses can't silence the email" "$(sign_in_mails "$FORGED")" "1"
M=$(sign_in_mail_text "$FORGED")
has "…naming the machine" "$M" "fp on e2e-box signed in"
has "…and what that terminal now has" "$M" "in all your organizations"
hasnt "…not claiming to know where it started" "$M" "started from"
hasnt "…and carrying no secret" "$M" "$CLAIMED_TOKEN"

# The real `fp`, same machine, on a deployment like this one.
PLAIN="fp-plain-$STAMP@example.test"
PLAIN_SESSION=$(sign_in "$PLAIN")
reset_fp
run_fp plainbox "$EMAIL_STEP,key:tab,url" "$DASH" -- login
LINK=$(link_token "$(wait_url plainbox)")
PAGE=$(person "$PLAIN_SESSION" lookup "{\"link_token\":\"$LINK\"}")
eq "the real fp: no warning" "$(echo "$PAGE" | jqp '["different_network"]')" "False"
person "$PLAIN_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
wait_done plainbox >/dev/null
wait_sign_in_mail "$PLAIN"
eq "…and the email goes out" "$(sign_in_mails "$PLAIN")" "1"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 11b — behind a trusted ingress: the warning, and an email only when it matters"
if [ -n "$TRUSTED_DASH" ]; then
  PERSON_DASH=$TRUSTED_DASH
  AWAY="fp-away-$STAMP@example.test"
  AWAY_SESSION=$(sign_in "$AWAY")
  S=$(api_start "$TRUSTED_DASH" 203.0.113.17)
  LINK=$(link_token "$(echo "$S" | jqp '["verification_url"]')")
  SECRET=$(echo "$S" | jqp '["poll_secret"]')
  eq "the address that started it is kept" "$(requester_of "$LINK")" "203.0.113.17"
  PAGE=$(person "$AWAY_SESSION" lookup "{\"link_token\":\"$LINK\"}" 198.51.100.9)
  eq "another network: the page warns" "$(echo "$PAGE" | jqp '["different_network"]')" "True"
  eq "…and names the address" "$(echo "$PAGE" | jqp '["requester_address"]')" "203.0.113.17"
  person "$AWAY_SESSION" approve "{\"link_token\":\"$LINK\",\"client_address\":\"203.0.113.17\"}" 198.51.100.9 >/dev/null
  C=$(api_claim "$TRUSTED_DASH" "$SECRET")
  has "…the session is still handed over: it warns, it doesn't block" "$C" "session_token"
  wait_sign_in_mail "$AWAY"
  eq "…one email, even though the page forged a matching address" "$(sign_in_mails "$AWAY")" "1"
  has "…saying where the login started" "$(sign_in_mail_text "$AWAY")" "The login started from 203.0.113.17"

  SAME="fp-same-$STAMP@example.test"
  SAME_SESSION=$(sign_in "$SAME")
  S=$(api_start "$TRUSTED_DASH" 203.0.113.18)
  LINK=$(link_token "$(echo "$S" | jqp '["verification_url"]')")
  SECRET=$(echo "$S" | jqp '["poll_secret"]')
  PAGE=$(person "$SAME_SESSION" lookup "{\"link_token\":\"$LINK\"}" 203.0.113.18)
  eq "the same network: no warning" "$(echo "$PAGE" | jqp '["different_network"]')" "False"
  eq "…and no address" "$(echo "$PAGE" | jqp '["requester_address"]')" "None"
  person "$SAME_SESSION" approve "{\"link_token\":\"$LINK\"}" 203.0.113.18 >/dev/null
  api_claim "$TRUSTED_DASH" "$SECRET" >/dev/null
  sleep 4
  eq "…and no email" "$(sign_in_mails "$SAME")" "0"

  # The real `fp`, approved from somewhere else: what a phished link looks like.
  LOCAL="fp-local-$STAMP@example.test"
  LOCAL_SESSION=$(sign_in "$LOCAL")
  reset_fp
  run_fp elsewhere "$EMAIL_STEP,key:tab,url" "$TRUSTED_DASH" -- login
  LINK=$(link_token "$(wait_url elsewhere)")
  PAGE=$(person "$LOCAL_SESSION" lookup "{\"link_token\":\"$LINK\"}" 198.51.100.50)
  eq "the real fp, approved elsewhere: the page warns" "$(echo "$PAGE" | jqp '["different_network"]')" "True"
  person "$LOCAL_SESSION" approve "{\"link_token\":\"$LINK\"}" 198.51.100.50 >/dev/null
  T=$(wait_done elsewhere)
  eq "…and fp still finishes: a warning, not a block" "$(cat "$OUT/elsewhere.rc")" "0"
  wait_sign_in_mail "$LOCAL"
  eq "…with one email" "$(sign_in_mails "$LOCAL")" "1"
  has "…naming the machine" "$(sign_in_mail_text "$LOCAL")" "fp on $(hostname) signed in"
  PERSON_DASH=$DASH
else
  printf '  \033[33mSKIP\033[0m the different-network warning (set TRUSTED_DASH)\n'
fi

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 12 — what must be refused"
S=$(api_start "$DASH" 203.0.113.9)
LINK=$(link_token "$(echo "$S" | jqp '["verification_url"]')")
SECRET=$(echo "$S" | jqp '["poll_secret"]')
BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/start" -H 'x-forwarded-for: 203.0.113.10' -H 'content-type: application/json' -d '{"machine_label":"x","kind":"root"}')
eq "an unknown kind is refused" "$BAD" "422"
EVIL=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/approve" -b "ae_session=$ONE_SESSION" \
  -H 'origin: https://evil.example' -H 'content-type: application/json' -d "{\"link_token\":\"$LINK\"}")
eq "a cross-site approve is refused" "$EVIL" "403"
FORM=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/approve" -b "ae_session=$ONE_SESSION" \
  -H "origin: $DASH" -H 'content-type: application/x-www-form-urlencoded' -d "link_token=$LINK")
eq "a form-encoded approve is refused" "$FORM" "403"
NOSESS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/approve" -H "origin: $DASH" \
  -H 'content-type: application/json' -d "{\"link_token\":\"$LINK\"}")
eq "no session, no approve" "$NOSESS" "401"
EARLY=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/claim" -H 'content-type: application/json' -d "{\"poll_secret\":\"$SECRET\"}")
eq "no claim before approval" "$EARLY" "409"
LINKCLAIM=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/claim" -H 'content-type: application/json' -d "{\"poll_secret\":\"$LINK\"}")
eq "the link cannot claim" "$LINKCLAIM" "404"
# Sessions never slide. One that could approve its own replacement would never end.
person "$CLAIMED_TOKEN" lookup "{\"link_token\":\"$LINK\"}" >/dev/null
eq "a session claimed from a link can look at another link" "$(cat "$OUT/status")" "200"
person "$CLAIMED_TOKEN" approve "{\"link_token\":\"$LINK\"}" >/dev/null
eq "…but can't approve it, or it would renew itself for ever" "$(cat "$OUT/status")" "403"
eq "…which leaves that link pending" "$(request_status "$LINK")" "pending"
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
FIRST=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/claim" -H 'content-type: application/json' -d "{\"poll_secret\":\"$SECRET\"}")
SECOND=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$DASH/api/auth/cli/claim" -H 'content-type: application/json' -d "{\"poll_secret\":\"$SECRET\"}")
eq "the first claim works" "$FIRST" "201"
eq "…and only the first" "$SECOND" "409"
CACHE=$(curl -s -D - -o /dev/null -X POST "$DASH/api/auth/cli/claim" -H 'content-type: application/json' -d "{\"poll_secret\":\"$SECRET\"}" | tr -d '\r' | grep -i '^cache-control')
has "a claim answer is never cacheable" "$CACHE" "no-store"

# ═════════════════════════════════════════════════════════════════════════════
head1 "PHASE 13 — logout, and no secret in any log"
reset_fp
run_fp last "$EMAIL_STEP,key:tab,url" "$DASH" -- login
LINK=$(link_token "$(wait_url last)")
person "$ONE_SESSION" approve "{\"link_token\":\"$LINK\"}" >/dev/null
wait_done last >/dev/null
TOKEN=$(saved session_token)
eq "signed in" "$(saved email)" "$ONE"
fp_plain "$DASH" logout >/dev/null 2>&1
eq "logout clears the saved session" "$(saved session_token)" ""
eq "…and revokes it on the server" "$(sql "select revoked_at is not null from sessions where token_hash = encode(sha256('$TOKEN'::bytea), 'hex')")" "t"
for c in "$SERVER_CONTAINER" "$DASH_CONTAINER"; do
  L=$(docker logs "$c" 2>&1)
  hasnt "$c logs no session token" "$L" "$TOKEN"
  hasnt "$c logs no session token from the emails phase" "$L" "$CLAIMED_TOKEN"
  hasnt "$c logs no poll secret" "$L" "$SECRET"
done

printf '\n\033[1m%s passed, %s failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
