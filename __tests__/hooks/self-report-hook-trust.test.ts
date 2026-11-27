// @vitest-environment node
//
// Self Reports for Claude Code and Codex, whose hook is the recorder: when that
// hook will not run (an untrusted Codex, Claude Code with hooks off) the stdio
// server records the report instead, and never a second time when it did.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getIntegration } from "../../src/hooks/integrations";
import { failproofaiCodexHookIdentities } from "../../src/hooks/codex-system-hooks";
import {
  claudeHooksBlockedReason,
  codexReportHookRuns,
  selfReportHookRecordedRecently,
  selfReportHookState,
} from "../../src/hooks/self-report-hook-trust";
import {
  handleSelfReportRpc,
  selfReportClaudeTranscriptSession,
  selfReportCodexRolloutSession,
} from "../../src/hooks/self-report-mcp";
import { selfReportCliDirs, resolveSelfReportCliPath, syncSelfReportMcp } from "../../src/hooks/self-report-install";
import { writeEffectiveSelfReport } from "../../src/hooks/self-report";
import { runSelfReportCommand } from "../../src/hooks/self-report-cli";

const BIN = "/usr/local/bin/failproofai";
const CURRENT = () => "0.172.0";
let home: string;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "fp-sr-trust-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("CODEX_HOME", join(home, ".codex"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("FAILPROOFAI_HOME", join(home, ".failproofai"));
  vi.stubEnv("FAILPROOFAI_CLAUDE_MANAGED_SETTINGS", join(home, "managed-settings.json"));
  mkdirSync(join(home, ".codex"), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function writeCodexHooks(file = join(home, ".codex", "hooks.json")): void {
  const settings: Record<string, unknown> = {};
  getIntegration("codex").writeHookEntries(settings, BIN, "user");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));
}

function trust(file: string, only?: (key: string) => boolean): void {
  const lines = failproofaiCodexHookIdentities(file)
    .filter((h) => !only || only(h.key))
    .flatMap((h) => [`[hooks.state.${JSON.stringify(h.key)}]`, `trusted_hash = ${JSON.stringify(h.hash)}`, ""]);
  writeFileSync(join(home, ".codex", "config.toml"), `model = "o3"\n${lines.join("\n")}\n`);
}

const noSystem = { codexSystemPresent: () => false, codexVersion: CURRENT };

describe("will Codex run failproofai's PreToolUse hook?", () => {
  it("no hooks.json of ours: no", () => {
    expect(codexReportHookRuns(undefined, noSystem)).toBe(false);
  });

  it("hooks.json, untrusted (the laptop run): no; trusted at its current hash: yes", () => {
    writeCodexHooks();
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "o3"\n');
    expect(codexReportHookRuns(undefined, noSystem)).toBe(false);
    trust(join(home, ".codex", "hooks.json"));
    expect(codexReportHookRuns(undefined, noSystem)).toBe(true);
  });

  it("only the PreToolUse hook matters, since it is the one that records", () => {
    writeCodexHooks();
    trust(join(home, ".codex", "hooks.json"), (k) => !k.includes(":pre_tool_use:"));
    expect(codexReportHookRuns(undefined, noSystem)).toBe(false);
    trust(join(home, ".codex", "hooks.json"), (k) => k.includes(":pre_tool_use:"));
    expect(codexReportHookRuns(undefined, noSystem)).toBe(true);
  });

  it("a project's .codex/hooks.json above the working directory counts, trusted like the user's", () => {
    const project = join(home, "proj");
    writeCodexHooks(join(project, ".codex", "hooks.json"));
    trust(join(project, ".codex", "hooks.json"));
    expect(codexReportHookRuns(undefined, noSystem)).toBe(false);
    mkdirSync(join(project, "src"), { recursive: true });
    expect(codexReportHookRuns(join(project, "src"), noSystem)).toBe(true);
  });

  it("system hooks (run without trust) and a Codex older than the trust gate: yes", () => {
    expect(codexReportHookRuns(undefined, { codexSystemPresent: () => true })).toBe(true);
    writeCodexHooks();
    expect(codexReportHookRuns(undefined, { codexSystemPresent: () => false, codexVersion: () => "0.120.0" })).toBe(true);
  });
});

describe("will Claude Code run failproofai's hooks?", () => {
  it("disableAllHooks, with Claude Code's precedence, and a managed allowManagedHooksOnly", () => {
    const project = join(home, "proj");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(claudeHooksBlockedReason(project)).toBeNull();
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
    expect(claudeHooksBlockedReason(project)).toMatch(/disableAllHooks/);
    // A closer layer that sets it false wins.
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: false }));
    expect(claudeHooksBlockedReason(project)).toBeNull();
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
    expect(claudeHooksBlockedReason(project)).toMatch(/settings\.local\.json/);
    rmSync(join(project, ".claude", "settings.local.json"));
    writeFileSync(join(home, "managed-settings.json"), JSON.stringify({ allowManagedHooksOnly: true }));
    expect(claudeHooksBlockedReason(project)).toMatch(/allowManagedHooksOnly/);
  });
});

