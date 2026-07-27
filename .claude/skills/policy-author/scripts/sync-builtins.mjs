#!/usr/bin/env node
/**
 * Regenerate references/builtins.md from the live BUILTIN_POLICIES registry.
 *
 *   node sync-builtins.mjs           rewrite the reference file
 *   node sync-builtins.mjs --check   exit 1 if it is out of date (for CI)
 *
 * The reference file is a convenience snapshot. It drifts the moment a builtin
 * is added, renamed, or has its default flipped — and a stale list is worse than
 * no list, because it is quietly authoritative. Run this after any change to
 * builtin-policies.ts.
 *
 * Resolves the registry from the repo checkout first, then from an installed
 * failproofai package, so it works inside the repo and from a user's project.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "references", "builtins.md");
const check = process.argv.includes("--check");

/** Walk up for a repo checkout, then fall back to node_modules. */
function findRegistry() {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const src = join(dir, "src", "hooks", "builtin-policies.ts");
    if (existsSync(src)) return src;
    const dep = join(dir, "node_modules", "failproofai", "src", "hooks", "builtin-policies.ts");
    if (existsSync(dep)) return dep;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const registryPath = findRegistry();
if (!registryPath) {
  console.error("Could not locate builtin-policies.ts (looked in the repo and node_modules).");
  console.error("Run this from inside the failproofai repo, or a project with failproofai installed.");
  process.exit(2);
}

// TypeScript source — needs a TS-capable runtime. Bun handles it directly.
let BUILTIN_POLICIES;
try {
  ({ BUILTIN_POLICIES } = await import(pathToFileURL(registryPath).href));
} catch (err) {
  console.error(`Could not import ${registryPath}: ${err.message}`);
  console.error("This script needs a TypeScript-capable runtime — try: bun sync-builtins.mjs");
  process.exit(2);
}

const byCategory = new Map();
for (const p of BUILTIN_POLICIES) {
  if (!byCategory.has(p.category)) byCategory.set(p.category, []);
  byCategory.get(p.category).push(p);
}

const lines = [];
lines.push(`# Builtin policies (${BUILTIN_POLICIES.length})`);
lines.push("");
lines.push("**Generated — do not hand-edit.** Regenerate with:");
lines.push("");
lines.push("```bash");
lines.push("bun .claude/skills/policy-author/scripts/sync-builtins.mjs");
lines.push("```");
lines.push("");
lines.push("This snapshot goes stale whenever a builtin is added, renamed, or has its default");
lines.push("flipped. When it matters, ask the CLI instead — it is always current:");
lines.push("");
lines.push("```bash");
lines.push("failproofai policies          # every policy, with enabled status and params");
lines.push("```");
lines.push("");
lines.push("## How to use this for triage");
lines.push("");
lines.push("Enabling a builtin beats writing a custom policy: nothing to maintain, no naming");
lines.push("trap, no fail-open risk, and it ships with tests.");
lines.push("");
lines.push("Before concluding \"no builtin covers this\", check whether a **parameterized** one");
lines.push("does — several take allowlists or thresholds that widen their scope considerably.");
lines.push("Params go in the `policyParams` map, keyed by short name.");
lines.push("");
lines.push("To enable: add the short name to `enabledPolicies` in `.failproofai/policies-config.json`.");
lines.push("");
lines.push("---");

for (const [category, policies] of byCategory) {
  lines.push("");
  lines.push(`### ${category}`);
  lines.push("");
  lines.push("| Policy | Default | Events | What it catches |");
  lines.push("|---|---|---|---|");
  for (const p of policies) {
    const events = (p.match?.events ?? []).join(", ") || "—";
    const params = p.params ? ` _(params: ${Object.keys(p.params).join(", ")})_` : "";
    const beta = p.beta ? " _(beta)_" : "";
    lines.push(
      `| \`${p.name}\` | ${p.defaultEnabled ? "**on**" : "off"} | ${events} | ${p.description}${params}${beta} |`,
    );
  }
}

lines.push("");
lines.push("> The five `require-*-before-stop` policies gate the end of a turn. A gate whose");
lines.push("> condition cannot be met in the current project loops forever — see `traps.md` §6");
lines.push("> before enabling one.");
lines.push("");
lines.push("---");
lines.push("");
lines.push("## Audit-only detectors");
lines.push("");
lines.push("These have no real-time builtin equivalent, so they are the prime candidates for");
lines.push("custom policies. List them from source with:");
lines.push("");
lines.push("```bash");
lines.push("bun -e 'const {AUDIT_DETECTORS}=await import(\"./src/audit/detectors/index.ts\");");
lines.push("for (const d of AUDIT_DETECTORS) console.log(d.name, \"|\", d.category+\"/\"+d.severity, \"|\", d.description)'");
lines.push("```");
lines.push("");
lines.push("All but `reread-after-edit` are Bash-command patterns, so a `PreToolUse` policy");
lines.push("filtering on `ctx.toolName === \"Bash\"` and matching `ctx.toolInput.command` covers");
lines.push("most of them. `reread-after-edit` needs cross-call session state, which hooks cannot");
lines.push("see — that one needs a builtin, not a custom policy.");
lines.push("");

const generated = lines.join("\n");

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== generated) {
    console.error("references/builtins.md is OUT OF DATE.");
    console.error(`Registry has ${BUILTIN_POLICIES.length} builtins. Run: bun ${process.argv[1]}`);
    process.exit(1);
  }
  console.log(`references/builtins.md is current (${BUILTIN_POLICIES.length} builtins).`);
  process.exit(0);
}

writeFileSync(OUT, generated);
console.log(`Wrote ${OUT} — ${BUILTIN_POLICIES.length} builtins across ${byCategory.size} categories.`);
