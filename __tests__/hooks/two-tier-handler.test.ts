// @vitest-environment node
/**
 * The two-tier evaluator through the REAL handler: real registration, real
 * builtins, real registry, real policy evaluator, real combine, real activity
 * store. Only the contract boundaries owned by parallel tasks are replaced:
 *
 * - `loadJevConfig` (T1) — returns the test's config, or null;
 * - `transportForConfig` (T1) — a scripted fake Jev;
 * - `readIntent` / `captureIntent` (T4) — scripted / spied;
 * - the builtin AUTHORITY table (T2) — simulated by re-registering the
 *   user-approved (D1) reviewable builtins with their `reviewedBy` meta.
 *
 * Every throwaway directory (HOME, FAILPROOFAI_HOME, packs) is per-test; no
 * real `jev.json` is ever read or written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationType } from "../../src/hooks/types";
import type { JevRequest, JevResponse } from "../../src/hooks/semantic/types";
import type { JevConfig } from "../../src/hooks/semantic/jev-config";

// ── Contract mocks ───────────────────────────────────────────────────────────

let jevConfig: JevConfig | null = null;
vi.mock("../../src/hooks/semantic/jev-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/semantic/jev-config")>();
  return { ...actual, loadJevConfig: vi.fn(() => jevConfig) };
});

type Respond = (request: JevRequest, signal: AbortSignal) => Promise<JevResponse>;
const jevCalls: Array<{ request: JevRequest; signal: AbortSignal }> = [];
let respond: Respond;
vi.mock("../../src/hooks/semantic/jev-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/semantic/jev-client")>();
  return {
    ...actual,
    transportForConfig: vi.fn((cfg: JevConfig) => ({
      transport: (request: JevRequest, signal: AbortSignal) => {
        jevCalls.push({ request, signal });
        return respond(request, signal);
      },
      via: cfg.provider,
      model: "jev-1.13.0",
    })),
  };
});

let intent: { userSaid: string[]; agentLastMessage: string | null } = { userSaid: [], agentLastMessage: null };
vi.mock("../../src/hooks/semantic/intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/semantic/intent")>();
  return { ...actual, readIntent: vi.fn(() => intent), captureIntent: vi.fn() };
});

/** The user-approved (D1) reviewable builtins; everything else stays hard. */
const D1_REVIEWABLE: Record<string, string[]> = {
  "block-read-outside-cwd": ["read-outside-workspace"],
  "protect-env-vars": ["env-secrets-dump", "secret-exposure"],
  "block-env-files": ["secret-exposure"],
  "block-work-on-main": ["commit-on-protected-branch"],
  "warn-git-amend": ["git-history-rewrite"],
  "warn-destructive-sql": ["database-destruction"],
  "warn-global-package-install": ["system-modification"],
};
/** Extra per-test declarations, e.g. an attempt to mark the alwaysOn guard reviewable. */
let extraReviewable: Record<string, string[]> = {};

vi.mock("../../src/hooks/builtin-policies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/builtin-policies")>();
  const registry = await import("../../src/hooks/policy-registry");
  return {
    ...actual,
    registerBuiltinPolicies: vi.fn((names: string[]) => {
      actual.registerBuiltinPolicies(names);
      const registered = new Set(registry.getAllPolicies().map((p) => p.name));
      for (const p of actual.BUILTIN_POLICIES) {
        const reviewedBy = extraReviewable[p.name] ?? D1_REVIEWABLE[p.name];
        if (!reviewedBy || !registered.has(`failproofai/${p.name}`)) continue;
        registry.registerPolicy(p.name, p.description, p.fn, p.match, 0, p.params, { authority: "reviewable", reviewedBy });
      }
    }),
  };
});

vi.mock("../../src/hooks/cloud-managed-policies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/cloud-managed-policies")>();
  return { ...actual, readActiveCloudManagedPolicies: vi.fn(actual.readActiveCloudManagedPolicies) };
});
vi.mock("../../src/hooks/custom-hooks-loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/custom-hooks-loader")>();
  return { ...actual, loadAllCustomHooks: vi.fn(actual.loadAllCustomHooks) };
});

