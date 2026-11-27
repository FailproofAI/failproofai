// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import {
  SELF_REPORT_MCP_TARGETS,
  isOurMcpEntry,
  probeSelfReportHttp,
  probeSelfReportHttpInstance,
  selfReportDaemonLive,
  selfReportHttpAllowed,
  selfReportSyncChanged,
  readSelfReportMcpSettings,
  removeSelfReportMcp,
  selfReportRegistrationStatus,
  syncSelfReportMcp,
  type SyncSelfReportMcpOptions,
} from "../../src/hooks/self-report-install";
import { mergeTomlManagedBlock } from "../../src/hooks/toml-managed-block";
import { INTEGRATION_TYPES, type IntegrationType } from "../../src/hooks/types";
import {
  SELF_REPORT_SERVER_RECORDS,
  ensureSelfReportSettingsFile,
  readEffectiveSelfReport,
  readEnabledSelfReport,
} from "../../src/hooks/self-report";
import { runSelfReportCommand } from "../../src/hooks/self-report-cli";

const CLI = "/usr/local/bin/failproofai";
let home: string;

function enabledOpts(extra: Partial<SyncSelfReportMcpOptions> = {}, daemon = true): SyncSelfReportMcpOptions {
  return {
    quiet: true,
    binaryPath: CLI,
    ...extra,
    deps: {
      daemonLive: async () => daemon,
      hooksInstalled: () => true,
      settings: { enabled: true, port: 4319 },
      ...extra.deps,
    },
  };
}

