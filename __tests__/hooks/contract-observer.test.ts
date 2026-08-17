// @vitest-environment node
/**
 * The contract observer records what the agent CLIs really send. It runs inside
 * the warm worker's serialized chain, on a machine where every way of not
 * getting an answer is a DENY — so most of what is asserted here is about what
 * it must NOT do: not throw, not block, not record a field value, not grow
 * without bound, and not go quiet on a machine whose worker is SIGKILLed more
 * often than the write floor.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  recordHookShape,
  flushContractTable,
  contractTableSnapshot,
  resetContractObserverForTests,
  type ContractTable,
} from "../../src/hooks/contract-observer";
import { contractTableFile } from "../../src/hooks/fp-home";

let homeDir: string;

function readTable(): ContractTable {
  return JSON.parse(readFileSync(contractTableFile(), "utf8")) as ContractTable;
}

function record(cli: string, hook: string, payload: unknown): void {
  recordHookShape(cli, hook, JSON.stringify(payload));
}

/** Simulate the worker being SIGKILLed and respawned: memory gone, disk kept. */
function restartWorker(): void {
  resetContractObserverForTests();
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "fpai-contract-observer-"));
  process.env.FAILPROOFAI_HOME = homeDir;
  // Write as soon as anything is learned, so assertions do not wait.
  process.env.FAILPROOFAI_OBSERVE_INTERVAL_MS = "0";
  // Never fork a real vendor CLI from a unit test.
  process.env.FAILPROOFAI_OBSERVE_VERSIONS = "0";
  resetContractObserverForTests();
});

afterEach(() => {
  delete process.env.FAILPROOFAI_HOME;
  delete process.env.FAILPROOFAI_OBSERVE_INTERVAL_MS;
  delete process.env.FAILPROOFAI_OBSERVE_VERSIONS;
  delete process.env.FAILPROOFAI_OBSERVE_FAULT;
  resetContractObserverForTests();
  rmSync(homeDir, { recursive: true, force: true });
});

describe("contract-observer: what it records", () => {
  it("records the envelope and the tool input keys, per CLI and per hook", () => {
    record("copilot", "PreToolUse", {
      cwd: "/repo",
      session_id: "s1",
      tool_name: "Read",
      tool_input: { path: "/etc/passwd" },
    });

    const hook = readTable().clis.copilot.hooks.PreToolUse;
    expect(hook.envelope).toEqual(["cwd", "session_id", "tool_input", "tool_name"]);
    expect(hook.tools?.Read).toEqual(["path"]);
  });

  it("keeps hooks separate, including a non-tool event with no tools at all", () => {
    record("copilot", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    record("copilot", "Stop", { session_id: "s1", stop_hook_active: false });

    const hooks = readTable().clis.copilot.hooks;
    expect(hooks.PreToolUse.tools?.Bash).toEqual(["command"]);
    expect(hooks.Stop.envelope).toEqual(["session_id", "stop_hook_active"]);
    expect(hooks.Stop.tools).toBeUndefined();
  });

  it("reads Antigravity's nested toolCall envelope", () => {
    record("antigravity", "PreToolUse", {
      conversationId: "c1",
      toolCall: { name: "run_command", args: { CommandLine: "ls", Cwd: "/repo" } },
    });

    expect(readTable().clis.antigravity.hooks.PreToolUse.tools?.run_command).toEqual([
      "CommandLine",
      "Cwd",
    ]);
  });

  it("reads Copilot's camelCase permissionRequest envelope", () => {
    record("copilot", "permissionRequest", {
      hookName: "permissionRequest",
      toolName: "bash",
      toolInput: { command: "sudo id" },
    });

    const hook = readTable().clis.copilot.hooks.permissionRequest;
    expect(hook.envelope).toEqual(["hookName", "toolInput", "toolName"]);
    expect(hook.tools?.bash).toEqual(["command"]);
  });

  it("unions optional keys instead of overwriting, so the shape does not flicker", () => {
    // `description` is optional on Bash. Overwriting with the latest payload
    // would make the recorded shape depend on whichever call landed last, and
    // every alternation would read as drift.
    record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls", description: "d" } });
    record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "pwd" } });

    expect(readTable().clis.claude.hooks.PreToolUse.tools?.Bash).toEqual(["command", "description"]);
  });

  it("surfaces a renamed key as a NEW entry alongside the old one", () => {
    record("copilot", "PreToolUse", { tool_name: "Read", tool_input: { path: "/a" } });
    record("copilot", "PreToolUse", { tool_name: "Read", tool_input: { filepath: "/a" } });

    // This is the whole point of the file: the vendor's rename is legible.
    expect(readTable().clis.copilot.hooks.PreToolUse.tools?.Read).toEqual(["filepath", "path"]);
  });
});