import { evaluateHookEvent } from "../../src/hooks/handler";
import { captureIntent } from "../../src/hooks/semantic/intent";
import { loadJevConfig } from "../../src/hooks/semantic/jev-config";
import { transportForConfig } from "../../src/hooks/semantic/jev-client";
import { readActiveCloudManagedPolicies } from "../../src/hooks/cloud-managed-policies";
import { loadAllCustomHooks } from "../../src/hooks/custom-hooks-loader";
import { writePause } from "../../src/hooks/session-pause";
import * as store from "../../src/hooks/hook-activity-store";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ENABLED = [
  "block-sudo",
  "block-rm-rf",
  "block-read-outside-cwd",
  "protect-env-vars",
  "block-env-files",
  "warn-git-amend",
  "warn-git-stash-drop",
  "warn-destructive-sql",
];
const CFG: JevConfig = { provider: "cloudflare", apiKey: "not-a-real-key", accountId: "0".repeat(32) };
const SESSION = "two-tier-session";

let root: string;
let home: string;
let project: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_EVALUATOR", "CLAUDE_PROJECT_DIR"];

/** Every question answered with `base`, except ids matching an override prefix. */
function answers(overrides: Record<string, number> = {}, base = 0.05): Respond {
  return async (request) => ({
    model: request.model,
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => {
        const hit = Object.entries(overrides).find(([prefix]) => id === prefix || id.startsWith(`${prefix}.`));
        return [id, { noul: hit ? hit[1] : base }];
      }),
    ),
  });
}

const hang: Respond = (_request, signal) =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError"))));

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "fpai-two-tier-"));
  home = join(root, "home");
  project = join(home, "project");
  mkdirSync(join(home, ".failproofai"), { recursive: true });
  mkdirSync(join(home, "other"), { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, "packs"), { recursive: true });
  process.env.HOME = home;
  process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  process.env.FAILPROOFAI_PACK_DIR = join(root, "packs");
  delete process.env.FAILPROOFAI_EVALUATOR;
  delete process.env.CLAUDE_PROJECT_DIR;
  writeFileSync(join(home, ".failproofai", "policies-config.json"), JSON.stringify({ enabledPolicies: ENABLED }));
  store._resetForTest(join(root, "activity"));

  jevConfig = null;
  jevCalls.length = 0;
  respond = answers();
  intent = { userSaid: [], agentLastMessage: null };
  extraReviewable = {};
  vi.mocked(captureIntent).mockClear();
  vi.mocked(transportForConfig).mockClear();
  vi.mocked(loadJevConfig).mockClear();
});

