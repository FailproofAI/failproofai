// @vitest-environment node
/**
 * End-to-end test of the warm worker's real server loop: real socket, real
 * framing, real policy evaluation (not mocked) — proves the worker
 * genuinely reuses the unchanged evaluation engine rather than a stub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createConnection, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function readFrame(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let buf = Buffer.alloc(0);
    let declaredLen: number | null = null;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (declaredLen === null) {
        if (buf.length < 4) return;
        declaredLen = buf.readUInt32BE(0);
        buf = buf.subarray(4);
      }
      if (buf.length < declaredLen) return;
      socket.off("data", onData);
      resolvePromise(JSON.parse(buf.subarray(0, declaredLen).toString("utf8")));
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

/**
 * Claude's PreToolUse deny contract is JSON on stdout at exit code 0
 * (`hookSpecificOutput.permissionDecision`), not a nonzero exit code — see
 * policy-evaluator.ts. Parse it out rather than asserting on exitCode.
 */
function permissionDecisionOf(response: Record<string, unknown>): string | undefined {
  const stdout = response.stdout;
  if (typeof stdout !== "string" || !stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    return parsed.hookSpecificOutput?.permissionDecision;
  } catch {
    return undefined;
  }
}

async function sendRequest(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: socketPath }, () => {
      socket.write(encodeFrame(request));
    });
    readFrame(socket)
      .then((msg) => {
        socket.end();
        resolvePromise(msg);
      })
      .catch(reject);
    socket.on("error", reject);
  });
}