describe("contract-observer: values", () => {
  it("keeps no FIELD value from any position in the payload", () => {
    const SENTINEL = "zzsecretsentinelzz";
    record("claude", "PreToolUse", {
      cwd: SENTINEL,
      session_id: SENTINEL,
      tool_name: "Bash",
      tool_input: { command: `echo ${SENTINEL}`, nested: { deep: SENTINEL } },
      transcript_path: SENTINEL,
    });

    expect(readFileSync(contractTableFile(), "utf8")).not.toContain(SENTINEL);
  });

  it("records a nested object's key but never descends into it", () => {
    record("claude", "PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls", opts: { secretKeyName: 1 } },
    });

    const raw = readFileSync(contractTableFile(), "utf8");
    expect(raw).toContain("opts");
    expect(raw).not.toContain("secretKeyName");
  });

  it("DOES record the vendor's tool name, which is a value — deliberately, and capped", () => {
    // The module's header says so out loud rather than claiming a guarantee it
    // does not have. A rename like `Execute` -> `Run` is drift we need to see,
    // so the tool name is kept; MCP tool names can carry an org's vocabulary,
    // which is the one thing a reader should weigh before pasting the file.
    record("claude", "PreToolUse", { tool_name: "mcp__acme__deploy", tool_input: { a: 1 } });
    expect(readFileSync(contractTableFile(), "utf8")).toContain("mcp__acme__deploy");
  });

  it("refuses an over-long tool name rather than storing it whole", () => {
    record("claude", "PreToolUse", { tool_name: "x".repeat(500), tool_input: { a: 1 } });
    expect(readTable().clis.claude.hooks.PreToolUse.tools).toBeUndefined();
    expect(readFileSync(contractTableFile(), "utf8").length).toBeLessThan(1000);
  });

  it("refuses an over-long key name", () => {
    record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { ["k".repeat(500)]: 1, ok: 2 } });
    expect(readTable().clis.claude.hooks.PreToolUse.tools?.Bash).toEqual(["ok"]);
  });
});

describe("contract-observer: persistence across a SIGKILLed worker", () => {
  it("merges into what is already on disk rather than replacing it", () => {
    record("goose", "PreToolUse", { tool_name: "shell", tool_input: { command: "ls" } });
    restartWorker();
    record("goose", "SessionStart", { session_id: "s2", working_dir: "/repo" });

    const hooks = readTable().clis.goose.hooks;
    expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "SessionStart"]);
    expect(hooks.PreToolUse.tools?.shell).toEqual(["command"]);
  });

  it("keeps writing after the first write, on a worker that restarts often", () => {
    // THE bug a daily write cadence has on this machine. The worker is
    // SIGKILLed, so there is no shutdown flush; if the write clock were a
    // fixed period since the file's own timestamp, every generation after the
    // first would load a file too recent to trigger a write, accumulate, and
    // die — discarding everything, forever, while looking healthy.
    process.env.FAILPROOFAI_OBSERVE_INTERVAL_MS = "0";
    record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(readTable().clis.claude.hooks.PreToolUse.tools?.Bash).toBeDefined();

    for (let generation = 0; generation < 5; generation++) {
      restartWorker();
      record("claude", "PreToolUse", { tool_name: `Tool${generation}`, tool_input: { a: 1 } });
      expect(readTable().clis.claude.hooks.PreToolUse.tools?.[`Tool${generation}`]).toEqual(["a"]);
    }
  });

  it("writes nothing at all when nothing new is observed", () => {
    record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    const firstWrite = readTable().updatedAt;

    // Same shape a thousand times over: nothing was learned, so nothing is written.
    for (let i = 0; i < 50; i++) {
      record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "pwd" } });
    }
    expect(readTable().updatedAt).toBe(firstWrite);
  });

  it("holds a change back until the write floor has elapsed", () => {
    record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    const firstWrite = readTable().updatedAt;

    process.env.FAILPROOFAI_OBSERVE_INTERVAL_MS = String(60 * 60 * 1000);
    record("claude", "PreToolUse", { tool_name: "Grep", tool_input: { pattern: "x" } });

    expect(readTable().updatedAt).toBe(firstWrite);
    expect(readTable().clis.claude.hooks.PreToolUse.tools?.Grep).toBeUndefined();
    // Held in memory, not lost.
    expect(contractTableSnapshot().clis.claude.hooks.PreToolUse.tools?.Grep).toEqual(["pattern"]);
  });

  it("is not disabled forever by a future-dated updatedAt", () => {
    // Clock skew or a hand edit would otherwise park the write clock in the
    // future and silently switch the writer off with no way back.
    record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    const table = readTable();
    table.updatedAt = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(contractTableFile(), JSON.stringify(table));

    restartWorker();
    record("claude", "PreToolUse", { tool_name: "Grep", tool_input: { pattern: "x" } });
    expect(readTable().clis.claude.hooks.PreToolUse.tools?.Grep).toEqual(["pattern"]);
  });

  it("starts clean from a corrupt table instead of throwing", () => {
    mkdirSync(dirname(contractTableFile()), { recursive: true });
    writeFileSync(contractTableFile(), "{ not json at all");

    expect(() => record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } })).not.toThrow();
    expect(readTable().clis.claude.hooks.PreToolUse.tools?.Bash).toEqual(["command"]);
  });

  it("starts clean when the table is valid JSON of the wrong shape", () => {
    mkdirSync(dirname(contractTableFile()), { recursive: true });
    writeFileSync(contractTableFile(), JSON.stringify({ schemaVersion: 99, clis: "nope" }));

    expect(() => record("claude", "Stop", { session_id: "s" })).not.toThrow();
    expect(readTable().schemaVersion).toBe(1);
  });

  it("enforces the caps on the READ path, not only on the write path", () => {
    // A hand-edited or hostile file is otherwise an unbounded input that we
    // then parse synchronously on the hook path.
    const clis: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) clis[`cli-${i}`] = { hooks: { Stop: { envelope: ["a"] } } };
    mkdirSync(dirname(contractTableFile()), { recursive: true });
    writeFileSync(contractTableFile(), JSON.stringify({ schemaVersion: 1, updatedAt: null, clis }));

    restartWorker();
    record("claude", "Stop", { session_id: "s" });
    expect(Object.keys(contractTableSnapshot().clis).length).toBeLessThanOrEqual(32);
  });
});

