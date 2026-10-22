// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createConnection, type Server, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as handler from "../../src/hooks/handler";
import * as evaluator from "../../src/hooks/policy-evaluator";
import * as loader from "../../src/hooks/custom-hooks-loader";
import * as cloudPolicies from "../../src/hooks/cloud-managed-policies";
import * as logger from "../../src/hooks/hook-logger";
import { getAllHookActivityEntries, _resetForTest } from "../../src/hooks/hook-activity-store";
import { trackHookEvent } from "../../src/hooks/hook-telemetry";
import { startWorkerServer } from "../../src/hooks/worker-server";

const runtime = vi.hoisted(() => ({ version: "test-version-a" }));
vi.mock("../../package.json", async (importOriginal) => ({
  ...await importOriginal<object>(),
  get version() { return runtime.version; },
}));
// Keep evaluation and activity/stat persistence real; replace network telemetry.
vi.mock("../../src/hooks/hook-telemetry", () => ({
  trackHookEvent: vi.fn(() => Promise.resolve()),
  flushHookTelemetry: vi.fn(() => Promise.resolve()),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

type Reply = Record<string, unknown>;

function readFrame(socket: Socket): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString()));
    });
    socket.on("error", reject);
  });
}

describe("worker invocation dedup (real socket, evaluator and activity store)", () => {
  let dir: string;
  let project: string;
  let socketPath: string;
  let server: Server;
  const sockets: Socket[] = [];
  let evaluate: MockInstance<typeof evaluator.evaluatePolicies>;
  const realEvaluate = evaluator.evaluatePolicies;
  const realHandler = handler.evaluateHookEvent;
  let releaseRegistry: (() => void) | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fpai-worker-dedup-"));
    project = join(dir, "project");
    mkdirSync(join(project, ".failproofai"), { recursive: true });
    vi.stubEnv("FAILPROOFAI_HOME", join(dir, "home"));
    vi.stubEnv("FAILPROOFAI_LOG_LEVEL", "error");
    vi.stubEnv("FAILPROOFAI_PACKAGE_ROOT", "package-a");
    runtime.version = "test-version-a";
    _resetForTest(join(dir, "activity"));
    writeFileSync(join(project, ".failproofai", "policies-config.json"), JSON.stringify({ enabledPolicies: ["block-sudo"] }));
    evaluate = vi.spyOn(evaluator, "evaluatePolicies");
    vi.spyOn(handler, "evaluateHookEvent").mockImplementation((event, cli, stdin, opts) => {
      releaseRegistry = opts?.releaseRegistry;
      return realHandler(event, cli, stdin, opts);
    });
    vi.mocked(trackHookEvent).mockClear();
    socketPath = join(dir, "worker.sock");
    server = startWorkerServer(socketPath);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (server.listening) resolve();
      else server.once("listening", resolve);
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of sockets.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    _resetForTest();
    // Retain isolated artifacts for inspection; no writes reach the real home.
  });

  function request(payload: Record<string, unknown> = {}, hookEvent = "PreToolUse", cli = "claude") {
    return {
      type: "hook", hookEvent, cli, cwd: project,
      stdin: JSON.stringify({
        session_id: "dedup-session", tool_use_id: "tool-a", cwd: project,
        tool_name: "Bash", tool_input: { command: "sudo whoami" }, ...payload,
      }),
    };
  }

  function send(req = request()): Promise<Reply> {
    const socket = createConnection({ path: socketPath }, () => socket.write(encodeFrame(req)));
    sockets.push(socket);
    return readFrame(socket).then((reply) => { socket.end(); return reply; });
  }

  function holdOwner(fail = false) {
    const started = deferred();
    const finish = deferred();
    evaluate.mockImplementationOnce(async (...args) => {
      const result = await realEvaluate(...args);
      // Model the two-tier boundary: registry reads have finished.
      releaseRegistry?.();
      started.resolve();
      await finish.promise;
      if (fail) throw new Error("owner evaluation failed");
      return result;
    });
    return { started: started.promise, finish: finish.resolve };
  }

  function observeNextLoad() {
    const loaded = deferred();
    const realLoad = loader.loadAllCustomHooks;
    vi.spyOn(loader, "loadAllCustomHooks").mockImplementationOnce(async (...args) => {
      const result = await realLoad(...args);
      loaded.resolve();
      return result;
    });
    return loaded.promise;
  }

  it("evaluates and records concurrent scope duplicates once and replays the exact deny reply", async () => {
    const [owner, duplicate] = await Promise.all([send(), send()]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(owner.type).toBe("hookResult");
    expect(JSON.parse(owner.stdout as string).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(duplicate).toEqual(owner);
    expect(getAllHookActivityEntries()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "activity", "stats.json"), "utf8"))).toMatchObject({ totalEvents: 1, denyCount: 1 });
    expect(vi.mocked(trackHookEvent).mock.calls.filter((call) => call[1] === "hook_policy_triggered")).toHaveLength(1);
  });

  it("replays a completed allow reply", async () => {
    const req = request({ tool_input: { command: "echo allowed" } });
    const owner = await send(req);
    const duplicate = await send(req);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(owner).toMatchObject({ type: "hookResult", exitCode: 0, stdout: "", stderr: "", evaluation: { decision: "allow" } });
    expect(duplicate).toEqual(owner);
    expect(getAllHookActivityEntries()).toHaveLength(1);
  });

  it("emits a custom-policy load diagnostic once for duplicate scope invocations", async () => {
    const broken = join(project, "broken.mjs");
    writeFileSync(broken, "export const = ;");
    writeFileSync(join(project, ".failproofai", "policies-config.json"), JSON.stringify({
      enabledPolicies: ["block-sudo"], customPoliciesPaths: [broken],
    }));
    vi.spyOn(logger, "hookLogError").mockImplementation(() => {});
    const owner = await send();
    expect(await send()).toEqual(owner);
    expect(vi.mocked(trackHookEvent).mock.calls.filter((call) => call[1] === "custom_hooks_load_error")).toHaveLength(1);
    expect(vi.mocked(trackHookEvent).mock.calls.filter((call) => call[1] === "hook_policy_triggered")).toHaveLength(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("emits a cloud-policy load diagnostic once for duplicate scope invocations", async () => {
    vi.spyOn(cloudPolicies, "readActiveCloudManagedPolicies").mockImplementation(() => {
      throw new Error("invalid cloud policy manifest");
    });
    const owner = await send();
    expect(await send()).toEqual(owner);
    expect(vi.mocked(trackHookEvent).mock.calls.filter((call) => call[1] === "cloud_managed_load_error")).toHaveLength(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("replays exit code and stderr exactly for an exit-2 deny", async () => {
    const req = request({}, "PreToolUse", "factory");
    const owner = await send(req);
    const duplicate = await send(req);
    expect(owner).toMatchObject({ exitCode: 2, stdout: "" });
    expect(owner.stderr).toBeTruthy();
    expect(duplicate).toEqual(owner);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("shares a pending owner's reply after the owner releases the registry", async () => {
    const gate = holdOwner();
    const owner = send();
    await gate.started;
    const loaded = observeNextLoad();
    const duplicate = send();
    await loaded;
    gate.finish();
    const [a, b] = await Promise.all([owner, duplicate]);
    expect(b).toEqual(a);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("releases failed-owner waiters to normal evaluation and does not cache the error", async () => {
    const gate = holdOwner(true);
    const owner = send();
    await gate.started;
    const loaded = observeNextLoad();
    const duplicate = send();
    await loaded;
    gate.finish();
    expect(await owner).toMatchObject({ type: "error", message: "owner evaluation failed" });
    const retry = await duplicate;
    expect(retry).toMatchObject({ type: "hookResult", evaluation: { decision: "deny" } });
    expect(await send()).toEqual(retry);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(getAllHookActivityEntries()).toHaveLength(1);
  });

  it.each([
    ["tool invocation", { tool_use_id: "tool-b" }, "PreToolUse", "claude"],
    ["session", { session_id: "other-session" }, "PreToolUse", "claude"],
    ["event", {}, "PostToolUse", "claude"],
    ["CLI", {}, "PreToolUse", "factory"],
  ])("evaluates again when only the %s identity differs", async (_name, payload, event, cli) => {
    const original = request();
    const owner = await send(original);
    expect(await send(original)).toEqual(owner);
    expect(evaluate).toHaveBeenCalledTimes(1);
    await send(request(payload, event, cli));
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(getAllHookActivityEntries()).toHaveLength(2);
  });

  it.each(["package root", "package version", "merged config", "custom hooks", "cwd", "fallback cwd"])(
    "evaluates again when only runtime %s differs", async (component) => {
      const req = request(component === "fallback cwd" ? { cwd: undefined } : {});
      const owner = await send(req);
      expect(await send(req)).toEqual(owner);
      expect(evaluate).toHaveBeenCalledTimes(1);
      if (component === "package root") vi.stubEnv("FAILPROOFAI_PACKAGE_ROOT", "package-b");
      if (component === "package version") runtime.version = "test-version-b";
      if (component === "merged config") {
        writeFileSync(join(project, ".failproofai", "policies-config.local.json"), JSON.stringify({ policyParams: { "block-sudo": { hint: "changed local hint" } } }));
      }
      if (component === "custom hooks") {
        vi.spyOn(loader, "loadAllCustomHooks").mockResolvedValue({
          hooks: [{ name: "runtime-hook", match: {}, fn: async () => ({ decision: "allow" }) }],
          conventionSources: [],
          packFailures: new Map(),
          packAliases: new Map(),
        });
      }
      let changed = req;
      if (component === "cwd" || component === "fallback cwd") {
        const nested = join(project, "nested");
        mkdirSync(nested);
        changed = { ...req, cwd: nested };
        if (component === "cwd") changed.stdin = JSON.stringify({ ...JSON.parse(req.stdin), cwd: nested });
      }
      await send(changed);
      expect(evaluate).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["missing session", { session_id: undefined }],
    ["missing invocation", { tool_use_id: undefined }],
    ["empty session", { session_id: "" }],
    ["empty invocation", { tool_use_id: "" }],
    ["non-string invocation", { tool_use_id: 42 }],
  ])("never suppresses or waits for %s", async (_name, payload) => {
    const gate = holdOwner();
    const owner = send(request(payload));
    await gate.started;
    try {
      const independent = await send(request(payload));
      expect(independent.type).toBe("hookResult");
      expect(evaluate).toHaveBeenCalledTimes(2);
    } finally {
      gate.finish();
      await owner;
    }
  });

  it("expires completed entries so the same invocation evaluates again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const owner = await send();
    expect(await send()).toEqual(owner);
    expect(evaluate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await send();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(getAllHookActivityEntries()).toHaveLength(2);
  });

  it("bounds a pending duplicate's wait and evaluates normally when its owner never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = holdOwner();
    const owner = send();
    await gate.started;
    const loaded = observeNextLoad();
    const duplicate = send();
    await loaded;
    await vi.advanceTimersByTimeAsync(30_001);
    try {
      expect(await duplicate).toMatchObject({ type: "hookResult", evaluation: { decision: "deny" } });
      expect(evaluate).toHaveBeenCalledTimes(2);
    } finally {
      gate.finish();
      await owner;
    }
  });

  it("uses the normal deny path when runtime identity computation throws", async () => {
    const fn = async () => ({ decision: "allow" as const });
    fn.toString = () => { throw new Error("cannot fingerprint hook"); };
    vi.spyOn(loader, "loadAllCustomHooks").mockResolvedValue({
      hooks: [{ name: "opaque", fn }], conventionSources: [],
      packFailures: new Map(), packAliases: new Map(),
    });
    const first = await send();
    const second = await send();
    expect(first).toMatchObject({ type: "hookResult", evaluation: { decision: "deny" } });
    expect(second).toMatchObject({ type: "hookResult", evaluation: { decision: "deny" } });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("preserves errors on the normal path and recovers for subsequent requests", async () => {
    evaluate.mockRejectedValueOnce(new Error("evaluation failed"));
    expect(await send()).toMatchObject({ type: "error", message: "evaluation failed" });
    expect(await send()).toMatchObject({ type: "hookResult", evaluation: { decision: "deny" } });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