afterEach(() => {
  store._resetForTest();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

async function run(
  event: string,
  payload: Record<string, unknown>,
  cli: IntegrationType = "claude",
  opts?: Parameters<typeof evaluateHookEvent>[3],
) {
  const outcome = await evaluateHookEvent(
    event,
    cli,
    JSON.stringify({ session_id: SESSION, cwd: project, hook_event_name: event, ...payload }),
    { awaitTelemetryFlush: false, ...opts },
  );
  const row = store.getAllHookActivityEntries()[0] as unknown as Record<string, unknown>;
  return { outcome, row };
}
const bash = (command: string, cli?: IntegrationType) => run("PreToolUse", { tool_name: "Bash", tool_input: { command } }, cli);
const readFile = (file_path: string, cli?: IntegrationType) => run("PreToolUse", { tool_name: "Read", tool_input: { file_path } }, cli);
const JEV_KEYS = ["evaluator", "jevDecision", "jevCleared", "jevFallbackReason", "jevLatencyMs", "jevModel", "jevMode"];
const jevKeysOf = (row: Record<string, unknown>) => Object.keys(row).filter((k) => JEV_KEYS.includes(k));

// ── Opt-in ───────────────────────────────────────────────────────────────────

describe("opt-in", () => {
  it("unconfigured: Jev is never started, and the row carries no Jev field", async () => {
    const { outcome, row } = await readFile(join(home, "other", "notes.txt"));
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(transportForConfig).not.toHaveBeenCalled();
    expect(jevCalls).toHaveLength(0);
    expect(jevKeysOf(row)).toEqual([]);
  });

  it("FAILPROOFAI_EVALUATOR=legacy with a config present: byte-identical to unconfigured, config never read", async () => {
    const unconfigured = await readFile(join(home, "other", "notes.txt"));
    jevConfig = CFG;
    process.env.FAILPROOFAI_EVALUATOR = "legacy";
    vi.mocked(loadJevConfig).mockClear();
    const legacy = await readFile(join(home, "other", "notes.txt"));
    expect(loadJevConfig).not.toHaveBeenCalled();
    expect(jevCalls).toHaveLength(0);
    const strip = (o: typeof legacy) => ({ ...o.outcome, evaluation: { ...o.outcome.evaluation, durationMs: 0 } });
    expect(strip(legacy)).toEqual(strip(unconfigured));
    expect(jevKeysOf(legacy.row)).toEqual([]);
  });

  it("only gate events are reviewed: PostToolUse, UserPromptSubmit and SessionStart never reach Jev", async () => {
    jevConfig = CFG;
    await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "x" } });
    await run("UserPromptSubmit", { prompt: "hello" });
    await run("SessionStart", {});
    expect(jevCalls).toHaveLength(0);
  });

  it("PermissionRequest is a gate and is reviewed", async () => {
    jevConfig = CFG;
    const { row } = await run("PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } }, "codex");
    expect(jevCalls).toHaveLength(1);
    expect(row.evaluator).toBe("jev");
  });

  it("an active session pause: Jev is not consulted", async () => {
    jevConfig = CFG;
    writePause({ sessionId: SESSION, durationMs: 60_000, setBy: "test" });
    const { row } = await bash("rm -rf build");
    expect(jevCalls).toHaveLength(0);
    expect(row.pausedBy).toBeDefined();
    expect(jevKeysOf(row)).toEqual([]);
  });

  it("the fail-closed forceDecision path: Jev is not consulted and the config is not read", async () => {
    jevConfig = CFG;
    const { outcome } = await run(
      "PreToolUse",
      { tool_name: "Bash", tool_input: { command: "ls" } },
      "claude",
      { forceDecision: { decision: "deny", reason: "daemon unreachable" } },
    );
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(loadJevConfig).not.toHaveBeenCalled();
    expect(jevCalls).toHaveLength(0);
  });

  it("a config that throws on load is treated as absent", async () => {
    vi.mocked(loadJevConfig).mockImplementationOnce(() => {
      throw new Error("bad json");
    });
    const { row } = await bash("ls");
    expect(jevCalls).toHaveLength(0);
    expect(jevKeysOf(row)).toEqual([]);
  });
});

// ── Hard floor ───────────────────────────────────────────────────────────────

describe("a hard deny", () => {
  it("short-circuits and aborts the in-flight Jev request", async () => {
    jevConfig = CFG;
    respond = hang;
    const { outcome, row } = await bash("sudo rm -rf /var/lib/app");
    expect(outcome.evaluation?.policyName).toBe("failproofai/block-sudo");
    expect(outcome.stdout).toContain('"permissionDecision":"deny"');
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0].signal.aborted).toBe(true);
    expect(row).toMatchObject({ evaluator: "jev", jevMode: "enforce", policySource: "builtin" });
    expect(row.jevDecision).toBeUndefined();
  });

  it("stands even when Jev would have allowed it", async () => {
    jevConfig = CFG;
    const { outcome } = await bash("rm -rf /");
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(outcome.evaluation?.policyName).toBe("failproofai/block-rm-rf");
  });

  it("the always-on self-protection guard stays hard even when declared reviewable", async () => {
    jevConfig = CFG;
    respond = hang;
    extraReviewable = { "block-failproofai-commands": ["agent-config-tampering"] };
    const { outcome, row } = await bash(["fail" + "proofai", "policies", "--uninstall", "block-sudo"].join(" "));
    expect(outcome.evaluation?.policyName).toBe("failproofai/block-failproofai-commands");
    expect(outcome.evaluation?.decision).toBe("deny");
    // Treated as hard: Jev was aborted rather than awaited, so it had no say.
    expect(jevCalls[0].signal.aborted).toBe(true);
    expect(row.jevDecision).toBeUndefined();
  });
});

