#!/usr/bin/env node
// Build the Slack report from probe verdicts + diff against last run's state.
// Args: <resultsJson> <statePath> <model> [channel] [peerStatePath]
// Each result: {cli, probes:{...}, version?, gated?}. Prints report to stdout
// AND writes new state: clis[cli] = {probes, version}. Flags broke/recovered.
//
// On the BETA channel the report answers a different question — not "is
// enforcement broken?" but "is it about to break?" — so it compares each CLI
// against the sibling stable leg's last known state (peerStatePath).
const fs = require("fs");
const [, , resultsJson, statePath, model, channel = "stable", peerStatePath = "", eligible = ""] = process.argv;
const results = JSON.parse(resultsJson);
const isBeta = channel !== "stable";

let prev = { clis: {}, lastRun: null };
try { prev = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}

let peer = { clis: {} };
if (peerStatePath) { try { peer = JSON.parse(fs.readFileSync(peerStatePath, "utf8")); } catch {} }

const probesOf = (entry) => (entry ? (entry.probes || entry) : null); // compat old flat schema
const statusOf = (probes) => {
  const v = Object.values(probes || {});
  if (v.length === 0) return "grey";
  if (v.includes("FAIL")) return "red";
  if (v.includes("ERROR")) return "error";        // vendor quota/auth — can't test, not broken
  if (v.includes("INCONCLUSIVE")) return "yellow";
  return "green";
};
const emo = { green: "🟢", yellow: "🟡", red: "🔴", grey: "⚪", error: "⚠️" };
const rank = { green: 0, grey: 1, yellow: 1, error: 1, red: 2 };

const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const title = isBeta
  ? `🔮 *failproofai CLI pre-release watch*  ·  ${now}  ·  channel=${channel}  ·  model=${model}`
  : `🧪 *failproofai CLI integration tests*  ·  ${now}  ·  model=${model}`;
const lines = [title];
let worst = "green";
const breaks = [], recoveries = [], incoming = [];

// A beta CLI counts as "incoming breakage" only when the SAME CLI is green on the
// stable leg — otherwise we would report an already-broken CLI twice — and only
// after two consecutive non-green probes, so a broken alpha that gets reverted
// before release doesn't burn anyone's attention. Strike counts live in state.
const strikesOf = (cli) => (prev.clis && prev.clis[cli] && prev.clis[cli].strikes) || 0;
const newStrikes = {};

for (const r of results) {
  const st = statusOf(r.probes);
  const prevEntry = prev.clis && prev.clis[r.cli];
  const prevSt = prevEntry ? statusOf(probesOf(prevEntry)) : null;
  let mark = "";
  if (isBeta) {
    const peerEntry = peer.clis && peer.clis[r.cli];
    const peerSt = peerEntry ? statusOf(probesOf(peerEntry)) : null;
    const strikes = st === "green" ? 0 : strikesOf(r.cli) + 1;
    newStrikes[r.cli] = strikes;
    if (r.gated) {
      mark = `  🔵 _gated: pre-release unchanged, last green_`;
    } else if (st !== "green" && peerSt === "green") {
      mark = strikes >= 2
        ? `  🚨 *INCOMING* — green on stable, ${st === "red" ? "FAILING" : "not verifiable"} on ${channel} (${strikes} runs)`
        : `  👀 _first ${channel} miss; confirming next run_`;
      if (strikes >= 2) incoming.push(r.cli);
    } else if (st !== "green" && peerSt && peerSt !== "green") {
      mark = `  ⏸️ _also ${peerSt} on stable — the stable leg owns this alarm_`;
    }
  } else if (r.gated) {
    mark = `  🔵 _gated: CLI v${r.version || "?"} + failproofai ${r.fpSha || "?"} unchanged, last green_`;
  } else if (prevSt && prevSt !== "red" && st === "red") {
    mark = "  ⚠️ *BROKE*"; breaks.push(r.cli);
  } else if (prevSt === "red" && st === "green") {
    // Only a green result is a genuine recovery — ERROR/INCONCLUSIVE/no-verdict
    // are "couldn't confirm", not "fixed".
    mark = "  ✅ *recovered*"; recoveries.push(r.cli);
  }
  if (rank[st] > rank[worst]) worst = st;
  const probes = Object.entries(r.probes || {}).map(([k, v]) => `${k}=${v}`).join(" ") || "no verdict";
  lines.push(`${emo[st]} *${r.cli}*  ${probes}${mark}`);
}

const errored = results.filter((r) => statusOf(r.probes) === "error").map((r) => r.cli);
let hdr;
if (isBeta) {
  // Coverage is stated explicitly and always: only some vendors publish a
  // pre-release ref, and "beta: all green" must never read as assurance for the
  // CLIs that were never probed at all. The denominator is how many are ELIGIBLE
  // (passed in by run.sh), not 12 — a targeted run must not imply the CLIs it
  // skipped have no pre-release ref, and hardcoding the eligible list here would
  // be a third copy to drift against.
  const total = Number(eligible) || results.length;
  const cov = `_watching ${results.length}/${total} CLIs that publish a pre-release ref (of 12 total)_`;
  hdr = incoming.length
    ? `🚨 *INCOMING BREAKAGE*: ${incoming.join(", ")} — broken on ${channel}, still green on stable. Fix before it ships.\n${cov}`
    : `🔮 no incoming breakage detected on ${channel}\n${cov}`;
} else if (breaks.length) hdr = `🔴 *ENFORCEMENT BROKEN*: ${breaks.join(", ")} — investigate now`;
// Any CLI still red dominates the header — a recovery elsewhere must not mask it.
else if (worst === "red") hdr = "🔴 still broken (unchanged)";
else if (recoveries.length) hdr = `✅ recovered: ${recoveries.join(", ")}`;
else if (errored.length) hdr = `⚠️ enforcing; couldn't test ${errored.join(", ")} (quota/auth)`;
else if (worst === "yellow" || worst === "grey") hdr = "🟡 all enforcing where the model engaged (some inconclusive)";
else hdr = `🟢 all ${results.length} enforcing`;
lines.push("", hdr);

// Start from the previous state so CLIs omitted from a subset run (run.sh cursor
// devin) keep their green gating records instead of being wiped + needlessly re-probed.
const newState = { lastRun: new Date().toISOString(), clis: { ...(prev.clis || {}) } };
for (const r of results) {
  const prevEntry = prev.clis && prev.clis[r.cli];
  newState.clis[r.cli] = {
    probes: r.probes,
    version: r.version || (prevEntry && prevEntry.version) || null,
    fpSha: r.fpSha || (prevEntry && prevEntry.fpSha) || null,
    ...(isBeta ? { strikes: newStrikes[r.cli] || 0 } : {}),
  };
}
try { fs.writeFileSync(statePath, JSON.stringify(newState, null, 2)); }
catch (e) { process.stderr.write("state save failed: " + e.message + "\n"); }

process.stdout.write(lines.join("\n") + "\n");
