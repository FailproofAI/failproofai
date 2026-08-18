/**
 * Assemble one pack from a directory of per-CLI observation tables, then say
 * what it means. Run with bun (it imports the TypeScript comparator directly).
 *
 *   bun contracts-pack.mjs --in <dir> --summary <file> --out <pack.json> --repo <dir>
 *
 * Split out of the two drivers because the box and a laptop drive the probes
 * differently — one container per CLI on the box, a plain loop locally — but
 * must produce byte-identical packs and identical verdicts. Two copies of this
 * logic would be two chances for the box to report something a developer cannot
 * reproduce.
 *
 * `--summary` is a file of the probe's own `CONTRACTS_JSON {...}` lines, one per
 * CLI. A CLI that produced no table still appears in the pack: "we tried and got
 * nothing" is a fact about that vendor, and dropping it makes a failed run look
 * like a shorter one.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) {
    if (fallback !== undefined) return fallback;
    console.error(`contracts-pack: missing --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const inDir = arg("in");
const summaryPath = arg("summary");
const outPath = arg("out");
const repoDir = arg("repo");

const probes = {};
try {
  for (const line of readFileSync(summaryPath, "utf8").split("\n")) {
    const marker = "CONTRACTS_JSON ";
    const at = line.indexOf(marker);
    if (at === -1) continue;
    try {
      const p = JSON.parse(line.slice(at + marker.length));
      if (p && typeof p.cli === "string") probes[p.cli] = p;
    } catch {
      // One unparseable line must not cost us the other eleven CLIs.
    }
  }
} catch {
  console.error(`contracts-pack: could not read ${summaryPath}`);
  process.exit(2);
}

if (Object.keys(probes).length === 0) {
  console.error("contracts-pack: no probe verdicts — nothing ran");
  process.exit(2);
}

const clis = {};
for (const cli of Object.keys(probes).sort()) {
  const file = join(inDir, `${cli}.json`);
  let record = null;
  if (existsSync(file)) {
    try {
      record = JSON.parse(readFileSync(file, "utf8"))?.clis?.[cli] ?? null;
    } catch {
      // A table we cannot parse is the same as no table, for this vendor only.
    }
  }
  clis[cli] = {
    ...(record ?? { hooks: {} }),
    probe: { verdict: probes[cli].verdict, note: probes[cli].note },
  };
}

writeFileSync(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), clis }, null, 2)}\n`);
console.log(`pack: ${outPath} (${Object.keys(clis).length} CLIs)`);

// ── What it means ────────────────────────────────────────────────────────────
const { compareContractTable } = await import(join(repoDir, "src", "hooks", "contract-compare.ts"));
let high = 0;
for (const c of compareContractTable(JSON.parse(readFileSync(outPath, "utf8")))) {
  for (const f of c.findings) {
    if (f.severity === "high") high += 1;
    console.log(`  [${f.severity}] ${c.cli}: ${f.detail}`);
  }
}
console.log(high > 0 ? `\n${high} high-severity translation finding(s)` : "\ntranslation: nothing to report");

const counts = { OK: 0, DRIFT: 0, ERROR: 0, INCONCLUSIVE: 0 };
for (const p of Object.values(probes)) counts[p.verdict] = (counts[p.verdict] ?? 0) + 1;
console.log(
  `probes: ${counts.OK} ok, ${counts.DRIFT} drift, ${counts.INCONCLUSIVE} inconclusive, ${counts.ERROR} error`,
);

// A run that exercised nothing is not a clean run, however green it looks. This
// is the failure mode a lab dies of: a rotated model name or an expired key
// makes every probe inconclusive, and silence reads as health.
if (counts.OK === 0) {
  console.error("NOTHING REACHED OK — no vendor was actually exercised; treat this run as invalid");
  process.exit(2);
}
if (counts.DRIFT > 0 || high > 0) process.exit(1);
if (counts.ERROR > 0) process.exit(2);
process.exit(0);