// ── Clears ───────────────────────────────────────────────────────────────────

describe("a reviewable deny", () => {
  const outsideRead = () => readFile(join(home, "other", "notes.txt"));

  it("is cleared when its reviewer was asked and came back clear (enforce)", async () => {
    jevConfig = CFG;
    const { outcome, row } = await outsideRead();
    expect(jevCalls).toHaveLength(1);
    expect(Object.keys(jevCalls[0].request.questions)).toContain("read-outside-workspace.reads_outside");
    expect(outcome.evaluation?.decision).toBe("allow");
    expect(outcome.stdout).toBe("");
    expect(outcome.exitCode).toBe(0);
    expect(row).toMatchObject({
      evaluator: "jev",
      jevDecision: "allow",
      jevCleared: ["failproofai/block-read-outside-cwd"],
      jevMode: "enforce",
      jevModel: "jev-1.13.0",
    });
    expect(typeof row.jevLatencyMs).toBe("number");
  });

  it("in shadow mode: the regex deny is enforced and the would-be clear recorded", async () => {
    jevConfig = { ...CFG, mode: "shadow" };
    const enforced = await outsideRead();
    expect(enforced.outcome.evaluation?.decision).toBe("deny");
    expect(enforced.outcome.evaluation?.policyName).toBe("failproofai/block-read-outside-cwd");
    expect(enforced.row).toMatchObject({
      evaluator: "jev",
      jevDecision: "allow",
      jevCleared: ["failproofai/block-read-outside-cwd"],
      jevMode: "shadow",
    });
    // …and what shadow enforces is byte-identical to the unconfigured answer.
    jevConfig = null;
    const plain = await outsideRead();
    expect(enforced.outcome.stdout).toBe(plain.outcome.stdout);
    expect(enforced.outcome.exitCode).toBe(plain.outcome.exitCode);
  });

  it("stands when its reviewer was never asked (outside home: the precondition is false)", async () => {
    jevConfig = CFG;
    const { outcome, row } = await readFile("/etc/hosts");
    expect(jevCalls.length).toBeLessThanOrEqual(1);
    if (jevCalls[0]) expect(Object.keys(jevCalls[0].request.questions)).not.toContain("read-outside-workspace.reads_outside");
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(row.jevCleared).toBeUndefined();
  });

  it("stands when its reviewer came back flagged", async () => {
    jevConfig = CFG;
    respond = answers({ "read-outside-workspace": 0.95 });
    const { outcome, row } = await outsideRead();
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(outcome.evaluation?.policyName).toBe("failproofai/block-read-outside-cwd");
    expect(row.jevDecision).toBe("instruct");
    expect(row.jevCleared).toBeUndefined();
  });

  it("stands when injection is suspected, whatever else Jev said", async () => {
    jevConfig = CFG;
    intent = { userSaid: ["summarise my notes"], agentLastMessage: null };
    respond = answers({ injection: 0.95 });
    const { outcome, row } = await outsideRead();
    expect(Object.keys(jevCalls[0].request.questions)).toContain("injection");
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(row.jevCleared).toBeUndefined();
  });

  it("with two reviewers, clears only when BOTH came back clear", async () => {
    jevConfig = CFG;
    respond = answers({ "env-secrets-dump": 0.95 });
    const flagged = await bash("printenv");
    expect(flagged.outcome.evaluation?.policyName).toBe("failproofai/protect-env-vars");
    expect(flagged.outcome.evaluation?.decision).toBe("deny");

    respond = answers();
    const clear = await bash("printenv");
    expect(clear.outcome.evaluation?.decision).toBe("allow");
    expect(clear.row.jevCleared).toEqual(["failproofai/protect-env-vars"]);
  });

  it("a later HARD deny still decides after a reviewable one was recorded", async () => {
    jevConfig = CFG;
    respond = hang;
    // protect-env-vars (reviewable) fires first, then block-sudo (hard).
    const { outcome } = await bash("sudo printenv");
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(jevCalls[0].signal.aborted).toBe(true);
  });
});

