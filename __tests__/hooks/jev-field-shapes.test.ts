// @vitest-environment node
/**
 * The shapes a cleared-policy name and a model id must have to be stored and
 * shipped — and that every name and id the writers really produce has them.
 *
 * - A cleared name is a REGISTERED policy name. The handler registers a loaded
 *   hook as `${prefix}/${hook.name}` and never validates the name, so a user's
 *   own reviewable hook can be called "No secrets in logs". Jev clearing it
 *   must not vanish from disk, stats, the dashboard or the collector.
 * - A model id is whatever `jev.json` accepts for `model` (T1's `MODEL_RE`),
 *   since the evaluator only accepts a response naming the configured model.
 *
 * The Rust half (`is_policy_name`, `is_model_id` in transform.rs) is tested in
 * crates/fpai-collect/tests/hooks_jev.rs with the same cases.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JEV_MODEL_RE,
  describeJevActivity,
  isJevPolicyName,
  jevOutcome,
  sanitizeJevActivity,
} from "../../src/hooks/jev-activity";
import { computeJevStats } from "../../src/hooks/semantic/jev-stats";
import { jevTelemetryProperties } from "../../src/hooks/hook-telemetry";
import {
  _resetForTest,
  getAllHookActivityEntries,
  persistHookActivity,
  type HookActivityEntry,
} from "../../src/hooks/hook-activity-store";

const ROOT = join(__dirname, "..", "..");
const RUST = readFileSync(join(ROOT, "crates", "fpai-collect", "src", "sources", "hooks", "transform.rs"), "utf-8");

/** Registered names as the handler builds them, for each route a hook arrives on. */
const REGISTERED_WITH_SPACES = [
  "custom/No secrets in logs",
  "pack/acme/fin@1.2.0/No curl to payroll",
  "cloud/pol_8f2a@7/Guard prod deploys",
  ".failproofai-project/Ask before deploy",
  ".failproofai-user/Keep notes tidy",
];
const PLAIN_NAMES = ["block-env-files", "failproofai/protect-env-vars", "custom/no-secrets", "pack/acme/fin@1.2.0/no-curl"];
/** Text that is not a registered name: a sentence, a command line, a path with a space. */
const NOT_NAMES = [
  "two words",
  "not a policy name",
  ["curl", "-d", "@payroll.csv"].join(" "),
  "/home/u/secret project/notes.txt",
  "rm -rf /home/u/x",
  "customs/looks close",
  "custom/line\nbreak",
  "custom/tab\there",
  "custom/carriage\rreturn",
  "custom/sep\u2028arator",
  "",
  "c/" + "x".repeat(199),
];

describe("isJevPolicyName", () => {
  it("accepts a registered name whose hook name has spaces", () => {
    for (const n of REGISTERED_WITH_SPACES) expect(isJevPolicyName(n), n).toBe(true);
  });

  it("accepts plain names, up to 200 characters", () => {
    for (const n of PLAIN_NAMES) expect(isJevPolicyName(n), n).toBe(true);
    expect(isJevPolicyName("custom/" + "x".repeat(193))).toBe(true);
    expect(isJevPolicyName("custom/" + "x".repeat(194))).toBe(false);
  });

  it("rejects text that is not a registered name", () => {
    for (const n of NOT_NAMES) expect(isJevPolicyName(n), JSON.stringify(n)).toBe(false);
    expect(isJevPolicyName(7)).toBe(false);
  });
});

describe("a clear of a reviewable policy whose name has spaces", () => {
  const cleared = (name: string, extra: Partial<HookActivityEntry> = {}): HookActivityEntry => ({
    timestamp: 5_000,
    eventType: "PreToolUse",
    integration: "claude",
    toolName: "Bash",
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 50,
    evaluator: "jev",
    jevDecision: "allow",
    jevCleared: [name],
    jevLatencyMs: 41,
    jevModel: "jev-1.13.0",
    jevMode: "enforce",
    ...extra,
  });
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jev-names-"));
    _resetForTest(dir);
  });
  afterEach(() => {
    _resetForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is kept on disk", () => {
    for (const n of REGISTERED_WITH_SPACES) persistHookActivity(cleared(n));
    const onDisk = getAllHookActivityEntries().flatMap((e) => e.jevCleared ?? []);
    expect(onDisk.sort()).toEqual([...REGISTERED_WITH_SPACES].sort());
  });

  it("is counted by jev status, shown on the dashboard and sent to PostHog", () => {
    const name = REGISTERED_WITH_SPACES[0];
    const s = computeJevStats([cleared(name), cleared(name, { jevMode: "shadow" })], { now: 6_000, windowMs: 60_000 });
    expect(s.clearsByPolicy).toEqual({ [name]: 1 });
    expect(s.shadowClearsByPolicy).toEqual({ [name]: 1 });
    expect(describeJevActivity(cleared(name))).toContain(`cleared ${name}`);
    const props = jevTelemetryProperties(cleared(name));
    expect(props.jev_cleared).toEqual([name]);
    expect(props.jev_cleared_count).toBe(1);
  });

  it("still keeps a sentence or a command line out", () => {
    const out = sanitizeJevActivity(cleared("custom/No secrets in logs", { jevCleared: ["custom/No secrets in logs", ...NOT_NAMES] }));
    expect(out.jevCleared).toEqual(["custom/No secrets in logs"]);
    expect(jevOutcome(out)).toBe("answered");
  });
});

describe("model ids", () => {
  it("keeps every id jev.json accepts", () => {
    for (const id of [
      "jev-1.13.0",
      "typesafe/jev-1.13-20260917",
      "~typesafe/jev-latest",
      "@cf/typesafe/jev",
      ".jev",
      ":jev",
      "/jev",
      "_jev",
      "+jev",
      "-jev",
      "a".repeat(200),
    ]) {
      expect(sanitizeJevActivity({ evaluator: "jev", jevModel: id }).jevModel, id).toBe(id);
    }
  });

  it("drops anything else", () => {
    for (const id of ["a".repeat(201), "jev 1.13 (latest)", "je\nv", "jev#1", "jév"]) {
      expect(sanitizeJevActivity({ evaluator: "jev", jevModel: id }), JSON.stringify(id)).not.toHaveProperty("jevModel");
    }
  });

  it("is the same rule as jev.json's model validator, where that is present", () => {
    // T1's `MODEL_RE` in semantic/jev-config.ts. Before the two-tier branches
    // are merged the file is the contract stub and has no validator.
    const path = join(ROOT, "src", "hooks", "semantic", "jev-config.ts");
    const src = existsSync(path) ? readFileSync(path, "utf-8") : "";
    const m = /const MODEL_RE = \/(.+)\/;/.exec(src);
    if (m) expect(m[1]).toBe(JEV_MODEL_RE.source);
  });

  it("is the same rule the collector applies", () => {
    expect(RUST).toContain("pub const JEV_MODEL_MAX_CHARS: usize = 200;");
    expect(RUST).toContain(`c.is_ascii_alphanumeric() || "._:/@~+-".contains(c)`);
    expect(JEV_MODEL_RE.source).toBe("^[A-Za-z0-9._:/@~+-]{1,200}$");
  });
});