describe("hooks/worker-server (real socket, real evaluation)", () => {
  let projectDir: string;
  let workerSocketPath: string;
  let server: import("node:net").Server;

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "fpai-worker-server-test-"));
    mkdirSync(join(projectDir, ".failproofai"), { recursive: true });
    writeFileSync(
      join(projectDir, ".failproofai", "policies-config.json"),
      JSON.stringify({ enabledPolicies: ["block-sudo"] }),
    );

    workerSocketPath = join(tmpdir(), `fpai-worker-server-test-${process.pid}-${Date.now()}.sock`);
    const { startWorkerServer } = await import("../../src/hooks/worker-server");
    server = startWorkerServer(workerSocketPath);
    await new Promise<void>((resolvePromise) => {
      if (server.listening) resolvePromise();
      else server.once("listening", () => resolvePromise());
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.FAILPROOFAI_CLOUD_POLICY_DIR;
    delete (globalThis as Record<string, unknown>).__fpaiRepeatLoadCount;
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("denies a sudo command via the real, unmodified builtin policy engine", async () => {
    const response = await sendRequest(workerSocketPath, {
      type: "hook",
      hookEvent: "PreToolUse",
      cli: "claude",
      stdin: JSON.stringify({
        cwd: projectDir,
        tool_name: "Bash",
        tool_input: { command: "sudo rm -rf /" },
      }),
    });
    expect(response.type).toBe("hookResult");
    expect(response.exitCode).toBe(0);
    expect(permissionDecisionOf(response)).toBe("deny");
  });

  it("allows a benign command through the real policy engine", async () => {
    const response = await sendRequest(workerSocketPath, {
      type: "hook",
      hookEvent: "PreToolUse",
      cli: "claude",
      stdin: JSON.stringify({
        cwd: projectDir,
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      }),
    });
    expect(response.type).toBe("hookResult");
    expect(response.exitCode).toBe(0);
  });

  it("handles multiple requests on the same connection-per-request pattern sequentially and correctly", async () => {
    const results = await Promise.all([
      sendRequest(workerSocketPath, {
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command: "sudo ls" } }),
      }),
      sendRequest(workerSocketPath, {
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command: "echo hi" } }),
      }),
      sendRequest(workerSocketPath, {
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command: "sudo whoami" } }),
      }),
    ]);
    expect(permissionDecisionOf(results[0])).toBe("deny"); // sudo -> deny
    expect(permissionDecisionOf(results[1])).toBeUndefined(); // echo -> allow
    expect(permissionDecisionOf(results[2])).toBe("deny"); // sudo -> deny
  });

  it("re-executes an explicit custom policy on every warm-worker request", async () => {
    const policyPath = join(projectDir, "custom-policy.mjs");
    writeFileSync(
      policyPath,
      `import { customPolicies, allow, deny } from "failproofai";
globalThis.__fpaiRepeatLoadCount = (globalThis.__fpaiRepeatLoadCount ?? 0) + 1;
const moduleLoadCount = globalThis.__fpaiRepeatLoadCount;
customPolicies.add({
  name: "repeat-load",
  description: "must survive warm worker reloads",
  match: { events: ["PreToolUse"], tools: ["Bash"] },
  fn: async (ctx) => String(ctx.toolInput?.command ?? "").includes("blocked-custom")
    ? deny("custom policy blocked the command at module-load-" + moduleLoadCount)
    : allow(),
});\n`,
    );
    writeFileSync(
      join(projectDir, ".failproofai", "policies-config.json"),
      JSON.stringify({ enabledPolicies: [], customPoliciesPaths: [policyPath] }),
    );

    for (let requestNumber = 0; requestNumber < 3; requestNumber++) {
      const response = await sendRequest(workerSocketPath, {
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({
          cwd: projectDir,
          tool_name: "Bash",
          tool_input: { command: `echo blocked-custom-${requestNumber}` },
        }),
      });
      expect(permissionDecisionOf(response), `warm request ${requestNumber + 1}`).toBe("deny");
      expect(response.stdout).toContain("custom policy blocked the command at module-load-1");
    }
  });

  it("loads a hash-verified active cloud policy with a cloud-qualified identity", async () => {
    const managedRoot = join(projectDir, "cloud-managed");
    const generationDir = join(managedRoot, "generations", "42");
    mkdirSync(generationDir, { recursive: true });
    const policyPath = join(generationDir, "org-guard.mjs");
    const policyBytes = `import { customPolicies, deny } from "failproofai";
customPolicies.add({
  name: "org-guard",
  description: "cloud managed test guard",
  match: { events: ["PreToolUse"], tools: ["Bash"] },
  fn: async () => deny("cloud-managed policy blocked the command"),
});\n`;
    writeFileSync(policyPath, policyBytes);
    const sha256 = createHash("sha256").update(policyBytes).digest("hex");
    writeFileSync(
      join(managedRoot, "active.json"),
      JSON.stringify({
        schemaVersion: 1,
        generation: 42,
        policies: [
          {
            id: "org-guard",
            revision: 8,
            sha256,
            path: "generations/42/org-guard.mjs",
          },
        ],
      }),
    );
    process.env.FAILPROOFAI_CLOUD_POLICY_DIR = managedRoot;

    // A local disabledCustomPolicies entry with the generated cloud ID must
    // not override a centrally assigned policy.
    writeFileSync(
      join(projectDir, ".failproofai", "policies-config.json"),
      JSON.stringify({
        enabledPolicies: [],
        disabledCustomPolicies: ["cloud:org-guard@8:org-guard"],
      }),
    );

    for (let requestNumber = 0; requestNumber < 2; requestNumber++) {
      const response = await sendRequest(workerSocketPath, {
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({
          cwd: projectDir,
          tool_name: "Bash",
          tool_input: { command: `echo cloud-request-${requestNumber}` },
        }),
      });
      expect(permissionDecisionOf(response)).toBe("deny");
      expect(response.stdout).toContain("cloud-managed policy blocked the command");
    }
  });

  it("uses fallbackCwd when the stdin payload carries no cwd at all", async () => {
    // No cwd in the payload — the worker must inject the client-forwarded
    // cwd rather than resolving project config against its own process.cwd().
    const response = await sendRequest(workerSocketPath, {
      type: "hook",
      hookEvent: "PreToolUse",
      cli: "claude",
      cwd: projectDir,
      stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sudo ls" } }),
    });
    expect(response.type).toBe("hookResult");
    expect(permissionDecisionOf(response)).toBe("deny");
  });

  it("returns an error response for a malformed (non-JSON) frame body, without crashing the server", async () => {
    const response = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const socket = createConnection({ path: workerSocketPath }, () => {
        const body = Buffer.from("not json", "utf8");
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length, 0);
        socket.write(Buffer.concat([header, body]));
      });
      readFrame(socket)
        .then((msg) => {
          socket.end();
          resolvePromise(msg);
        })
        .catch(reject);
      socket.on("error", reject);
    });
    expect(response.type).toBe("error");

    // The server must still be alive and answer a subsequent valid request.
    const followUp = await sendRequest(workerSocketPath, {
      type: "hook",
      hookEvent: "PreToolUse",
      cli: "claude",
      stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command: "echo still-alive" } }),
    });
    expect(followUp.type).toBe("hookResult");
    expect(followUp.exitCode).toBe(0);
  });

  it("returns an error response for an unrecognized request shape", async () => {
    const response = await sendRequest(workerSocketPath, { type: "ping" });
    expect(response.type).toBe("error");
  });

  it("speaks ONLY the hook protocol — the audit must never be routed onto this chain", async () => {
    // A tripwire, not a feature test. Every request here is serialized through
    // ONE promise chain (see the module header), `worker.rs` caps a call at 30
    // seconds, and `daemon-client.ts` turns that timeout into a DENY — so on a
    // daemon-configured machine, putting the ~104-second audit on this socket
    // would be a fail-closed denial of every tool call across all 12 CLIs for
    // as long as the scan ran. The daemon's audit lane therefore spawns a
    // SEPARATE short-lived process (crates/failproofaid/src/audit_lane.rs).
    //
    // If someone later "optimises" that into a worker request to save a process
    // spawn, this is what fails: adding an `audit` arm to isWorkerHookRequest
    // makes the assertion below stop holding.
    for (const request of [
      { type: "audit" },
      { type: "audit", scheduled: true },
      { type: "runAudit", hookEvent: "PreToolUse", cli: "claude", stdin: "{}" },
    ]) {
      const response = await sendRequest(workerSocketPath, request);
      expect(response.type).toBe("error");
      expect(response.message).toBe("unrecognized request shape");
    }

    // And the one thing it does speak still works, so this is a rejection of
    // the request type rather than a wedged server.
    const hook = await sendRequest(workerSocketPath, {
      type: "hook",
      hookEvent: "PreToolUse",
      cli: "claude",
      stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command: "echo ok" } }),
    });
    expect(hook.type).toBe("hookResult");
  });

  it("answers both requests when two frames arrive coalesced in one read", async () => {
    // Two requests written back-to-back on one connection routinely land in
    // a single `data` event. Decoding only the first leaves the second
    // stranded in the receive buffer until some *later* write happens to
    // arrive — meanwhile the caller sees no response and hits its own
    // fail-closed timeout against a daemon that is working fine.
    const frame = (command: string) =>
      encodeFrame({
        type: "hook",
        hookEvent: "PreToolUse",
        cli: "claude",
        stdin: JSON.stringify({ cwd: projectDir, tool_name: "Bash", tool_input: { command } }),
      });

    const responses = await new Promise<Record<string, unknown>[]>((resolvePromise, reject) => {
      const socket = createConnection({ path: workerSocketPath }, () => {
        // One write, both frames — the coalesced case, deterministically.
        socket.write(Buffer.concat([frame("sudo rm -rf /"), frame("echo hi")]));
      });
      const collected: Record<string, unknown>[] = [];
      let buf = Buffer.alloc(0);
      let declaredLen: number | null = null;
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (declaredLen === null) {
            if (buf.length < 4) return;
            declaredLen = buf.readUInt32BE(0);
            buf = buf.subarray(4);
          }
          if (buf.length < declaredLen) return;
          collected.push(JSON.parse(buf.subarray(0, declaredLen).toString("utf8")));
          buf = buf.subarray(declaredLen);
          declaredLen = null;
          if (collected.length === 2) {
            socket.end();
            resolvePromise(collected);
            return;
          }
        }
      });
      socket.on("error", reject);
    });

    expect(responses.map((r) => r.type)).toEqual(["hookResult", "hookResult"]);
    expect(permissionDecisionOf(responses[0])).toBe("deny"); // sudo
    expect(permissionDecisionOf(responses[1])).toBeUndefined(); // echo
  });
});