function pathOf(agent: IntegrationType): string {
  return SELF_REPORT_MCP_TARGETS[agent].paths()[0];
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The parsed `failproofai_local` entry, whatever the agent's format. */
function entryIn(agent: IntegrationType): Record<string, unknown> | undefined {
  const path = pathOf(agent);
  if (!existsSync(path)) return undefined;
  const text = read(path);
  const t = SELF_REPORT_MCP_TARGETS[agent];
  const doc = (t.format === "toml" ? parseToml(text) : t.format === "yaml" ? parseYaml(text) ?? {} : parseJsonc(text)) as Record<string, unknown>;
  const container = t.container(doc);
  let v: unknown = doc;
  for (const k of [...container, "failproofai_local"]) v = (v as Record<string, unknown> | undefined)?.[k];
  return v as Record<string, unknown> | undefined;
}

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "fp-selfreport-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  for (const k of [
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME", "PI_CODING_AGENT_DIR", "HERMES_HOME",
    "OPENCLAW_STATE_DIR", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH", "GOOSE_PATH_ROOT", "XDG_CONFIG_HOME",
    "FAILPROOFAI_SELF_REPORT_PORT",
  ]) vi.stubEnv(k, "");
  vi.stubEnv("FAILPROOFAI_HOME", resolve(home, ".failproofai"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// A pre-existing user server and some other setting, per format.
const USER_JSON = (container: string[]) => {
  const inner: Record<string, unknown> = { mine: { command: "node", args: ["my-server.js"] } };
  let obj: Record<string, unknown> = inner;
  for (const k of [...container].reverse()) obj = { [k]: obj };
  return { theme: "dark", ...obj };
};

describe("syncSelfReportMcp: every agent round-trips", () => {
  for (const agent of INTEGRATION_TYPES) {
    const target = SELF_REPORT_MCP_TARGETS[agent];
    it(`${agent}: adds, is idempotent, keeps the user's entries, removes only ours`, async () => {
      const path = pathOf(agent);
      let original: string;
      if (target.format === "toml") {
        original = '# my codex config\nmodel = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "node" # inline note\nargs = ["my-server.js"]\n';
      } else if (target.format === "yaml") {
        const key = target.container({})[0];
        original = `# my config\nmodel: some-model\n${key}:\n  # my server\n  mine:\n    command: node\n    args: [my-server.js]\n`;
      } else {
        original = `// a comment\n${JSON.stringify(USER_JSON(target.container({})), null, 2)}\n`;
        if (agent === "claude") original = JSON.stringify(USER_JSON(["mcpServers"]), null, 2) + "\n";
      }
      put(path, original);

      // With a live daemon: HTTP for a hook-recorded agent, stdio for one the
      // server records (it must know the caller's cwd).
      const want = selfReportHttpAllowed(agent) ? "http" : "stdio";
      const first = await syncSelfReportMcp(enabledOpts({ agents: [agent] }));
      expect(first.map((r) => [r.action, r.status, r.transport])).toEqual(
        first.map(() => ["added", "ok", want]),
      );
      const entry = entryIn(agent)!;
      expect(isOurMcpEntry(entry)).toBe(true);
      expect(JSON.stringify(entry)).toContain(
        want === "http" ? `http://127.0.0.1:4319/mcp?agent=${agent}` : JSON.stringify(["mcp", "--agent", agent]).slice(1, -1),
      );
      const afterAdd = read(path);
      // the user's things are still there, comments included
      expect(afterAdd).toContain("mine");
      expect(afterAdd).toContain(target.format === "json" && agent === "claude" ? "dark" : target.format === "toml" ? "# inline note" : target.format === "yaml" ? "# my server" : "// a comment");

      const second = await syncSelfReportMcp(enabledOpts({ agents: [agent] }));
      expect(second.every((r) => r.action === "unchanged" && r.status === "ok")).toBe(true);
      expect(read(path)).toBe(afterAdd);

      const removed = removeSelfReportMcp({ agents: [agent], quiet: true });
      expect(removed.map((r) => r.action)).toEqual(removed.map(() => "removed"));
      expect(entryIn(agent)).toBeUndefined();
      const afterRemove = read(path);
      expect(afterRemove).toContain("mine");
      if (target.format === "toml") expect(afterRemove).toBe(original);

      const again = removeSelfReportMcp({ agents: [agent], quiet: true });
      expect(again.every((r) => r.action === "unchanged")).toBe(true);
      expect(read(path)).toBe(afterRemove);
    });
  }
});

describe("transport choice", () => {
  it("uses HTTP only for hook-recorded agents; every server-recorded agent stays on stdio", async () => {
    expect(INTEGRATION_TYPES.filter((a) => selfReportHttpAllowed(a))).toEqual(["claude", "codex"]);
    for (const a of SELF_REPORT_SERVER_RECORDS) expect(selfReportHttpAllowed(a as IntegrationType)).toBe(false);
    const r = await syncSelfReportMcp(enabledOpts({}, true));
    for (const x of r) expect(x.transport).toBe(selfReportHttpAllowed(x.agent) ? "http" : "stdio");
    // Every agent's HTTP shape is still one we recognise (a stale one is moved).
    for (const a of INTEGRATION_TYPES) {
      const t = SELF_REPORT_MCP_TARGETS[a];
      expect(isOurMcpEntry(t.entry({ kind: "http", url: `http://127.0.0.1:4319/mcp?agent=${a}` }, t.container({})))).toBe(true);
    }
  });

  it("never asks for the live check when only server-recorded agents want an entry", async () => {
    const daemonLive = vi.fn(async () => true);
    await syncSelfReportMcp(enabledOpts({ agents: ["copilot", "pi", "hermes"], deps: { daemonLive } }));
    expect(daemonLive).not.toHaveBeenCalled();
  });

  it("moves a server-recorded agent's older HTTP entry to stdio", async () => {
    put(pathOf("copilot"), JSON.stringify({ mcpServers: { failproofai_local: { type: "http", url: "http://127.0.0.1:4319/mcp?agent=copilot", tools: ["*"] } } }));
    const r = await syncSelfReportMcp(enabledOpts({ agents: ["copilot"] }, true));
    expect(r[0]).toMatchObject({ action: "updated", transport: "stdio" });
    expect(entryIn("copilot")).toEqual({ type: "local", command: CLI, args: ["mcp", "--agent", "copilot"], tools: ["*"] });
  });

  it("uses stdio with the CLI path and --agent when no daemon is live", async () => {
    await syncSelfReportMcp(enabledOpts({ agents: ["claude", "codex", "opencode", "goose"] }, false));
    expect(entryIn("claude")).toEqual({ type: "stdio", command: CLI, args: ["mcp", "--agent", "claude"] });
    expect(entryIn("codex")).toEqual({ command: CLI, args: ["mcp", "--agent", "codex"] });
    expect(entryIn("opencode")).toEqual({ type: "local", command: [CLI, "mcp", "--agent", "opencode"], enabled: true });
    expect(entryIn("goose")).toMatchObject({ type: "stdio", cmd: CLI, args: ["mcp", "--agent", "goose"], enabled: true });
  });

  it("exposes Pi's entry directly, on both transports, and moves an old entry to it", async () => {
    await syncSelfReportMcp(enabledOpts({ agents: ["pi"] }, false));
    expect(entryIn("pi")).toEqual({ command: CLI, args: ["mcp", "--agent", "pi"], exposure: "direct" });
    // An older HTTP entry, written before `exposure` was set, is ours: it is
    // moved to stdio (Pi is server-recorded) with exposure set.
    put(pathOf("pi"), JSON.stringify({ mcpServers: { failproofai_local: { url: "http://127.0.0.1:4319/mcp?agent=pi" } } }));
    const r = await syncSelfReportMcp(enabledOpts({ agents: ["pi"] }, true));
    expect(r[0]).toMatchObject({ action: "updated", transport: "stdio" });
    expect(entryIn("pi")).toEqual({ command: CLI, args: ["mcp", "--agent", "pi"], exposure: "direct" });
  });

  it("tells the user how cursor-agent approves the server when Cursor's entry is written", async () => {
    const { selfReportSyncLines } = await import("../../src/hooks/self-report-install");
    const lines = selfReportSyncLines(await syncSelfReportMcp(enabledOpts({ agents: ["cursor", "claude"] })));
    expect(lines.filter((l) => l.includes("cursor-agent mcp enable failproofai_local"))).toHaveLength(1);
    expect(lines.findIndex((l) => l.includes("cursor-agent mcp enable"))).toBe(
      lines.findIndex((l) => l.includes("Cursor")) + 1,
    );
  });

  it("switches an existing entry between transports in place", async () => {
    await syncSelfReportMcp(enabledOpts({ agents: ["codex"] }, false));
    const r = await syncSelfReportMcp(enabledOpts({ agents: ["codex"] }, true));
    expect(r[0]).toMatchObject({ action: "updated", transport: "http" });
    const text = read(pathOf("codex"));
    expect(text.match(/\[mcp_servers\.failproofai_local\]/g)).toHaveLength(1);
    expect(entryIn("codex")).toEqual({ url: "http://127.0.0.1:4319/mcp?agent=codex" });
  });

  it("takes the port from self-report.json", async () => {
    const p = resolve(home, ".failproofai", "self-report.json");
    put(p, JSON.stringify({ version: 1, enabled: true, mcp: { port: 5555, url: "http://127.0.0.1:5555/mcp" } }));
    expect(readSelfReportMcpSettings()).toEqual({ enabled: true, port: 5555 });
    await syncSelfReportMcp({ quiet: true, agents: ["claude"], deps: { daemonLive: async () => true, hooksInstalled: () => true } });
    expect(entryIn("claude")).toEqual({ type: "http", url: "http://127.0.0.1:5555/mcp?agent=claude" });
  });

  it("reads a missing file as on off Cloud, off on Cloud, and a broken file as off", async () => {
    // On by default: no file and no local config on an open-source machine.
    expect(readSelfReportMcpSettings()).toEqual({ enabled: true, port: 4319 });
    // Cloud enrolled, the daemon has not written the file yet: off.
    vi.stubEnv("FAILPROOFAI_CLOUD_URL", "https://cloud.example.com");
    expect(readSelfReportMcpSettings()).toEqual({ enabled: false, port: 4319 });
    vi.stubEnv("FAILPROOFAI_CLOUD_URL", "");
    put(resolve(home, ".failproofai", "credentials.json"), JSON.stringify({ cloud: { url: "https://x", machine_id: "m", token: "t" } }));
    expect(readSelfReportMcpSettings().enabled).toBe(false);
    // Switched back to open source: the default applies again.
    put(resolve(home, ".failproofai", "config.json"), JSON.stringify({ mode: { kind: "oss" } }));
    expect(readSelfReportMcpSettings().enabled).toBe(true);
    // A malformed file is off whatever else is true (fail safe).
    put(resolve(home, ".failproofai", "self-report.json"), "{nope");
    expect(readSelfReportMcpSettings()).toEqual({ enabled: false, port: 4319 });
  });

  it("reports an error, writing nothing, when stdio is needed and no CLI is known", async () => {
    const base = enabledOpts({ agents: ["cursor"] }, false);
    const r = await syncSelfReportMcp({ ...base, binaryPath: undefined, deps: { ...base.deps, resolveCliPath: () => null } });
    expect(r[0]).toMatchObject({ status: "error", action: "skipped" });
    expect(existsSync(pathOf("cursor"))).toBe(false);
  });
});

describe("ownership", () => {
  it("never touches a failproofai_local entry it did not write, and reports it as a conflict", async () => {
    const path = pathOf("claude");
    const foreign = { mcpServers: { failproofai_local: { type: "http", url: "https://elsewhere.example.com/mcp" } } };
    put(path, JSON.stringify(foreign, null, 2) + "\n");
    const before = read(path);
    expect((await syncSelfReportMcp(enabledOpts({ agents: ["claude"] })))[0]).toMatchObject({ status: "conflict", action: "skipped" });
    expect(removeSelfReportMcp({ agents: ["claude"], quiet: true })[0]).toMatchObject({ status: "conflict" });
    expect(read(path)).toBe(before);
  });

  it("treats a hand-written codex [mcp_servers.failproofai_local] outside our markers as foreign", async () => {
    const path = pathOf("codex");
    put(path, '[mcp_servers.failproofai_local]\nurl = "http://127.0.0.1:4319/mcp?agent=codex"\n');
    const before = read(path);
    expect((await syncSelfReportMcp(enabledOpts({ agents: ["codex"] })))[0].status).toBe("conflict");
    expect(read(path)).toBe(before);
  });

  // The Cloud MCP gateway is registered as `failproofai`. Ours is
  // `failproofai_local`, so the gateway's entry is never read, changed,
  // removed or reported, in any format, even one shaped exactly like ours.
  const GATEWAY_URL = "https://gateway.befailproof.ai/mcp";
  const gatewayFixtures: Array<[IntegrationType, string, (text: string) => unknown]> = [
    ["claude", JSON.stringify({ mcpServers: { failproofai: { type: "http", url: GATEWAY_URL } } }, null, 2) + "\n",
      (t) => (JSON.parse(t) as { mcpServers: Record<string, unknown> }).mcpServers.failproofai],
    ["cursor", JSON.stringify({ mcpServers: { failproofai: { url: GATEWAY_URL } } }, null, 2) + "\n",
      (t) => (JSON.parse(t) as { mcpServers: Record<string, unknown> }).mcpServers.failproofai],
    ["opencode", JSON.stringify({ mcp: { failproofai: { type: "remote", url: GATEWAY_URL, enabled: true } } }, null, 2) + "\n",
      (t) => (JSON.parse(t) as { mcp: Record<string, unknown> }).mcp.failproofai],
    ["codex", `[mcp_servers.failproofai]\nurl = "${GATEWAY_URL}"\n`,
      (t) => (parseToml(t) as { mcp_servers: Record<string, unknown> }).mcp_servers.failproofai],
    ["hermes", `mcp_servers:\n  failproofai:\n    url: ${GATEWAY_URL}\n`,
      (t) => (parseYaml(t) as { mcp_servers: Record<string, unknown> }).mcp_servers.failproofai],
    ["goose", `extensions:\n  failproofai:\n    name: failproofai\n    type: streamable_http\n    enabled: true\n    uri: ${GATEWAY_URL}\n`,
      (t) => (parseYaml(t) as { extensions: Record<string, unknown> }).extensions.failproofai],
  ];
  for (const [agent, text, gatewayOf] of gatewayFixtures) {
    it(`${agent}: leaves a Cloud gateway entry named failproofai untouched next to ours`, async () => {
      if (agent === "hermes") put(resolve(home, ".hermes", "config.yaml"), text);
      else put(pathOf(agent), text);
      const path = pathOf(agent);
      const gateway = gatewayOf(read(path));
      const added = await syncSelfReportMcp(enabledOpts({ agents: [agent] }));
      expect(added.map((r) => [r.action, r.status])).toEqual([["added", "ok"]]);
      expect(isOurMcpEntry(entryIn(agent))).toBe(true);
      expect(gatewayOf(read(path))).toEqual(gateway);
      const status = selfReportRegistrationStatus({ agents: [agent], hooksInstalled: () => true });
      expect(status.map((r) => [r.registered, r.conflict])).toEqual([[true, false]]);
      // Disable and uninstall take out ours only.
      expect(removeSelfReportMcp({ agents: [agent], quiet: true }).map((r) => r.action)).toEqual(["removed"]);
      expect(entryIn(agent)).toBeUndefined();
      expect(gatewayOf(read(path))).toEqual(gateway);
    });
  }

  it("leaves a failproofai entry alone even when it is shaped like ours", async () => {
    const path = pathOf("claude");
    put(path, JSON.stringify({ mcpServers: { failproofai: { type: "http", url: "http://127.0.0.1:4319/mcp?agent=claude" } } }, null, 2) + "\n");
    await syncSelfReportMcp(enabledOpts({ agents: ["claude"] }));
    removeSelfReportMcp({ agents: ["claude"], quiet: true });
    expect(JSON.parse(read(path)).mcpServers.failproofai).toEqual({ type: "http", url: "http://127.0.0.1:4319/mcp?agent=claude" });
  });

  it("refuses a codex config whose inline mcp_servers table would collide, leaving it as is", async () => {
    const path = pathOf("codex");
    put(path, 'mcp_servers = { mine = { command = "node" } }\n');
    const before = read(path);
    const r = (await syncSelfReportMcp(enabledOpts({ agents: ["codex"] })))[0];
    expect(r.status).toBe("error");
    expect(read(path)).toBe(before);
  });

  it("refuses an unparsable config", async () => {
    const path = pathOf("cursor");
    put(path, "{ not json");
    const r = (await syncSelfReportMcp(enabledOpts({ agents: ["cursor"] })))[0];
    expect(r.status).toBe("error");
    expect(read(path)).toBe("{ not json");
  });

  it("recognises only our shapes", async () => {
    expect(isOurMcpEntry({ url: "http://127.0.0.1:4319/mcp?agent=claude" })).toBe(true);
    expect(isOurMcpEntry({ serverUrl: "http://localhost:4319/mcp?agent=antigravity" })).toBe(true);
    expect(isOurMcpEntry({ command: "/x/bin/failproofai", args: ["mcp", "--agent", "pi"] })).toBe(true);
    expect(isOurMcpEntry({ url: "https://gateway.example.com/mcp" })).toBe(false);
    expect(isOurMcpEntry({ command: "/x/bin/failproofai", args: ["--hook", "PreToolUse"] })).toBe(false);
    expect(isOurMcpEntry({ command: "node", args: ["mcp", "--agent", "pi"] })).toBe(false);
  });
});

describe("which agents", () => {
  it("enabled: only hooked agents get an entry; unhooked ones are left alone", async () => {
    const r = await syncSelfReportMcp(enabledOpts({ deps: { hooksInstalled: (a) => a === "claude" } }));
    expect(r.filter((x) => x.action === "added").map((x) => x.agent)).toEqual(["claude"]);
    expect(r.filter((x) => x.agent !== "claude").every((x) => x.status === "not-hooked")).toBe(true);
    expect(existsSync(pathOf("cursor"))).toBe(false);
  });

  it("alsoHooked registers agents installHooks just wrote", async () => {
    const r = await syncSelfReportMcp(enabledOpts({ agents: ["cursor"], alsoHooked: ["cursor"], deps: { hooksInstalled: () => false } }));
    expect(r[0].action).toBe("added");
  });

  it("keeps and repairs an existing registration whose hooks are only at project scope", async () => {
    // Installed with project-scope hooks (alsoHooked) while the daemon was up.
    await syncSelfReportMcp(enabledOpts({ agents: ["claude"], alsoHooked: ["claude"], deps: { hooksInstalled: () => false } }, true));
    expect(entryIn("claude")).toEqual({ type: "http", url: "http://127.0.0.1:4319/mcp?agent=claude" });
    // A later sync sees no user-scope hooks; the daemon is gone. The entry is
    // moved to stdio, not stranded on a dead endpoint.
    const r = await syncSelfReportMcp(enabledOpts({ agents: ["claude", "factory"], deps: { hooksInstalled: () => false } }, false));
    expect(r.find((x) => x.agent === "claude")).toMatchObject({ action: "updated", transport: "stdio", status: "ok" });
    expect(entryIn("claude")).toEqual({ type: "stdio", command: CLI, args: ["mcp", "--agent", "claude"] });
    // An agent never registered and without hooks is still left alone.
    expect(r.find((x) => x.agent === "factory")).toMatchObject({ action: "skipped", status: "not-hooked" });
    expect(existsSync(pathOf("factory"))).toBe(false);
  });

  it("the live check is asked for an unhooked agent that already has our entry", async () => {
    await syncSelfReportMcp(enabledOpts({ agents: ["codex"], alsoHooked: ["codex"], deps: { hooksInstalled: () => false } }, false));
    const daemonLive = vi.fn(async () => true);
    const r = await syncSelfReportMcp(enabledOpts({ agents: ["codex"], deps: { daemonLive, hooksInstalled: () => false } }));
    expect(daemonLive).toHaveBeenCalledTimes(1);
    expect(r[0]).toMatchObject({ action: "updated", transport: "http" });
  });

  it("disabled: removes ours from every agent, hooked or not", async () => {
    await syncSelfReportMcp(enabledOpts({ agents: ["claude", "factory"] }));
    const r = await syncSelfReportMcp({ quiet: true, deps: { settings: { enabled: false, port: 4319 }, hooksInstalled: () => false, daemonLive: async () => true } });
    expect(r.filter((x) => x.action === "removed").map((x) => x.agent).sort()).toEqual(["claude", "factory"]);
    expect(entryIn("claude")).toBeUndefined();
  });

  it("writes every Hermes profile", async () => {
    put(resolve(home, ".hermes", "config.yaml"), "model: x\n");
    put(resolve(home, ".hermes", "profiles", "work", "config.yaml"), "model: y\n");
    const r = await syncSelfReportMcp(enabledOpts({ agents: ["hermes"] }));
    expect(r.map((x) => x.action)).toEqual(["added", "added"]);
    for (const p of [resolve(home, ".hermes", "config.yaml"), resolve(home, ".hermes", "profiles", "work", "config.yaml")]) {
      const doc = parseYaml(read(p)) as { mcp_servers: { failproofai_local: unknown } };
      expect(doc.mcp_servers.failproofai_local).toEqual({ command: CLI, args: ["mcp", "--agent", "hermes"] });
      expect(read(p)).toContain("failproofai self-report MCP server");
    }
  });

  it("honours CLAUDE_CONFIG_DIR, CODEX_HOME and COPILOT_HOME", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", resolve(home, "claude-work"));
    vi.stubEnv("CODEX_HOME", resolve(home, "codex-x"));
    vi.stubEnv("COPILOT_HOME", resolve(home, "cop"));
    expect(pathOf("claude")).toBe(resolve(home, "claude-work", ".claude.json"));
    expect(pathOf("codex")).toBe(resolve(home, "codex-x", "config.toml"));
    expect(pathOf("copilot")).toBe(resolve(home, "cop", "mcp-config.json"));
  });

  it("uses OpenCode v2's mcp.servers when the file already has it", async () => {
    put(pathOf("opencode"), JSON.stringify({ mcp: { servers: { mine: { type: "local", command: ["node"] } } } }));
    await syncSelfReportMcp(enabledOpts({ agents: ["opencode"] }));
    const doc = JSON.parse(read(pathOf("opencode")));
    expect(doc.mcp.servers.failproofai_local).toEqual({ type: "local", command: [CLI, "mcp", "--agent", "opencode"] });
    expect(doc.mcp.failproofai_local).toBeUndefined();
  });

  it("keeps a backup of the file it changed", async () => {
    put(pathOf("factory"), '{"mcpServers":{}}\n');
    await syncSelfReportMcp(enabledOpts({ agents: ["factory"] }));
    expect(read(`${pathOf("factory")}.failproofai-backup`)).toBe('{"mcpServers":{}}\n');
  });
});

// ── Live transport check ────────────────────────────────────────────────────

/**
 * A fake daemon socket: answers every framed request with a framed pong. With
 * `selfReport`, the pong names the MCP server it serves (instance id + port).
 */
function fakeDaemon(path: string, answer = true, selfReport?: { instanceId: string; port: number }): Promise<NetServer> {
  const server = createNetServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk as Buffer]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      if (!answer) return; // accepted, never answered
      const req = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString("utf8"));
      const body = Buffer.from(JSON.stringify({ type: "pong", protocolVersion: req.protocolVersion, ...(selfReport ? { selfReport } : {}) }));
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      sock.end(Buffer.concat([head, body]));
    });
  });
  return new Promise((ok) => server.listen(path, () => ok(server)));
}

