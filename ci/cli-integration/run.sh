#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# failproofai CLI Integration Tests — orchestrator (runs on the GitHub Actions runner).
#   ./run.sh [cli ...]      default: all 12
#
# Mirrors the box's run-canary.sh, but every path is env-parameterised (the
# runner is ephemeral) and the report is POSTed to a Slack Incoming Webhook
# instead of delivered via Hermes. Assumes the workflow has already:
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
VOL="${CANARY_VOL:-canary-ci}"
IMAGE="${CANARY_IMAGE:-failproofai-canary:base}"
STATE="${CANARY_STATE:-$HERE/state.json}"
ENVFILE="${CANARY_ENVFILE:?CANARY_ENVFILE (docker --env-file with gateway creds) required}"
MODEL="${CANARY_LLM_MODEL:-deepseek-v4-pro}"
GATED="${CANARY_VERSION_GATED-all}"

CLIS=("$@"); [ ${#CLIS[@]} -eq 0 ] && CLIS=(claude codex copilot cursor factory devin antigravity goose opencode pi hermes openclaw)

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
    vj="$(run_probe "$cli" | sed -n 's/^VERDICT_JSON //p' | tail -1)"
    [ -z "$vj" ] && vj="{\"cli\":\"$cli\",\"probes\":{}}"
    vj="$(node -e 'const v=JSON.parse(process.argv[1]);v.version=process.argv[2]||null;v.fpSha=process.argv[3]||null;process.stdout.write(JSON.stringify(v))' "$vj" "$cur_ver" "$FP_SHA")"
  fi
  results="$(node -e 'const a=JSON.parse(process.argv[1]);a.push(JSON.parse(process.argv[2]));process.stdout.write(JSON.stringify(a))' "$results" "$vj")"
done

report="$(node "$HERE/report.js" "$results" "$STATE" "$MODEL")"
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
