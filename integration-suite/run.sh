#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# failproofai integration suite — orchestrator (runs on the GitHub Actions runner).
#   ./run.sh [cli ...]      default: all 12
#
# Mirrors the box's run-canary.sh, but every path is env-parameterised (the
# runner is ephemeral) and the report is POSTed to a Slack Incoming Webhook
# instead of delivered via Hermes. Assumes ci-entrypoint.sh has already:
#   • checked out + built failproofai (dist/index.js + dist/cli.mjs) at $CANARY_REPO
#   • built the sandbox image ($CANARY_IMAGE)
#   • created the per-run volume ($CANARY_VOL) and INSTALLED the CLIs into it
#   • injected OAuth token files into the volume (inject-tokens.sh)
#   • assembled the gateway/PAT env-file ($CANARY_ENVFILE)
#
# VERSION-GATING (identical to the box): a CLI is re-probed only when its own
# binary version OR failproofai's HEAD changed since its last GREEN run — so
# daily runs don't burn LLM credits re-testing an unchanged (CLI, failproofai)
# pair. FAIL/INCONCLUSIVE/ERROR always re-probe until they recover. Override the
# gated set with CANARY_VERSION_GATED (comma-sep) or "" to force-probe all.
# ─────────────────────────────────────────────────────────────────────────────
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

REPO="${CANARY_REPO:?CANARY_REPO (built failproofai checkout) required}"
SANDBOX="${CANARY_SANDBOX:-$HERE}"
VOL="${CANARY_VOL:-integration-suite}"
IMAGE="${CANARY_IMAGE:-failproofai-integration-suite:base}"
STATE="${CANARY_STATE:-$HERE/state.json}"
ENVFILE="${CANARY_ENVFILE:?CANARY_ENVFILE (docker --env-file with gateway creds) required}"
MODEL="${CANARY_LLM_MODEL:-deepseek-v4-pro}"
GATED="${CANARY_VERSION_GATED-all}"

CHANNEL="${CANARY_CHANNEL:-stable}"
# Sibling leg's state file, for the cross-leg comparison (see report.js). The beta
# leg needs to know whether a CLI is green on stable: "stable green + beta not
# green" is the incoming-breakage signal, and it is the ONLY way to distinguish
# "the vendor is about to break us" from "this CLI is broken for everyone already".
PEER_STATE="${CANARY_PEER_STATE:-}"

# The CLIs with a public pre-release ref — kept in sync with the beta refs in
# install-clis.sh (__tests__/integration-suite/channel-refs.test.ts asserts the two
# lists agree, since a silent drift here would look like coverage while probing
# nothing). Its LENGTH is also the honest denominator for the beta report: a
# targeted run (`run.sh cursor`) must not imply the CLIs it skipped have no
# pre-release ref.
BETA_CLIS=(claude codex copilot cursor goose openclaw)