/** A fake MCP endpoint on an ephemeral loopback port. */
function fakeMcp(serverName = "failproofai_local", instanceId: string | null = "inst-1"): Promise<{ server: HttpServer; port: number }> {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: serverName, version: "1", ...(instanceId === null ? {} : { instanceId }) } } }));
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: (server.address() as { port: number }).port })));
}

/** A loopback port nothing listens on. */
async function deadPort(): Promise<number> {
  const { server, port } = await fakeMcp();
  await new Promise((ok) => server.close(ok));
  return port;
}

const closeAll: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closeAll.length) await closeAll.pop()!();
});
function track<T extends { close(cb?: (err?: Error) => void): unknown }>(server: T): T {
  closeAll.push(() => new Promise((ok) => server.close(() => ok(undefined))));
  return server;
}

describe("live transport check", () => {
  const socket = () => resolve(home, "daemon.sock");

  it("a leftover socket file with no daemon behind it gives stdio, not a dead HTTP entry", async () => {
    // What a hard-killed daemon leaves: the path exists, nothing listens on it.
    writeFileSync(socket(), "");
    vi.stubEnv("FAILPROOFAI_DAEMON_SOCKET", socket());
    const port = await deadPort();
    expect(await selfReportDaemonLive(port)).toBe(false);
    const r = await syncSelfReportMcp({
      quiet: true, agents: ["claude"], binaryPath: CLI,
      deps: { hooksInstalled: () => true, settings: { enabled: true, port } },
    });
    expect(r[0]).toMatchObject({ action: "added", transport: "stdio" });
    expect(entryIn("claude")).toEqual({ type: "stdio", command: CLI, args: ["mcp", "--agent", "claude"] });
  });

  it("a daemon answering ping AND an MCP initialize gives http; a later sync moves it back once it is gone", async () => {
    vi.stubEnv("FAILPROOFAI_DAEMON_SOCKET", socket());
    const { server, port } = await fakeMcp();
    const daemon = await fakeDaemon(socket(), true, { instanceId: "inst-1", port });
    expect(await selfReportDaemonLive(port)).toBe(true);
    const opts = { quiet: true, agents: ["claude"] as IntegrationType[], binaryPath: CLI, deps: { hooksInstalled: () => true, settings: { enabled: true, port } } };
    expect((await syncSelfReportMcp(opts))[0]).toMatchObject({ action: "added", transport: "http" });
    expect(entryIn("claude")).toEqual({ type: "http", url: `http://127.0.0.1:${port}/mcp?agent=claude` });

    await new Promise((ok) => daemon.close(ok));
    await new Promise((ok) => server.close(ok));
    expect((await syncSelfReportMcp(opts))[0]).toMatchObject({ action: "updated", transport: "stdio" });
  });

  it("needs both halves: a ping without the endpoint, or the endpoint without a ping, is stdio", async () => {
    vi.stubEnv("FAILPROOFAI_DAEMON_SOCKET", socket());
    const dead = await deadPort();
    const daemon = track(await fakeDaemon(socket(), true, { instanceId: "inst-1", port: dead }));
    expect(await selfReportDaemonLive(dead)).toBe(false);
    await new Promise((ok) => daemon.close(ok));
    closeAll.pop();
    const { server, port } = await fakeMcp();
    track(server);
    expect(await selfReportDaemonLive(port)).toBe(false);
  });

  it("a daemon that accepts but never answers the ping is not live", async () => {
    vi.stubEnv("FAILPROOFAI_DAEMON_SOCKET", socket());
    track(await fakeDaemon(socket(), false));
    const { server, port } = await fakeMcp();
    track(server);
    expect(await selfReportDaemonLive(port)).toBe(false);
  }, 10_000);

  it("the endpoint must be served by the daemon behind this socket", async () => {
    vi.stubEnv("FAILPROOFAI_DAEMON_SOCKET", socket());
    // Another daemon (another home) holds the port; this one's bind failed, so
    // its pong names no MCP server: stdio, even though the port answers.
    const { server, port } = await fakeMcp("failproofai_local", "other-daemon");
    track(server);
    const daemon = track(await fakeDaemon(socket()));
    expect(await probeSelfReportHttpInstance(port)).toBe("other-daemon");
    expect(await selfReportDaemonLive(port)).toBe(false);
    const r = await syncSelfReportMcp({
      quiet: true, agents: ["claude"], binaryPath: CLI,
      deps: { hooksInstalled: () => true, settings: { enabled: true, port } },
    });
    expect(r[0]).toMatchObject({ transport: "stdio" });
    await new Promise((ok) => daemon.close(ok));
    closeAll.pop();
    // This daemon serves MCP too, under its own id, but the port answers with
    // another id: still stdio.
    track(await fakeDaemon(socket(), true, { instanceId: "this-daemon", port }));
    expect(await selfReportDaemonLive(port)).toBe(false);
  });

  it("a pong naming another port, or an endpoint with no instance id, is stdio", async () => {
    vi.stubEnv("FAILPROOFAI_DAEMON_SOCKET", socket());
    const { server, port } = await fakeMcp("failproofai_local", "inst-1");
    track(server);
    const daemon = track(await fakeDaemon(socket(), true, { instanceId: "inst-1", port: port + 1 }));
    expect(await selfReportDaemonLive(port)).toBe(false);
    await new Promise((ok) => daemon.close(ok));
    closeAll.pop();
    const old = await fakeMcp("failproofai_local", null);
    track(old.server);
    expect(await probeSelfReportHttpInstance(old.port)).toBe("");
    track(await fakeDaemon(socket(), true, { instanceId: "inst-1", port: old.port }));
    expect(await selfReportDaemonLive(old.port)).toBe(false);
  });

  it("another server on the port is not ours", async () => {
    const { server, port } = await fakeMcp("someone-else");
    track(server);
    expect(await probeSelfReportHttp(port)).toBe(false);
  });

  it("is not asked when the feature is off or no agent would get an entry", async () => {
    const daemonLive = vi.fn(async () => true);
    await syncSelfReportMcp({ quiet: true, deps: { daemonLive, hooksInstalled: () => true, settings: { enabled: false, port: 4319 } } });
    await syncSelfReportMcp({ quiet: true, binaryPath: CLI, deps: { daemonLive, hooksInstalled: () => false, settings: { enabled: true, port: 4319 } } });
    expect(daemonLive).not.toHaveBeenCalled();
  });

  it("selfReportSyncChanged is true only for an add, update or remove", async () => {
    const first = await syncSelfReportMcp(enabledOpts({ agents: ["claude"] }));
    expect(selfReportSyncChanged(first)).toBe(true);
    expect(selfReportSyncChanged(await syncSelfReportMcp(enabledOpts({ agents: ["claude"] })))).toBe(false);
  });
});