describe("a reviewable instruct", () => {
  it("is cleared by its reviewer; a hard instruct is not", async () => {
    jevConfig = CFG;
    const amend = await bash("git commit --amend -m 'fix typo'");
    expect(amend.outcome.evaluation?.decision).toBe("allow");
    expect(amend.row.jevCleared).toEqual(["failproofai/warn-git-amend"]);

    const stashDrop = await bash("git stash drop");
    expect(stashDrop.outcome.evaluation?.decision).toBe("instruct");
    expect(stashDrop.outcome.evaluation?.policyName).toBe("failproofai/warn-git-stash-drop");
    expect(stashDrop.row.jevCleared).toBeUndefined();
  });
});

// ── Jev's own verdict ────────────────────────────────────────────────────────

describe("Jev's own verdict", () => {
  it("decides when the regex engine allows: shaped per CLI, attributed to the semantic policy", async () => {
    jevConfig = CFG;
    respond = answers({ "destructive-deletion": 0.97 });
    const claude = await bash("find . -name '*.sqlite' -delete");
    expect(claude.outcome.evaluation?.decision).toBe("deny");
    expect(claude.outcome.evaluation?.policyName).toBe("semantic/destructive-deletion");
    expect(claude.outcome.stdout).toContain('"permissionDecision":"deny"');
    expect(claude.outcome.stdout).toContain("semantic/destructive-deletion");
    // No registered policy decided, so none is claimed.
    expect(claude.row.policySource).toBeUndefined();
    expect(claude.row).toMatchObject({ evaluator: "jev", jevDecision: "deny" });

    const factory = await bash("find . -name '*.sqlite' -delete", "factory");
    expect(factory.outcome.exitCode).toBe(2);
    expect(factory.outcome.stderr).toContain("semantic/destructive-deletion");
    const cursor = await bash("find . -name '*.sqlite' -delete", "cursor");
    expect(JSON.parse(cursor.outcome.stdout).permission).toBe("deny");
  });

  it("the most severe wins: a regex instruct and a Jev deny → deny", async () => {
    jevConfig = CFG;
    respond = answers({ "git-history-rewrite": 0.97 });
    const { outcome } = await bash("git stash drop");
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(outcome.evaluation?.policyName).toBe("semantic/git-history-rewrite");
  });

  it("a regex instruct and a Jev instruct are both delivered, regex first", async () => {
    jevConfig = CFG;
    respond = answers({ "system-modification": 0.9 });
    const { outcome } = await bash("git stash drop && sysctl -w vm.swappiness=10");
    expect(outcome.evaluation?.decision).toBe("instruct");
    expect(outcome.evaluation?.policyNames).toEqual(["failproofai/warn-git-stash-drop", "semantic/system-modification"]);
    expect(JSON.parse(outcome.stdout).hookSpecificOutput.additionalContext).toContain("Instruction from failproofai:");
  });
});

// ── Fallbacks ────────────────────────────────────────────────────────────────

describe("fallback: the regex result, recorded with a reason", () => {
  const outsideRead = () => readFile(join(home, "other", "notes.txt"));

  it("a timeout", async () => {
    jevConfig = { ...CFG, timeoutMs: 25 };
    respond = hang;
    const { outcome, row } = await outsideRead();
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(outcome.evaluation?.policyName).toBe("failproofai/block-read-outside-cwd");
    expect(row).toMatchObject({ evaluator: "jev-fallback", jevFallbackReason: "timeout", jevMode: "enforce" });
    expect(row.jevDecision).toBeUndefined();
  });

  it.each(["http-429", "http-503", "out-of-credits", "rate-limited"])("a JevError %s", async (code) => {
    const { JevError } = await import("../../src/hooks/semantic/jev-client");
    jevConfig = CFG;
    respond = async () => {
      throw new JevError(code, "nope");
    };
    const { outcome, row } = await outsideRead();
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(row).toMatchObject({ evaluator: "jev-fallback", jevFallbackReason: code, jevMode: "enforce" });
    expect(row.jevCleared).toBeUndefined();
  });

  it("a model mismatch", async () => {
    jevConfig = CFG;
    respond = async (request) => ({ ...(await answers()(request, new AbortController().signal)), model: "jev-2.0.0" });
    const { outcome, row } = await outsideRead();
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(row).toMatchObject({ evaluator: "jev-fallback", jevFallbackReason: "model-mismatch" });
  });

  it("a truncated envelope: regex decides, Jev's answer is recorded but not enforced", async () => {
    jevConfig = CFG;
    const padded = `cat ${join(home, "other", "notes.txt")} ${"#".repeat(4000)}`;
    const { outcome, row } = await bash(padded);
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(row).toMatchObject({ evaluator: "jev-fallback", jevFallbackReason: "truncated", jevDecision: "allow" });
  });

  it("a provider the transport layer cannot build", async () => {
    const { JevError } = await import("../../src/hooks/semantic/jev-client");
    jevConfig = CFG;
    vi.mocked(transportForConfig).mockImplementationOnce(() => {
      throw new JevError("config", "unsupported");
    });
    const { outcome, row } = await outsideRead();
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(row).toMatchObject({ evaluator: "jev-fallback", jevFallbackReason: "config" });
  });
});

