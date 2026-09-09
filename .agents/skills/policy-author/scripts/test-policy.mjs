#!/usr/bin/env node
/**
 * Run a policy against a synthetic hook payload and report the decision.
 *
 * Exists because loading and execution are both fail-open: a policy that was
 * never loaded, threw, or timed out is indistinguishable from one that
 * correctly allowed. The only way to know a policy works is to make it fire.
 *
 *   node test-policy.mjs --policy <file.mjs> --event PreToolUse --tool Bash \
 *     --input '{"command":"cd /x && ls"}' --expect instruct
 *
 *   node test-policy.mjs --cases cases.json
 *
 * With --policy the policy is copied into a throwaway project (which also acts
 * as HOME) so neither the real project config, `customPoliciesEnabled: false`,
 * nor user-scope policies can affect the result. Without it, the payload runs
 * against the current directory's real config — useful for testing builtins.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- arg parsing

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.cases && !args.event)) {
  console.log(`
Usage:
  test-policy.mjs --policy <file> --event <Event> [--tool <Tool>] \\
                  --input '<json>' [--expect deny|allow|instruct] [--cwd <dir>]
  test-policy.mjs --cases <cases.json>

  --policy   Policy file to test in isolation. Omit to test the current
             directory's real config (builtins).
  --event    Hook event, e.g. PreToolUse, PostToolUse, Stop.
  --tool     Canonical tool name: Bash, Read, Write, Edit, Grep.
  --input    Tool input as JSON, e.g. '{"command":"sudo ls"}'.
  --expect   Assert the outcome. Exits 1 on mismatch.
  --cwd      cwd reported to the policy. Defaults to the sandbox / process cwd.

cases.json is an array of objects with the same keys minus --policy:
  [{ "name": "blocks sudo", "event": "PreToolUse", "tool": "Bash",
     "input": { "command": "sudo ls" }, "expect": "deny" }]
`.trim());
  process.exit(args.help ? 0 : 1);
}

// ------------------------------------------------------------------- runner

/** Walk up looking for this repo's dev launcher; fall back to the published CLI. */
function findRunner() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "scripts", "dev-hook.mjs");
    if (existsSync(candidate)) return { cmd: "node", pre: [candidate] };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { cmd: "npx", pre: ["-y", "failproofai"] };
}

const runner = findRunner();

/**
 * Build a throwaway project that is also HOME, so project config, global
 * config and user-scope policies all resolve inside it and nothing on the
 * real machine leaks into the result.
 */
function makeSandbox(policyPath) {
  const root = mkdtempSync(join(tmpdir(), "failproofai-policy-test-"));
  mkdirSync(join(root, ".failproofai", "policies"), { recursive: true });

  // The convention regex is /policies\.(js|mjs|ts)$/ — a file that does not
  // match is silently skipped, so normalize the name rather than trusting it.
  let name = basename(policyPath);
  if (!/policies\.(js|mjs|ts)$/.test(name)) {
    name = name.replace(/\.(js|mjs|ts)$/, "-policies.$1");
    console.log(`  note: renamed to ${name} to satisfy the loader convention`);
  }
  copyFileSync(policyPath, join(root, ".failproofai", "policies", name));
  writeFileSync(
    join(root, ".failproofai", "policies-config.json"),
    JSON.stringify({ enabledPolicies: [] }, null, 2),
  );
  return root;
}

/**
 * Deny is reported in several different shapes depending on event and CLI.
 * Missing one silently downgrades a real deny to "allow", which is the exact
 * failure this script exists to catch — so handle all of them.
 *
 *   PreToolUse (Claude)      hookSpecificOutput.permissionDecision === "deny"
 *   PermissionRequest        hookSpecificOutput.decision.behavior === "deny"
 *   instruct                 hookSpecificOutput.additionalContext
 *   Copilot/Goose/Devin/…    { decision: "block" }
 *   Cursor/Pi flat           { permission: "deny" }
 *   Factory non-Stop         exit code 2, reason on stderr
 */