describe("contract-observer: hostile and malformed input", () => {
  it("does not block when the table path is a FIFO the agent created", () => {
    // The file lives under the same uid as the agent this product supervises.
    // A blocking read here would wedge the serialized chain, deny every tool
    // call on the machine across all twelve CLIs, and survive restarts — and a
    // blocked event loop cannot run the wedge watchdog meant to catch it.
    mkdirSync(dirname(contractTableFile()), { recursive: true });
    try {
      execFileSync("mkfifo", [contractTableFile()]);
    } catch {
      return; // no mkfifo on this platform; nothing to assert
    }

    const started = Date.now();
    expect(() => record("claude", "Stop", { session_id: "s" })).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not throw on prototype-chain names, which the model controls", () => {
    // `__proto__` and `constructor` are legal MCP tool-name characters, and a
    // plain-object lookup returns an inherited member instead of undefined.
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(() => record("claude", "PreToolUse", { tool_name: name, tool_input: { a: 1 } })).not.toThrow();
      expect(() => record(name, "PreToolUse", { tool_name: "Bash", tool_input: { a: 1 } })).not.toThrow();
      expect(() => record("claude", name, { session_id: "s" })).not.toThrow();
    }
    // And the observation still lands.
    expect(readTable().clis.claude.hooks.PreToolUse.tools?.__proto__).toEqual(["a"]);
  });

  it("never throws on input it cannot use", () => {
    expect(() => recordHookShape("claude", "PreToolUse", "not json")).not.toThrow();
    expect(() => recordHookShape("claude", "PreToolUse", "")).not.toThrow();
    expect(() => recordHookShape("claude", "PreToolUse", "[1,2,3]")).not.toThrow();
    expect(() => recordHookShape("claude", "PreToolUse", "null")).not.toThrow();
    expect(() => recordHookShape("", "PreToolUse", "{}")).not.toThrow();
    expect(() => recordHookShape("claude", "", "{}")).not.toThrow();
    expect(existsSync(contractTableFile())).toBe(false);
  });

  it("skips an oversize payload rather than parsing it twice", () => {
    record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "x".repeat(300 * 1024) } });
    expect(existsSync(contractTableFile())).toBe(false);
  });
});

