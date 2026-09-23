// @vitest-environment node
/**
 * The §4 truncation rule end to end, through the REAL intent store: the human
 * prompt goes in through the handler's own UserPromptSubmit path
 * (`captureIntent`), and the next gated call reads it back (`readIntent`) —
 * whichever intent store is built in (the contract stub here, T4's store at
 * integration). Nothing about intent is mocked.
 *
 * Why this exists: T4 caps a stored prompt to fit inside the envelope's own
 * limit, omission mark included, so the envelope never cuts it again and its
 * own `truncated` flag stays false. A test that mocks `readIntent` with the raw
 * long prompt shows the rule holding when, against the real store, it may not.
 *
 * Mocked, at their contract boundaries only: the Jev config (T1), the provider
 * (T1's transport — a fake Jev that clears everything), the throttle (T5, a
 * pass-through), and the D1 authority of `block-read-outside-cwd` (T2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevRequest, JevResponse } from "../../src/hooks/semantic/types";
import type { JevConfig } from "../../src/hooks/semantic/jev-config";

let jevConfig: JevConfig | null = null;
vi.mock("../../src/hooks/semantic/jev-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/semantic/jev-config")>();
  return { ...actual, loadJevConfig: vi.fn(() => jevConfig) };
});

const jevCalls: JevRequest[] = [];
vi.mock("../../src/hooks/semantic/jev-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/semantic/jev-client")>();
  return {
    ...actual,
    transportForConfig: vi.fn((cfg: JevConfig) => ({
      // Every question answered low: every reviewer clear, no injection.
      transport: async (request: JevRequest): Promise<JevResponse> => {
        jevCalls.push(request);
        return {
          model: request.model,
          answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: 0.05 }])),
        };
      },
      via: cfg.provider,
      model: "jev-1.13.0",
    })),
  };
});

vi.mock("../../src/hooks/semantic/jev-throttle", () => ({
  throttleTransport: vi.fn((t: unknown) => t),
  isCachedJevResponse: vi.fn(() => false),
}));

vi.mock("../../src/hooks/builtin-policies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/builtin-policies")>();
  const registry = await import("../../src/hooks/policy-registry");
  return {
    ...actual,
    registerBuiltinPolicies: vi.fn((names: string[]) => {
      actual.registerBuiltinPolicies(names);
      const p = actual.BUILTIN_POLICIES.find((b) => b.name === "block-read-outside-cwd");
      if (p && registry.getAllPolicies().some((r) => r.name === "failproofai/block-read-outside-cwd")) {
        registry.registerPolicy(p.name, p.description, p.fn, p.match, 0, p.params, {
          authority: "reviewable",
          reviewedBy: ["read-outside-workspace"],
        });
      }
    }),
  };
});

vi.mock("../../src/hooks/hook-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/hook-telemetry")>();
  return { ...actual, trackHookEvent: vi.fn(() => Promise.resolve()), flushHookTelemetry: vi.fn(() => Promise.resolve()) };
});

import { evaluateHookEvent } from "../../src/hooks/handler";
import { readIntent } from "../../src/hooks/semantic/intent";
import { MAX_USER_MESSAGE_CHARS } from "../../src/hooks/semantic/envelope";
import * as store from "../../src/hooks/hook-activity-store";

const CFG: JevConfig = { provider: "cloudflare", apiKey: "not-a-real-key", accountId: "0".repeat(32) };
const SESSION = "intent-storage-session";
const ENV = ["HOME", "FAILPROOFAI_HOME", "FAILPROOFAI_PACK_DIR", "FAILPROOFAI_EVALUATOR", "CLAUDE_PROJECT_DIR"];
const saved: Record<string, string | undefined> = {};
let root: string;
let home: string;
let project: string;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  root = mkdtempSync(join(tmpdir(), "fpai-intent-storage-"));
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
  writeFileSync(
    join(home, ".failproofai", "policies-config.json"),
    JSON.stringify({ enabledPolicies: ["block-read-outside-cwd", "block-sudo"] }),
  );
  store._resetForTest(join(root, "activity"));
  jevConfig = CFG;
  jevCalls.length = 0;
});

afterEach(() => {
  store._resetForTest();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

async function hook(event: string, payload: Record<string, unknown>) {
  const outcome = await evaluateHookEvent(
    event,
    "claude",
    JSON.stringify({ session_id: SESSION, cwd: project, hook_event_name: event, ...payload }),
    { awaitTelemetryFlush: false },
  );
  // Newest first: this call's row.
  const row = store.getAllHookActivityEntries()[0] as unknown as Record<string, unknown>;
  return { outcome, row };
}

const outsideRead = () => hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: join(home, "other", "notes.txt") } });

// Sized off the store's own cap, not off a literal, so raising the cap does
// not quietly turn this into a prompt that fits.
const LONG_PROMPT =
  "Please tidy the notes folder. " +
  "Background detail about the project that the human pasted. ".repeat(Math.ceil((MAX_USER_MESSAGE_CHARS * 2) / 58)) +
  "Also: never touch ~/other.";

describe("the human's prompt, stored by the real intent store and read back for the next call", () => {
  it("control: a short prompt is recorded, read back, and the reviewable deny is cleared", async () => {
    await hook("UserPromptSubmit", { prompt: "summarise my notes" });
    expect(readIntent(SESSION).userSaid).toEqual(["summarise my notes"]);
    const { outcome, row } = await outsideRead();
    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0].state.user_said).toEqual(["summarise my notes"]);
    expect(outcome.evaluation?.decision).toBe("allow");
    expect(row).toMatchObject({ evaluator: "jev", jevCleared: ["failproofai/block-read-outside-cwd"] });
  });

  /**
   * The regression the previous revision shipped, through the REAL store: a
   * pasted spec is over the store's cap, so the prompt came back cut, every
   * clear was withdrawn, and the reviewable deny stood. Same call, same
   * answers, different verdict — decided by how much the human typed.
   *
   * The store's cap is unchanged; what changed is that the cut is recorded and
   * read no further.
   */
  it("a long prompt is stored cut, and the verdict is identical to the short one", async () => {
    await hook("UserPromptSubmit", { prompt: LONG_PROMPT });
    const stored = readIntent(SESSION).userSaid;
    // The premise: the store kept a cut version, marked as cut.
    expect(stored).toHaveLength(1);
    expect(stored[0].length).toBeLessThan(LONG_PROMPT.length);
    expect(stored[0]).toMatch(/…\[\d+ characters omitted\]…/);

    const { outcome, row } = await outsideRead();
    expect(jevCalls).toHaveLength(1);
    expect(outcome.evaluation?.decision).toBe("allow");
    expect(row).toMatchObject({ evaluator: "jev", jevCleared: ["failproofai/block-read-outside-cwd"] });
    expect(row.jevFallbackReason).toBeUndefined();
  });

  /**
   * The other half of the same regression, and the one a raised flag could not
   * fix: `targetNamedByUser` (`decide.ts`) is a LOCAL substring check over what
   * the store KEPT, so a cap short enough to drop the thing the human named
   * turns an explicit request into an instruct — no truncation flag involved.
   *
   * `MAX_USER_MESSAGE_CHARS` is what the store caps at (`intent.ts` imports
   * it), and it is sized for what people actually paste. This pins the
   * property the size was chosen for: a request with a page of context around
   * it still names its target in the stored prompt.
   */
  it("a pasted page of context around an explicit request keeps the target", async () => {
    const ask = "please read notes.txt in ~/other for me";
    const padding = "Background the human pasted about this project. ";
    const around = Math.floor(MAX_USER_MESSAGE_CHARS / 3 / padding.length);
    await hook("UserPromptSubmit", { prompt: `${padding.repeat(around)}\n${ask}\n${padding.repeat(around)}` });
    const [stored] = readIntent(SESSION).userSaid;
    expect(stored.length).toBeGreaterThan(1_200);
    // The point: the sentence the human typed survived the store's cap.
    expect(stored).toContain(ask);
    const { outcome, row } = await outsideRead();
    expect(outcome.evaluation?.decision).toBe("allow");
    expect(row).toMatchObject({ evaluator: "jev", jevCleared: ["failproofai/block-read-outside-cwd"] });
  });
});