describe("selfReportRegistrationStatus", () => {
  it("reports registered, transport, conflict and hooked per file without writing", async () => {
    await syncSelfReportMcp(enabledOpts({ agents: ["claude"] }, false));
    put(pathOf("cursor"), JSON.stringify({ mcpServers: { failproofai_local: { url: "https://elsewhere" } } }));
    const s = selfReportRegistrationStatus({ agents: ["claude", "cursor", "factory"], hooksInstalled: (a) => a === "claude" });
    expect(s).toEqual([
      expect.objectContaining({ agent: "claude", hooked: true, registered: true, transport: "stdio", endpoint: CLI, conflict: false }),
      expect.objectContaining({ agent: "cursor", hooked: false, registered: false, conflict: true }),
      expect.objectContaining({ agent: "factory", hooked: false, registered: false, conflict: false }),
    ]);
    expect(existsSync(pathOf("factory"))).toBe(false);
  });
});

describe("mergeTomlManagedBlock", () => {
  const M = { begin: "# >>> b >>>", end: "# <<< b <<<" };
  it("appends, replaces in place and removes byte for byte", async () => {
    const orig = 'a = 1\n[t]\nb = 2 # c\n';
    const one = mergeTomlManagedBlock(orig, "# >>> b >>>\nx = 1\n# <<< b <<<\n", M);
    expect(one).toBe(`${orig}\n# >>> b >>>\nx = 1\n# <<< b <<<\n`);
    const two = mergeTomlManagedBlock(one, "# >>> b >>>\nx = 2\n# <<< b <<<\n", M);
    expect(two).toContain("x = 2");
    expect(two).not.toContain("x = 1");
    expect(mergeTomlManagedBlock(two, null, M)).toBe(orig);
  });
  it("throws on a half block", async () => {
    expect(() => mergeTomlManagedBlock("# >>> b >>>\nx=1\n", null, M)).toThrow();
  });
});