describe("contract-observer: bounds", () => {
  it("caps tool names, which arrive from user-authored MCP servers", () => {
    for (let i = 0; i < 260; i++) {
      record("claude", "PreToolUse", { tool_name: `mcp__server__tool_${i}`, tool_input: { a: 1 } });
    }
    expect(Object.keys(readTable().clis.claude.hooks.PreToolUse.tools ?? {}).length).toBe(200);
    expect(readTable().truncated).toBe(true);
  });

  it("caps keys within a single shape", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i++) wide[`k${i}`] = 1;
    record("claude", "PreToolUse", { tool_name: "Wide", tool_input: wide });
    expect(readTable().clis.claude.hooks.PreToolUse.tools?.Wide.length).toBe(64);
  });

  it("caps the number of CLIs", () => {
    for (let i = 0; i < 40; i++) record(`cli-${i}`, "Stop", { session_id: "s" });
    expect(Object.keys(readTable().clis).length).toBe(32);
  });

  it("keeps the whole table small no matter how much it is fed", () => {
    // Counts alone do not bound bytes: caps that only count entries still
    // multiply out (32 x 64 x 200 x 64 names) to a table too large to
    // serialize. Hold the writes off so this measures the byte ceiling rather
    // than the cost of writing on every discovery.
    process.env.FAILPROOFAI_OBSERVE_INTERVAL_MS = String(60 * 60 * 1000);
    for (let cli = 0; cli < 40; cli++) {
      for (let hook = 0; hook < 70; hook++) {
        for (let tool = 0; tool < 20; tool++) {
          record(`cli-${cli}`, `hook-${hook}`, {
            tool_name: `tool-${tool}`,
            tool_input: { ["k".repeat(100)]: 1, b: 2 },
          });
        }
      }
    }
    flushContractTable();
    expect(statSync(contractTableFile()).size).toBeLessThan(1024 * 1024);
    expect(readTable().truncated).toBe(true);
  }, 20_000);

  it("writes the table owner-only", () => {
    record("claude", "Stop", { session_id: "s" });
    expect(statSync(contractTableFile()).mode & 0o077).toBe(0);
  });

  it("keeps recording when the table cannot be written", () => {
    // A read-only or full disk must not turn into a throw on the hook path.
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(dirname(contractTableFile()), "not a directory");
    resetContractObserverForTests();

    expect(() => record("claude", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } })).not.toThrow();
    expect(contractTableSnapshot().clis.claude.hooks.PreToolUse.tools?.Bash).toEqual(["command"]);
  });

  it("flushContractTable is a no-op before anything has been observed", () => {
    expect(() => flushContractTable()).not.toThrow();
    expect(existsSync(contractTableFile())).toBe(false);
  });
});

describe("contract-observer: the version probe, end to end", () => {
  let binDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "fpai-observer-bin-"));
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    process.env.FAILPROOFAI_OBSERVE_VERSIONS = "1";
    writeFileSync(join(binDir, "goose"), '#!/bin/sh\necho "7.7.7"\n', { mode: 0o755 });
    chmodSync(join(binDir, "goose"), 0o755);
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  it("persists the version at the moment it is learned, not on the next hook", async () => {
    // The worker is SIGKILLed, so "on the next event" is frequently "never" —
    // a probe that costs a fork and then persists nothing is the worst of both.
    record("goose", "PreToolUse", { tool_name: "shell", tool_input: { command: "ls" } });
    await new Promise((r) => setTimeout(r, 1500));

    expect(readTable().clis.goose.version).toBe("7.7.7");
    expect(readTable().clis.goose.versionCheckedAt).toBeTruthy();
  }, 15_000);

  it("does not re-probe while one is already in flight for that CLI", async () => {
    for (let i = 0; i < 20; i++) {
      record("goose", "PreToolUse", { tool_name: `t${i}`, tool_input: { a: 1 } });
    }
    await new Promise((r) => setTimeout(r, 1500));
    expect(readTable().clis.goose.version).toBe("7.7.7");
  }, 15_000);

  it("survives the write failing inside the probe callback", async () => {
    // This is the one genuinely asynchronous path in the module: the callback
    // runs on the event loop, where an escaping throw is an uncaught exception
    // and kills the worker.
    record("goose", "PreToolUse", { tool_name: "shell", tool_input: { command: "ls" } });
    rmSync(dirname(contractTableFile()), { recursive: true, force: true });
    writeFileSync(dirname(contractTableFile()), "not a directory");

    await new Promise((r) => setTimeout(r, 1500));
    // Still recorded in memory; the process is still alive to assert it.
    expect(contractTableSnapshot().clis.goose.version).toBe("7.7.7");
  }, 15_000);
});