describe("selfReportHookState (status, sync)", () => {
  it("names the recorder and, for an untrusted Codex, how to trust the hooks", () => {
    writeCodexHooks();
    writeFileSync(join(home, ".codex", "config.toml"), "");
    const untrusted = selfReportHookState("codex", { ...noSystem, userHooksInstalled: () => true });
    expect(untrusted).toMatchObject({ recorder: "server", reason: expect.stringMatching(/not trusted/) });
    expect(untrusted.recorder === "server" && untrusted.fix).toMatch(/failproofai config.*sudo.*codex.*approve/);
    trust(join(home, ".codex", "hooks.json"));
    expect(selfReportHookState("codex", { ...noSystem, userHooksInstalled: () => true })).toEqual({ recorder: "hook" });
    expect(selfReportHookState("claude", { userHooksInstalled: () => true })).toEqual({ recorder: "hook" });
    expect(selfReportHookState("claude", { userHooksInstalled: () => false })).toMatchObject({ recorder: "server" });
    expect(selfReportHookState("pi")).toEqual({ recorder: "hook" });
  });

  it("sync puts an agent whose hook will not record on stdio even with a live daemon", async () => {
    const r = await syncSelfReportMcp({
      quiet: true, binaryPath: BIN, agents: ["claude", "codex"],
      deps: {
        daemonLive: async () => true, hooksInstalled: () => true, settings: { enabled: true, port: 4319 },
        hookRecords: (a) => a === "claude",
      },
    });
    expect(r.map((x) => [x.agent, x.transport])).toEqual([["claude", "http"], ["codex", "stdio"]]);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain('args = ["mcp", "--agent", "codex"]');
  });

  it("status shows who records, repairs an untrusted Codex left on HTTP, and says how to trust the hooks", async () => {
    writeEffectiveSelfReport({ enabled: true });
    let synced = 0;
    const row = (transport: "http" | "stdio", endpoint: string) => ({
      agent: "codex" as const, path: "/x/config.toml", hooked: true, registered: true, transport, endpoint, conflict: false,
    });
    let rows = [row("http", "http://127.0.0.1:4319/mcp?agent=codex")];
    const r = await runSelfReportCommand(["status"], {
      probeEndpoint: async () => true,
      daemonLive: async () => true,
      registrations: () => rows,
      hookState: () => ({ recorder: "server", reason: "Codex has not trusted failproofai's hooks, so it does not run them", fix: "Trust them." }),
      sync: async () => {
        synced++;
        rows = [row("stdio", BIN)];
        return [{ agent: "codex", path: "/x/config.toml", action: "updated", transport: "stdio", status: "ok" }];
      },
    });
    expect(synced).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain("Repaired:");
    expect(text).toMatch(/codex +stdio/);
    expect(text).toContain("reports recorded by the MCP server: Codex has not trusted failproofai's hooks");
    expect(text).toContain("Trust them.");

    const ok = await runSelfReportCommand(["status"], {
      probeEndpoint: async () => true, daemonLive: async () => true,
      registrations: () => [row("http", "http://127.0.0.1:4319/mcp?agent=codex")],
      hookState: () => ({ recorder: "hook" }),
      sync: async () => (synced++, []),
    });
    expect(synced).toBe(1);
    expect(ok.lines.join("\n")).toContain("reports recorded by its hook");
  });
});