// ── Cloud-managed machines ───────────────────────────────────────────────────

describe("a cloud-managed machine", () => {
  function cloudHook(decision: "allow" | "deny") {
    const artifact = { id: "org-guard", version: 7, deployment: 4, path: join(root, "cloud.mjs"), effect: "enforce" };
    vi.mocked(readActiveCloudManagedPolicies).mockReturnValueOnce([artifact] as never);
    vi.mocked(loadAllCustomHooks).mockResolvedValueOnce({
      hooks: [
        Object.assign(
          {
            name: "org-guard",
            description: "cloud",
            match: { events: ["PreToolUse"] },
            fn: async () => ({ decision, reason: "org says no" }),
          },
          { __cloudManaged: artifact },
        ),
      ],
      conventionSources: [],
    } as never);
  }

  it("is still reviewed by Jev — the prototype's cloud exclusion is gone", async () => {
    jevConfig = CFG;
    cloudHook("allow");
    const { row } = await bash("ls -la");
    expect(jevCalls).toHaveLength(1);
    expect(row).toMatchObject({ evaluator: "jev", cloudDeployment: 4 });
  });

  it("and a cloud policy is hard by default: Jev cannot clear it", async () => {
    jevConfig = CFG;
    cloudHook("deny");
    const { outcome, row } = await bash("ls -la");
    expect(outcome.evaluation?.decision).toBe("deny");
    expect(outcome.evaluation?.policyName).toBe("cloud/org-guard@7/org-guard");
    expect(row.policySource).toBe("cloud");
    expect(row.jevDecision).toBeUndefined();
  });
});

// ── Intent capture ───────────────────────────────────────────────────────────

describe("captureIntent", () => {
  it("records every canonical UserPromptSubmit, with the cli id, when Jev is configured", async () => {
    jevConfig = CFG;
    await run("UserPromptSubmit", { prompt: "please tidy the build folder", transcript_path: join(root, "t.jsonl") });
    await run("beforeSubmitPrompt", { prompt: "and the cache" }, "cursor");
    expect(captureIntent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(captureIntent).mock.calls[0][0]).toEqual({
      eventType: "UserPromptSubmit",
      sessionId: SESSION,
      prompt: "please tidy the build folder",
      transcriptPath: join(root, "t.jsonl"),
      cli: "claude",
    });
    expect(vi.mocked(captureIntent).mock.calls[1][0]).toMatchObject({ eventType: "UserPromptSubmit", cli: "cursor" });
  });

  it("records nothing when unconfigured, under FAILPROOFAI_EVALUATOR=legacy, or for other events", async () => {
    await run("UserPromptSubmit", { prompt: "hello" });
    jevConfig = CFG;
    process.env.FAILPROOFAI_EVALUATOR = "legacy";
    await run("UserPromptSubmit", { prompt: "hello" });
    delete process.env.FAILPROOFAI_EVALUATOR;
    await bash("ls");
    expect(captureIntent).not.toHaveBeenCalled();
  });

  it("never throws into the hook", async () => {
    jevConfig = CFG;
    vi.mocked(captureIntent).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const { outcome } = await run("UserPromptSubmit", { prompt: "hello" });
    expect(outcome.exitCode).toBe(0);
  });
});