describe("on by default: install, disable, enable", () => {
  const settingsFile = () => resolve(home, ".failproofai", "self-report.json");
  /** The sync the CLI runs, against this test's agents and with no daemon. */
  const sync = () =>
    syncSelfReportMcp({
      quiet: true,
      binaryPath: CLI,
      agents: ["claude", "cursor"],
      deps: { daemonLive: async () => false, hooksInstalled: () => true },
    });

  it("a fresh install with no file writes it on, registers the server and records", async () => {
    expect(existsSync(settingsFile())).toBe(false);
    const written = await ensureSelfReportSettingsFile();
    expect(written).toMatchObject({ enabled: true, source: "local" });
    expect(readEffectiveSelfReport()?.categories.map((c) => c.name)).toEqual([
      "looping", "cannot_do_request", "invalid_tool_or_credential", "missing_context", "repeated_tool_failure", "task_failure",
    ]);
    const results = await sync();
    expect(results.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(entryIn("claude")).toMatchObject({ type: "stdio" });
    expect(entryIn("cursor")).toBeDefined();
    expect(readEnabledSelfReport()).not.toBeNull();
    // A second install leaves the file as it is.
    expect(await ensureSelfReportSettingsFile()).toBeNull();
  });

  it("disable removes the entries and stops recording; enable brings both back", async () => {
    await ensureSelfReportSettingsFile();
    await sync();
    expect(entryIn("claude")).toBeDefined();

    const off = await runSelfReportCommand(["disable"], { sync });
    expect(off.exitCode).toBe(0);
    expect(readEffectiveSelfReport()?.enabled).toBe(false);
    expect(readEnabledSelfReport()).toBeNull();
    expect(entryIn("claude")).toBeUndefined();
    expect(entryIn("cursor")).toBeUndefined();
    const config = JSON.parse(read(resolve(home, ".failproofai", "config.json")));
    expect(config.selfReport.enabled).toBe(false);

    // An explicit off wins over a later install, with or without the file.
    expect(await ensureSelfReportSettingsFile()).toBeNull();
    rmSync(settingsFile());
    expect(readEnabledSelfReport()).toBeNull();
    expect(await ensureSelfReportSettingsFile()).toMatchObject({ enabled: false });
    expect((await sync()).every((r) => r.status === "ok")).toBe(true);
    expect(entryIn("claude")).toBeUndefined();

    const on = await runSelfReportCommand(["enable"], { sync });
    expect(on.exitCode).toBe(0);
    expect(readEnabledSelfReport()).not.toBeNull();
    expect(entryIn("claude")).toBeDefined();
    expect(entryIn("cursor")).toBeDefined();
  });

  it("a Cloud-enrolled machine writes no file on install and stays off until the daemon writes it", async () => {
    vi.stubEnv("FAILPROOFAI_CLOUD_URL", "https://cloud.example.com");
    expect(await ensureSelfReportSettingsFile()).toBeNull();
    expect(existsSync(settingsFile())).toBe(false);
    expect(readEnabledSelfReport()).toBeNull();
    await sync();
    expect(entryIn("claude")).toBeUndefined();
    const refused = await runSelfReportCommand(["disable"], { sync });
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join("\n")).toContain("Settings > Self Reports");
  });

  it("a malformed file is off and an install leaves it alone", async () => {
    put(settingsFile(), "{ not json");
    expect(await ensureSelfReportSettingsFile()).toBeNull();
    expect(read(settingsFile())).toBe("{ not json");
    expect(readEnabledSelfReport()).toBeNull();
    await sync();
    expect(entryIn("claude")).toBeUndefined();
  });
});

describe("the test-only real-home guard", () => {
  it("refuses to write an agent config under the developer's real home", async () => {
    const { userInfo } = await import("node:os");
    const { join } = await import("node:path");
    const realHome = userInfo().homedir;
    const prev = process.env.HOME;
    // Simulate a test that forgot to move HOME: the writer resolves the real home.
    process.env.HOME = realHome;
    try {
      const mod = await import("../../src/hooks/self-report-install");
      const results = await mod.syncSelfReportMcp({ enabled: true, quiet: true, agents: ["cursor"], alsoHooked: ["cursor"] } as never);
      const target = join(realHome, ".cursor", "mcp.json");
      const written = results.find((r: { agent: string; path?: string; action?: string }) => r.agent === "cursor");
      expect(written?.action).not.toBe("added");
      expect(written?.action).not.toBe("updated");
      expect(String(written?.path ?? target).startsWith(realHome)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });
});
