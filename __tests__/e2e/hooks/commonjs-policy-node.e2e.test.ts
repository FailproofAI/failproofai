// @vitest-environment node
/**
 * A CommonJS policy, run by Node.
 *
 * Every policy's temporary copy used to be `.mjs`, and Node gives an ES module
 * no `require`, `module` or `exports`: a policy written with `require()` (or an
 * ES module policy importing a `module.exports` helper) threw at load, was
 * skipped, and the call it should have denied was allowed. The rest of the e2e
 * suite runs the CLI under Bun, which defines `require` in ES modules, so it
 * never saw this. Here the CLI is bundled and run by `node`, as an install is.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fpai-cjs-policy-"));
const home = join(root, "home");
const dist = join(root, "dist");
const policies = join(root, "policies");
const proj = join(root, "proj");
const repo = resolve(__dirname, "../../..");
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
for (const dir of [join(home, ".failproofai"), dist, policies, proj]) mkdirSync(dir, { recursive: true });

const builds = [
  ["build", "--target=node", "--format=esm", `--outfile=${join(dist, "cli.mjs")}`, "bin/failproofai.mjs",
    "--external", "posthog-node", "--external", "sql.js"],
  ["build", "--target=node", "--format=cjs", `--outfile=${join(dist, "index.js")}`, "src/index.ts"],
].map((args) => spawnSync("bun", args, { cwd: repo, encoding: "utf8", timeout: 60000 }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

writeFileSync(join(policies, "util.js"), `module.exports = { isCurl: (c) => c.includes("curl") };\n`);
writeFileSync(join(policies, "cjs.js"), [
  `const { customPolicies, deny, allow } = require("failproofai");`,
  `const { isCurl } = require("./util.js");`,
  `customPolicies.add({ name: "cjs-no-curl", match: { events: ["PreToolUse"] },`,
  `  fn: async (ctx) => isCurl(String(ctx.toolInput?.command ?? "")) ? deny("cjs says no curl") : allow() });`,
].join("\n"));
writeFileSync(join(policies, "mixed.mjs"), [
  `import { customPolicies, deny, allow } from "failproofai";`,
  `import util from "./util.js";`,
  `customPolicies.add({ name: "mixed-no-curl", match: { events: ["PreToolUse"] },`,
  `  fn: async (ctx) => util.isCurl(String(ctx.toolInput?.command ?? "")) ? deny("mixed says no curl") : allow() });`,
].join("\n"));

// Review F10: an ES module helper whose STRINGS mention require(), with its
// export on the same line as other statements, imported by an ES module
// policy. A text-based check called the helper CommonJS and the policy was
// skipped, so curl was allowed.
writeFileSync(join(policies, "esm-helper.mjs"),
  `const command = "curl"; const example = "require()"; export default command;\n`);
writeFileSync(join(policies, "esm-literal.mjs"), [
  `import { customPolicies, deny, allow } from "failproofai";`,
  `import command from "./esm-helper.mjs";`,
  `customPolicies.add({ name: "esm-literal-no-curl", match: { events: ["PreToolUse"] },`,
  `  fn: async (ctx) => String(ctx.toolInput?.command ?? "").includes(command) ? deny("esm literal says no curl") : allow() });`,
].join("\n"));
// And the reverse: CommonJS whose template literals contain import.meta and a
// line starting with `export`.
writeFileSync(join(policies, "cjs-literal.js"), [
  "const { customPolicies, deny, allow } = require(\"failproofai\");",
  "const note = `import.meta is not used here`;",
  "const doc = `",
  "export default nothing",
  "`;",
  "customPolicies.add({ name: \"cjs-literal-no-curl\", match: { events: [\"PreToolUse\"] },",
  "  fn: async (ctx) => String(ctx.toolInput?.command ?? \"\").includes(\"curl\") ? deny(\"cjs literal says no curl \" + note.length + doc.length) : allow() });",
].join("\n"));

// Review F10 (round 3): a valid ES module with no import/export at all, whose
// only CommonJS "hints" are a comment and a template string. Run as CommonJS it
// is sloppy-mode, `strict` is false and curl is allowed; it must stay an ES
// module, where it denies.
writeFileSync(join(policies, "esm-hints.mjs"), [
  "// Ported from an old version that did: const { deny } = require(\"failproofai\");",
  "const note = `module.exports used to be how this was shared`;",
  "const KEY = \"__failproofai_custom_hooks__\";",
  "if (!Array.isArray(globalThis[KEY])) globalThis[KEY] = [];",
  "const strict = (function () { return this === undefined; })();",
  "globalThis[KEY].push({ name: \"esm-hints-no-curl\", match: { events: [\"PreToolUse\"] },",
  "  fn: async (ctx) => strict && String(ctx.toolInput?.command ?? \"\").includes(\"curl\")",
  "    ? { decision: \"deny\", reason: \"esm hints says no curl \" + note.length } : { decision: \"allow\" } });",
].join("\n"));

// Review F10 (round 4): a MIXED graph. The entry imports a module.exports
// helper, so its load is retried with CommonJS copies; it also imports, for its
// side effect, an ES module whose only CommonJS hints are a comment and a
// template. That one must stay an ES module (strict), or curl is allowed.
writeFileSync(join(policies, "strict-flag.js"), [
  "// Was: module.exports.strict = ...; see require() notes in the README.",
  "const note = `exports moved to the ES module below`;",
  "globalThis.__fpaiStrictFlag = (function () { return this === undefined; })() && note.length > 0;",
].join("\n"));
writeFileSync(join(policies, "mixed-graph.mjs"), [
  `import { customPolicies, deny, allow } from "failproofai";`,
  `import util from "./util.js";`,
  `import "./strict-flag.js";`,
  `customPolicies.add({ name: "mixed-graph-no-curl", match: { events: ["PreToolUse"] },`,
  `  fn: async (ctx) => globalThis.__fpaiStrictFlag === true && util.isCurl(String(ctx.toolInput?.command ?? ""))`,
  `    ? deny("mixed graph says no curl") : allow() });`,
].join("\n"));

// Node before 22.12 cannot require() an ES module (ERR_REQUIRE_ESM), and 20.9
// is the minimum supported. Where the running node has require(esm), this flag
// turns it off so that path is tested on whatever node CI has.
const noRequireEsm =
  spawnSync("node", ["--no-experimental-require-module", "-e", ""], { encoding: "utf8" }).status === 0
    ? ["--no-experimental-require-module"]
    : [];

function hook(policyFile: string, command: string, nodeArgs: string[] = []) {
  writeFileSync(join(home, ".failproofai/policies-config.json"),
    JSON.stringify({ enabledPolicies: [], customPoliciesPath: join(policies, policyFile) }));
  const stdin = JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command }, cwd: proj });
  return spawnSync("node", [...nodeArgs, join(dist, "cli.mjs"), "--hook", "PreToolUse", "--cli", "claude"], {
    input: stdin, encoding: "utf8", timeout: 20000,
    env: { ...process.env, HOME: home, USERPROFILE: home, FAILPROOFAI_HOME: join(home, ".failproofai"),
      FAILPROOFAI_DIST_PATH: dist, FAILPROOFAI_TELEMETRY_DISABLED: "1" },
  });
}

describe("a CommonJS policy run by node", () => {
  it("builds", () => {
    for (const b of builds) expect(b.status, b.stderr).toBe(0);
  });

  it("require('failproofai') and a required module.exports helper load and deny", () => {
    const denied = hook("cjs.js", "curl example.com");
    expect(denied.stdout, denied.stderr).toContain("cjs says no curl");
    expect(denied.stderr).not.toContain("require is not defined");
    const allowed = hook("cjs.js", "ls");
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).not.toContain("deny");
  });

  it("a required module.exports helper loads where node cannot require() an ES module", () => {
    const denied = hook("cjs.js", "curl example.com", noRequireEsm);
    expect(denied.stdout, denied.stderr).toContain("cjs says no curl");
    expect(denied.stderr).not.toContain("require() of ES Module");
    const allowed = hook("cjs.js", "ls", noRequireEsm);
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).not.toContain("deny");
  });

  it("an ES module with only comment and template CommonJS hints keeps ES module semantics", () => {
    const denied = hook("esm-hints.mjs", "curl example.com");
    expect(denied.stdout, denied.stderr).toContain("esm hints says no curl");
  });

  it("an ES module helper that mentions require() in a string stays an ES module", () => {
    const denied = hook("esm-literal.mjs", "curl example.com");
    expect(denied.stdout, denied.stderr).toContain("esm literal says no curl");
  });

  it("CommonJS with import.meta and export inside template literals stays CommonJS", () => {
    const denied = hook("cjs-literal.js", "curl example.com");
    expect(denied.stdout, denied.stderr).toContain("cjs literal says no curl");
  });

  it("a mixed graph turns only the helper Node refused into CommonJS", () => {
    const denied = hook("mixed-graph.mjs", "curl example.com");
    expect(denied.stdout, denied.stderr).toContain("mixed graph says no curl");
  });

  it("an ES module policy importing a module.exports helper loads and denies", () => {
    const denied = hook("mixed.mjs", "curl example.com");
    expect(denied.stdout, denied.stderr).toContain("mixed says no curl");
  });
});