CLIS=("$@")
if [ ${#CLIS[@]} -eq 0 ]; then
  if [ "$CHANNEL" = stable ]; then
    CLIS=(claude codex copilot cursor factory devin antigravity goose opencode pi hermes openclaw)
  else
    CLIS=("${BETA_CLIS[@]}")
  fi
fi

# failproofai main HEAD — the second gate dimension. Prefer the value the workflow
# computed; fall back to git in the checkout.
FP_SHA="${CANARY_FP_SHA:-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)}"

# Installed versions from the install step, keyed by cli.
VERSIONS_JSON="$(docker run --rm -v "$VOL:/home/canary" "$IMAGE" cat /home/canary/canary-tier0.json 2>/dev/null || echo '[]')"

run_probe() {
  docker run --rm --env-file "$ENVFILE" \
    -v "$REPO:/repo:ro" -v "$SANDBOX:/opt/canary:ro" -v "$VOL:/home/canary" \
    "$IMAGE" bash /opt/canary/probe-cli.sh "$1" 2>&1
}

results="[]"
for cli in "${CLIS[@]}"; do
  cur_ver="$(node -e 'const a=JSON.parse(process.argv[1]);const x=a.find(y=>y.cli===process.argv[2]);process.stdout.write(x&&x.version?x.version:"")' "$VERSIONS_JSON" "$cli")"

  gate="$(node -e '
    const [statePath, cli, curVer, curSha, gated] = process.argv.slice(1);
    let st={clis:{}}; try{ st=JSON.parse(require("fs").readFileSync(statePath,"utf8")); }catch{}
    const isGated = gated === "all" || gated.split(",").filter(Boolean).includes(cli);
    const prev = st.clis && st.clis[cli];
    let skip = false;
    if (isGated && prev && prev.version && curVer && prev.version===curVer
        && prev.fpSha && curSha && prev.fpSha===curSha) {
      const vals=Object.values((prev.probes||prev)||{});
      // Only carry forward a genuinely GREEN result — FAIL/INCONCLUSIVE/ERROR
      // must keep re-probing so they recover (e.g. an expired token clears once
      // the secret is refreshed) instead of being frozen.
      const green = vals.length>0 && !vals.includes("FAIL") && !vals.includes("INCONCLUSIVE") && !vals.includes("ERROR");
      if (green) skip = true;
    }
    process.stdout.write(skip ? "skip" : "probe");
  ' "$STATE" "$cli" "$cur_ver" "$FP_SHA" "$GATED")"

  if [ "$gate" = skip ]; then
    echo ">> $cli: CLI $cur_ver + failproofai $FP_SHA both unchanged & last green → gated-skip (protecting quota)" >&2
    vj="$(node -e 'const st=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=st.clis[process.argv[2]];process.stdout.write(JSON.stringify({cli:process.argv[2],probes:p.probes||p,version:p.version,fpSha:p.fpSha,gated:true}))' "$STATE" "$cli")"
  else
    echo ">> probing $cli ..." >&2
    # Spool to a file rather than a shell variable: a probe's output is a full agent
    # transcript from up to 6 CLI invocations, and a stuck or noisy client could make it
    # arbitrarily large. Only the verdict line and a 20-line tail are ever needed.
    out_file="$(mktemp)"
    run_probe "$cli" > "$out_file"
    vj="$(sed -n 's/^VERDICT_JSON //p' "$out_file" | tail -1)"
    # Echo the probe tail whenever the verdict is not a clean pass. Without this the
    # ONLY thing that survived a probe was its VERDICT_JSON line, so a yellow/red run
    # said WHAT broke and never WHY — and re-running told you no more, because the
    # cause (a vendor error message) was discarded both times. Diagnosing codex's
    # 0.145.0 regression needed a full local reproduction purely for want of these
    # lines. Safe in a public log: every credential here is a registered Actions
    # secret, so GitHub masks it on the way out.
    case "$vj" in
      *FAIL*|*INCONCLUSIVE*|*ERROR*|"")
        echo "── $cli probe output (tail) ──" >&2
        tail -20 "$out_file" >&2
        echo "── end $cli ──" >&2 ;;
    esac
    rm -f "$out_file"
    [ -z "$vj" ] && vj="{\"cli\":\"$cli\",\"probes\":{}}"
    vj="$(node -e 'const v=JSON.parse(process.argv[1]);v.version=process.argv[2]||null;v.fpSha=process.argv[3]||null;process.stdout.write(JSON.stringify(v))' "$vj" "$cur_ver" "$FP_SHA")"
  fi
  results="$(node -e 'const a=JSON.parse(process.argv[1]);a.push(JSON.parse(process.argv[2]));process.stdout.write(JSON.stringify(a))' "$results" "$vj")"
done

report="$(node "$HERE/report.js" "$results" "$STATE" "$MODEL" "$CHANNEL" "$PEER_STATE" "${#BETA_CLIS[@]}")"
echo "════ report ════" >&2; printf '%s\n' "$report" >&2; echo "════════════════" >&2
printf '%s\n' "$report"   # also to stdout for the workflow log / artifact

if [ -n "${CANARY_SLACK_WEBHOOK:-}" ]; then
  payload="$(node -e 'const t=require("fs").readFileSync(0,"utf8");process.stdout.write(JSON.stringify({text:t}))' <<<"$report")"
  code="$(curl -sS --connect-timeout 10 --max-time 30 \
            -o /dev/null -w '%{http_code}' -X POST -H 'Content-type: application/json' \
            --data "$payload" "$CANARY_SLACK_WEBHOOK" 2>/dev/null || echo 000)"
  if [ "$code" = 200 ]; then echo "✓ posted to Slack webhook" >&2
  else echo "⚠️  Slack webhook POST returned HTTP $code" >&2; fi
else
  echo "(no CANARY_SLACK_WEBHOOK set — report not posted)" >&2
fi

# The beta leg is ADVISORY and must never fail the job. It probes vendor
# pre-release builds, which are broken-by-nature often enough that gating CI on
# them would train everyone to ignore a red run — and the thing it reports is
# "this WILL break on release", not "this IS broken", which is not a reason to
# stop the world. The report is emitted and posted either way, so the signal is
# never lost; escalation is the report's job, not the exit code's.
if [ "$CHANNEL" != stable ]; then
  echo "(channel=$CHANNEL — advisory only, not failing the job)" >&2
  exit 0
fi

# Fail the job when any probe reported a hard FAIL (broken enforcement) so this
# scheduled check actually blocks regressions. ERROR (vendor quota/auth) and
# INCONCLUSIVE (model didn't attempt the tool) are NOT failures — they mean
# "couldn't confirm", not "enforcement broke". The report is already emitted +
# posted above regardless, so the signal is never lost.
if node -e 'const r=JSON.parse(process.argv[1]);process.exit(r.some(x=>Object.values(x.probes||{}).includes("FAIL"))?1:0)' "$results"; then
  exit 0
else
  echo "✗ FAIL verdict(s) present — failing the job" >&2
  exit 1
fi
