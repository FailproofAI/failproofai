#!/usr/bin/env node
// Build the Slack report from probe verdicts + diff against last run's state.
// Args: <resultsJson> <statePath> <model>
// Each result: {cli, probes:{...}, version?, gated?}. Prints report to stdout
// AND writes new state: clis[cli] = {probes, version}. Flags broke/recovered.
const fs = require("fs");
const [, , resultsJson, statePath, model] = process.argv;
const results = JSON.parse(resultsJson);

let prev = { clis: {}, lastRun: null };
try { prev = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}

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
const lines = [`🧪 *failproofai CLI integration tests*  ·  ${now}  ·  model=${model}`];
let worst = "green";
const breaks = [], recoveries = [];

for (const r of results) {
  const st = statusOf(r.probes);
  const prevEntry = prev.clis && prev.clis[r.cli];
  const prevSt = prevEntry ? statusOf(probesOf(prevEntry)) : null;
  let mark = "";
  if (r.gated) {
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
if (breaks.length) hdr = `🔴 *ENFORCEMENT BROKEN*: ${breaks.join(", ")} — investigate now`;
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
  };
}
try { fs.writeFileSync(statePath, JSON.stringify(newState, null, 2)); }
catch (e) { process.stderr.write("state save failed: " + e.message + "\n"); }

process.stdout.write(lines.join("\n") + "\n");