describe("the server records what the hook did not, once", () => {
  const call = (args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "report", arguments: args } });
  const events = () => {
    try {
      return readdirSync(join(home, ".failproofai", "custom-agents", "events")).map((f) =>
        JSON.parse(readFileSync(join(home, ".failproofai", "custom-agents", "events", f), "utf8")),
      );
    } catch {
      return [];
    }
  };
  const hookRow = (over: Record<string, unknown>) => {
    mkdirSync(join(home, ".failproofai", "hook-activity"), { recursive: true });
    writeFileSync(
      join(home, ".failproofai", "hook-activity", "current.jsonl"),
      JSON.stringify({ timestamp: Date.now() - 1000, eventType: "PreToolUse", integration: "codex", sessionId: "s", decision: "allow", ...over }) + "\n",
    );
  };

  it("a hook row with the same report suppresses it; a different one, an old one or another agent's does not", () => {
    const args = { category: "invalid_tool_or_credential", detail: "token expired" };
    hookRow({ selfReport: { ...args, source: "mcp" } });
    expect(selfReportHookRecordedRecently("codex", args)).toBe(true);
    expect(selfReportHookRecordedRecently("codex", { ...args, detail: "other" })).toBe(false);
    expect(selfReportHookRecordedRecently("claude", args)).toBe(false);
    hookRow({ selfReport: { ...args, source: "mcp" }, timestamp: Date.now() - 10 * 60 * 1000 });
    expect(selfReportHookRecordedRecently("codex", args)).toBe(false);
    hookRow({ eventType: "PostToolUse", selfReport: { ...args, source: "mcp" } });
    expect(selfReportHookRecordedRecently("codex", args)).toBe(false);
    // Aliased arguments are compared as the hook recorded them.
    hookRow({ selfReport: { ...args, source: "mcp" } });
    expect(selfReportHookRecordedRecently("codex", { type: args.category, summary: args.detail })).toBe(true);
  });

  it("an untrusted Codex's report lands once, on the session Codex's own rollout names", async () => {
    writeEffectiveSelfReport({ enabled: true });
    const project = join(home, "proj");
    const day = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dir = join(home, ".codex", "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    mkdirSync(dir, { recursive: true });
    mkdirSync(project, { recursive: true });
    const meta = (id: string, cwd: string) => JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n";
    writeFileSync(join(dir, "rollout-a-elsewhere.jsonl"), meta("other-id", join(home, "elsewhere")));
    writeFileSync(join(dir, "rollout-b.jsonl"), meta("codex-session-1", project));
    expect(selfReportCodexRolloutSession(project)).toEqual({ sessionId: "codex-session-1", cwd: project });
    // Too old: outside the 6 h window.
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(join(dir, "rollout-b.jsonl"), old, old);
    expect(selfReportCodexRolloutSession(project)).toBeNull();
    utimesSync(join(dir, "rollout-b.jsonl"), new Date(), new Date());

    const args = { category: "invalid_tool_or_credential", detail: "tickets: 401, token expired" };
    const reply = await handleSelfReportRpc(call(args), { agent: "codex", cwd: project });
    expect(reply).toMatchObject({ result: { content: [{ type: "text", text: "Recorded." }] } });
    expect(events()).toEqual([expect.objectContaining({ integration: "codex", session_id: "codex-session-1", agent_id: "codex-proj", ...args })]);

    // The same call after the hook recorded it: nothing more.
    hookRow({ selfReport: { ...args, source: "mcp" } });
    await handleSelfReportRpc(call(args), { agent: "codex", cwd: project });
    expect(events()).toHaveLength(1);
  });

  it("Claude Code with hooks off: attributed to its newest transcript in that directory", () => {
    const project = join(home, "my.proj");
    const dir = join(home, ".claude", "projects", project.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "11111111-1111-4111-8111-111111111111.jsonl"), "{}\n");
    const older = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "11111111-1111-4111-8111-111111111111.jsonl"), older, older);
    writeFileSync(join(dir, "22222222-2222-4222-8222-222222222222.jsonl"), "{}\n");
    expect(selfReportClaudeTranscriptSession(project)).toEqual({ sessionId: "22222222-2222-4222-8222-222222222222", cwd: project });
    expect(selfReportClaudeTranscriptSession(join(home, "other"))).toBeNull();
  });
});

describe("the CLI a daemon's sync registers for stdio", () => {
  it("looks beside the node that runs it, then npm's and bun's global bins", () => {
    const dirs = selfReportCliDirs({ NPM_CONFIG_PREFIX: "/opt/npm" }, "/home/u/.nvm/versions/node/v26/bin/node", "/home/u");
    expect(dirs).toEqual([
      "/home/u/.nvm/versions/node/v26/bin",
      "/opt/npm/bin",
      "/home/u/.npm-global/bin",
      "/usr/local/bin",
      "/home/u/.bun/bin",
    ]);
  });

  it("finds the npm link next to node when PATH has no failproofai (a systemd unit's PATH)", () => {
    const bin = join(home, "nodebin");
    mkdirSync(bin);
    writeFileSync(join(bin, "failproofai"), "#!/bin/sh\n");
    chmodSync(join(bin, "failproofai"), 0o755);
    vi.stubEnv("PATH", "/nonexistent");
    vi.stubEnv("FAILPROOFAI_BINARY_OVERRIDE", "");
    const execPath = process.execPath;
    Object.defineProperty(process, "execPath", { value: join(bin, "node"), configurable: true });
    const argv1 = process.argv[1];
    process.argv[1] = "/x/lib/node_modules/failproofai/dist/cli.mjs";
    try {
      expect(resolveSelfReportCliPath()).toBe(join(bin, "failproofai"));
    } finally {
      Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
      process.argv[1] = argv1;
    }
  });
});
