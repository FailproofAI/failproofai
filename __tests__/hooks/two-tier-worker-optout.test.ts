// @vitest-environment node
/**
 * Turning Jev off on a daemon-configured machine — every machine that
 * finished setup — where hooks are evaluated by the daemon's warm worker, not
 * by the hook process.
 *
 * - The switch that works there is the config file: `failproofai jev remove`
 *   deletes it, and the worker reads it on every event, so the very next hook
 *   is regex-only, with no worker restart.
 * - `FAILPROOFAI_EVALUATOR=legacy` is the dev escape hatch. It is read from
 *   the evaluating process's environment, so it is honoured when the worker's
 *   own environment sets it; a hook request cannot carry it (the daemon
 *   forwards a hook's event, cli, stdin and cwd — never the hook process's
 *   environment), which `failproofai jev status` tells a user who exported it.
 *
 * Real socket, real framing, real worker loop, real evaluation. Only the
 * contract boundaries are faked: T1's config loader (a mutable config) and
 * transport (a Jev that flags every deletion), and T4's `readIntent` (one
 * short human message).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JevConfig } from "../../src/hooks/semantic/jev-config";
import type { JevRequest, JevResponse } from "../../src/hooks/semantic/types";
import { resetJevThrottle } from "../../src/hooks/semantic/jev-throttle";

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));

const CFG: JevConfig = { provider: "cloudflare", apiKey: "not-a-real-key", accountId: "0".repeat(32) };
let jevConfig: JevConfig | null = CFG;
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
      // Jev flags every destructive deletion; everything else comes back low.
      transport: async (request: JevRequest): Promise<JevResponse> => {
        jevCalls.push(request);
        return {
          model: request.model,
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [id, { noul: id.startsWith("destructive-deletion.") ? 0.97 : 0.05 }]),
          ),
        };
      },
      via: cfg.provider,
      model: "jev-1.13.0",
    })),
  };
});

vi.mock("../../src/hooks/semantic/intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/semantic/intent")>();
  return { ...actual, readIntent: vi.fn(() => ({ userSaid: ["tidy up my notes"], agentLastMessage: null })) };
});

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** One request on its own connection, as the Rust supervisor sends it; resolves with the reply frame. */
function send(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath }, () => socket.write(encodeFrame(request)));
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      socket.end();
      resolvePromise(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
    });
    socket.on("error", reject);
  });
}

// Allowed by every regex policy enabled below; Jev flags it.
const DELETION = "find . -name '*.sqlite' -delete";

describe("turning Jev off on a daemon-configured machine", () => {
  let root: string;
  let projectDir: string;
  let socketPath: string;
  let server: import("node:net").Server;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of ["HOME", "FAILPROOFAI_HOME", "FAILPROOFAI_EVALUATOR"]) saved[k] = process.env[k];
    jevCalls.length = 0;
    // The response cache and the rate limiter are module-level and outlive a
    // test, so a count of upstream calls means nothing without this (see
    // `jev-throttle.ts`, "Tests").
    resetJevThrottle();
    jevConfig = CFG;
    root = mkdtempSync(join(tmpdir(), "fpai-two-tier-optout-"));
    projectDir = join(root, "home", "project");
    mkdirSync(join(projectDir, ".failproofai"), { recursive: true });
    mkdirSync(join(root, "fphome"), { recursive: true });
    process.env.HOME = join(root, "home");
    process.env.FAILPROOFAI_HOME = join(root, "fphome");
    delete process.env.FAILPROOFAI_EVALUATOR;
    writeFileSync(join(projectDir, ".failproofai", "policies-config.json"), JSON.stringify({ enabledPolicies: ["block-sudo"] }));
    socketPath = join(tmpdir(), `fpai-two-tier-optout-${process.pid}-${Date.now()}.sock`);
    const { startWorkerServer } = await import("../../src/hooks/worker-server");
    server = startWorkerServer(socketPath);
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const hook = (extra: Record<string, unknown> = {}) => ({
    type: "hook",
    hookEvent: "PreToolUse",
    cli: "claude",
    stdin: JSON.stringify({ cwd: projectDir, session_id: "optout-test", tool_name: "Bash", tool_input: { command: DELETION } }),
    cwd: projectDir,
    ...extra,
  });
  const decisionOf = (r: Record<string, unknown>) => (r.evaluation as { decision?: string } | undefined)?.decision;
  const deciderOf = (r: Record<string, unknown>) => (r.evaluation as { policyName?: string | null } | undefined)?.policyName;

  it("the config file is the switch: removing it turns Jev off on the next hook, with no worker restart", async () => {
    const on = await send(socketPath, hook());
    expect(jevCalls).toHaveLength(1);
    expect(decisionOf(on)).toBe("deny");
    expect(deciderOf(on)).toBe("semantic/destructive-deletion");

    // `failproofai jev remove`: the file is gone; the same warm worker answers.
    jevConfig = null;
    const off = await send(socketPath, hook());
    expect(jevCalls).toHaveLength(1);
    expect(decisionOf(off)).toBe("allow");
    expect(off.stdout).toBe("");

    // …and back on, again without a restart. The hook is deliberately the SAME
    // call as the first one — that is what makes this an A/B of the config file
    // and nothing else — which means its Jev request is byte-identical and
    // T5's response cache would answer it from the first call's answer. A
    // cached answer is a real answer and the decision below would still be
    // `deny`, but then the call count would say nothing about whether Jev was
    // consulted, which is the whole claim here. Clearing the cache first makes
    // the count mean what it says: a request really did go upstream.
    jevConfig = CFG;
    resetJevThrottle();
    const again = await send(socketPath, hook());
    expect(jevCalls).toHaveLength(2);
    expect(jevCalls[1].questions).toEqual(jevCalls[0].questions);
    expect(decisionOf(again)).toBe("deny");
    expect(deciderOf(again)).toBe("semantic/destructive-deletion");
  });

  it("FAILPROOFAI_EVALUATOR=legacy in the worker's own environment is honoured", async () => {
    process.env.FAILPROOFAI_EVALUATOR = "legacy";
    const reply = await send(socketPath, hook());
    expect(jevCalls).toHaveLength(0);
    expect(decisionOf(reply)).toBe("allow");
    expect(reply.stdout).toBe("");
  });

  it("a hook request cannot carry the escape hatch: nothing in the request is read as environment", async () => {
    const reply = await send(
      socketPath,
      hook({
        env: { FAILPROOFAI_EVALUATOR: "legacy" },
        stdin: JSON.stringify({
          cwd: projectDir,
          session_id: "optout-test",
          tool_name: "Bash",
          tool_input: { command: DELETION },
          FAILPROOFAI_EVALUATOR: "legacy",
        }),
      }),
    );
    expect(jevCalls).toHaveLength(1);
    expect(decisionOf(reply)).toBe("deny");
  });
});