function classify(stdout, exitCode, stderr) {
  const text = stdout.trim();
  if (!text) {
    if (exitCode === 2) return { decision: "deny", reason: (stderr ?? "").trim() };
    return { decision: "allow", reason: "" };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { decision: "unparseable", reason: text }; }
  const h = parsed.hookSpecificOutput ?? {};
  if (h.permissionDecision === "deny") return { decision: "deny", reason: h.permissionDecisionReason ?? "" };
  if (h.decision?.behavior === "deny") return { decision: "deny", reason: h.decision.message ?? "" };
  if (h.additionalContext) return { decision: "instruct", reason: h.additionalContext };
  if (parsed.decision === "block") return { decision: "deny", reason: parsed.reason ?? "" };
  if (parsed.permission === "deny") return { decision: "deny", reason: parsed.reason ?? "" };
  if (exitCode === 2) return { decision: "deny", reason: (stderr ?? "").trim() };
  return { decision: "allow", reason: "" };
}

function runCase(c, sandbox) {
  const cwd = c.cwd ?? sandbox ?? process.cwd();
  const payload = {
    hook_event_name: c.event,
    session_id: "policy-test",
    transcript_path: "/dev/null",
    cwd,
  };
  if (c.tool) payload.tool_name = c.tool;
  if (c.input) {
    // `{{cwd}}` expands to the effective cwd, so cases can reference the
    // sandbox path (generated per run) in commands like `cd {{cwd}} && ls`.
    const raw = typeof c.input === "string" ? c.input : JSON.stringify(c.input);
    payload.tool_input = JSON.parse(raw.split("{{cwd}}").join(cwd));
  }
  if (c.event === "Stop") payload.stop_hook_active = false;

  const env = { ...process.env, FAILPROOFAI_TELEMETRY_DISABLED: "1" };
  if (sandbox) env.HOME = sandbox;

  const res = spawnSync(runner.cmd, [...runner.pre, "--hook", c.event], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd,
    env,
    timeout: 20000,
  });

  if (res.error) return { decision: "error", reason: String(res.error) };
  return classify(res.stdout ?? "", res.status, res.stderr);
}

// --------------------------------------------------------------------- main

let cases = args.cases
  ? JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(resolve(args.cases), "utf8")))
  : [{ name: `${args.event}${args.tool ? " " + args.tool : ""}`, event: args.event, tool: args.tool,
       input: args.input, expect: args.expect, cwd: args.cwd }];

// A command-line --cwd is the default for every case that does not set its own.
// Without this, --cwd is silently ignored alongside --cases, and policies that
// inspect real filesystem or git state quietly evaluate against the empty
// sandbox instead — producing allow-everything results that look like failures
// of the policy rather than of the harness.
if (args.cwd) cases = cases.map((c) => ({ ...c, cwd: c.cwd ?? args.cwd }));

let sandbox = null;
if (args.policy) {
  const p = resolve(args.policy);
  if (!existsSync(p)) { console.error(`Policy file not found: ${p}`); process.exit(1); }
  sandbox = makeSandbox(p);
}

let failed = 0;
try {
  for (const c of cases) {
    const got = runCase(c, sandbox);
    const label = c.name ?? `${c.event} ${c.tool ?? ""}`.trim();
    if (!c.expect) {
      console.log(`  ${label}\n    → ${got.decision}${got.reason ? ": " + got.reason : ""}`);
      continue;
    }
    const ok = got.decision === c.expect;
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}  (expected ${c.expect}, got ${got.decision})`);
    if (got.reason) console.log(`        ${got.reason.slice(0, 160)}`);
  }
} finally {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
}

if (failed) { console.log(`\n${failed} of ${cases.length} failed.`); process.exit(1); }
if (cases.some((c) => c.expect)) console.log(`\nAll ${cases.length} passed.`);
