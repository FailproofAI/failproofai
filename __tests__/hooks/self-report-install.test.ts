// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import {
  SELF_REPORT_MCP_TARGETS,
  isOurMcpEntry,
  readSelfReportMcpSettings,
  removeSelfReportMcp,
  selfReportRegistrationStatus,
  syncSelfReportMcp,
  type SyncSelfReportMcpOptions,
} from "../../src/hooks/self-report-install";
import { mergeTomlManagedBlock } from "../../src/hooks/toml-managed-block";
import { INTEGRATION_TYPES, type IntegrationType } from "../../src/hooks/types";

const CLI = "/usr/local/bin/failproofai";
let home: string;

function enabledOpts(extra: Partial<SyncSelfReportMcpOptions> = {}, daemon = true): SyncSelfReportMcpOptions {
  return {
    quiet: true,
    binaryPath: CLI,
    ...extra,
    deps: {
      daemonSocketPresent: () => daemon,
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

/** The parsed `failproofai` entry, whatever the agent's format. */
function entryIn(agent: IntegrationType): Record<string, unknown> | undefined {
  const path = pathOf(agent);
  if (!existsSync(path)) return undefined;
  const text = read(path);
  const t = SELF_REPORT_MCP_TARGETS[agent];
  const doc = (t.format === "toml" ? parseToml(text) : t.format === "yaml" ? parseYaml(text) ?? {} : parseJsonc(text)) as Record<string, unknown>;
  const container = t.container(doc);
  let v: unknown = doc;
  for (const k of [...container, "failproofai"]) v = (v as Record<string, unknown> | undefined)?.[k];
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
    it(`${agent}: adds, is idempotent, keeps the user's entries, removes only ours`, () => {
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

      const first = syncSelfReportMcp(enabledOpts({ agents: [agent] }));
      expect(first.map((r) => [r.action, r.status, r.transport])).toEqual(
        first.map(() => ["added", "ok", "http"]),
      );
      const entry = entryIn(agent)!;
      expect(isOurMcpEntry(entry)).toBe(true);
      expect(JSON.stringify(entry)).toContain(`http://127.0.0.1:4319/mcp?agent=${agent}`);
      const afterAdd = read(path);
      // the user's things are still there, comments included
      expect(afterAdd).toContain("mine");
      expect(afterAdd).toContain(target.format === "json" && agent === "claude" ? "dark" : target.format === "toml" ? "# inline note" : target.format === "yaml" ? "# my server" : "// a comment");

      const second = syncSelfReportMcp(enabledOpts({ agents: [agent] }));
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
  it("uses stdio with the CLI path and --agent when no daemon socket is present", () => {
    syncSelfReportMcp(enabledOpts({ agents: ["claude", "codex", "opencode", "goose"] }, false));
    expect(entryIn("claude")).toEqual({ type: "stdio", command: CLI, args: ["mcp", "--agent", "claude"] });
    expect(entryIn("codex")).toEqual({ command: CLI, args: ["mcp", "--agent", "codex"] });
    expect(entryIn("opencode")).toEqual({ type: "local", command: [CLI, "mcp", "--agent", "opencode"], enabled: true });
    expect(entryIn("goose")).toMatchObject({ type: "stdio", cmd: CLI, args: ["mcp", "--agent", "goose"], enabled: true });
  });

  it("switches an existing entry between transports in place", () => {
    syncSelfReportMcp(enabledOpts({ agents: ["codex"] }, false));
    const r = syncSelfReportMcp(enabledOpts({ agents: ["codex"] }, true));
    expect(r[0]).toMatchObject({ action: "updated", transport: "http" });
    const text = read(pathOf("codex"));
    expect(text.match(/\[mcp_servers\.failproofai\]/g)).toHaveLength(1);
    expect(entryIn("codex")).toEqual({ url: "http://127.0.0.1:4319/mcp?agent=codex" });
  });

  it("takes the port from self-report.json", () => {
    const p = resolve(home, ".failproofai", "self-report.json");
    put(p, JSON.stringify({ version: 1, enabled: true, mcp: { port: 5555, url: "http://127.0.0.1:5555/mcp" } }));
    expect(readSelfReportMcpSettings()).toEqual({ enabled: true, port: 5555 });
    syncSelfReportMcp({ quiet: true, agents: ["cursor"], deps: { daemonSocketPresent: () => true, hooksInstalled: () => true } });
    expect(entryIn("cursor")).toEqual({ url: "http://127.0.0.1:5555/mcp?agent=cursor" });
  });

  it("reads a missing or broken settings file as disabled", () => {
    expect(readSelfReportMcpSettings().enabled).toBe(false);
    put(resolve(home, ".failproofai", "self-report.json"), "{nope");
    expect(readSelfReportMcpSettings()).toEqual({ enabled: false, port: 4319 });
  });

  it("reports an error, writing nothing, when stdio is needed and no CLI is known", () => {
    const base = enabledOpts({ agents: ["cursor"] }, false);
    const r = syncSelfReportMcp({ ...base, binaryPath: undefined, deps: { ...base.deps, resolveCliPath: () => null } });
    expect(r[0]).toMatchObject({ status: "error", action: "skipped" });
    expect(existsSync(pathOf("cursor"))).toBe(false);
  });
});

describe("ownership", () => {
  it("never touches a failproofai entry it did not write (e.g. the Cloud MCP gateway)", () => {
    const path = pathOf("claude");
    const foreign = { mcpServers: { failproofai: { type: "http", url: "https://gateway.example.com/mcp" } } };
    put(path, JSON.stringify(foreign, null, 2) + "\n");
    const before = read(path);
    expect(syncSelfReportMcp(enabledOpts({ agents: ["claude"] }))[0]).toMatchObject({ status: "conflict", action: "skipped" });
    expect(removeSelfReportMcp({ agents: ["claude"], quiet: true })[0]).toMatchObject({ status: "conflict" });
    expect(read(path)).toBe(before);
  });

  it("treats a hand-written codex [mcp_servers.failproofai] outside our markers as foreign", () => {
    const path = pathOf("codex");
    put(path, '[mcp_servers.failproofai]\nurl = "http://127.0.0.1:4319/mcp?agent=codex"\n');
    const before = read(path);
    expect(syncSelfReportMcp(enabledOpts({ agents: ["codex"] }))[0].status).toBe("conflict");
    expect(read(path)).toBe(before);
  });

  it("refuses a codex config whose inline mcp_servers table would collide, leaving it as is", () => {
    const path = pathOf("codex");
    put(path, 'mcp_servers = { mine = { command = "node" } }\n');
    const before = read(path);
    const r = syncSelfReportMcp(enabledOpts({ agents: ["codex"] }))[0];
    expect(r.status).toBe("error");
    expect(read(path)).toBe(before);
  });

  it("refuses an unparsable config", () => {
    const path = pathOf("cursor");
    put(path, "{ not json");
    const r = syncSelfReportMcp(enabledOpts({ agents: ["cursor"] }))[0];
    expect(r.status).toBe("error");
    expect(read(path)).toBe("{ not json");
  });

  it("recognises only our shapes", () => {
    expect(isOurMcpEntry({ url: "http://127.0.0.1:4319/mcp?agent=claude" })).toBe(true);
    expect(isOurMcpEntry({ serverUrl: "http://localhost:4319/mcp?agent=antigravity" })).toBe(true);
    expect(isOurMcpEntry({ command: "/x/bin/failproofai", args: ["mcp", "--agent", "pi"] })).toBe(true);
    expect(isOurMcpEntry({ url: "https://gateway.example.com/mcp" })).toBe(false);
    expect(isOurMcpEntry({ command: "/x/bin/failproofai", args: ["--hook", "PreToolUse"] })).toBe(false);
    expect(isOurMcpEntry({ command: "node", args: ["mcp", "--agent", "pi"] })).toBe(false);
  });
});

describe("which agents", () => {
  it("enabled: only hooked agents get an entry; unhooked ones are left alone", () => {
    const r = syncSelfReportMcp(enabledOpts({ deps: { hooksInstalled: (a) => a === "claude" } }));
    expect(r.filter((x) => x.action === "added").map((x) => x.agent)).toEqual(["claude"]);
    expect(r.filter((x) => x.agent !== "claude").every((x) => x.status === "not-hooked")).toBe(true);
    expect(existsSync(pathOf("cursor"))).toBe(false);
  });

  it("alsoHooked registers agents installHooks just wrote", () => {
    const r = syncSelfReportMcp(enabledOpts({ agents: ["cursor"], alsoHooked: ["cursor"], deps: { hooksInstalled: () => false } }));
    expect(r[0].action).toBe("added");
  });

  it("disabled: removes ours from every agent, hooked or not", () => {
    syncSelfReportMcp(enabledOpts({ agents: ["claude", "factory"] }));
    const r = syncSelfReportMcp({ quiet: true, deps: { settings: { enabled: false, port: 4319 }, hooksInstalled: () => false, daemonSocketPresent: () => true } });
    expect(r.filter((x) => x.action === "removed").map((x) => x.agent).sort()).toEqual(["claude", "factory"]);
    expect(entryIn("claude")).toBeUndefined();
  });

  it("writes every Hermes profile", () => {
    put(resolve(home, ".hermes", "config.yaml"), "model: x\n");
    put(resolve(home, ".hermes", "profiles", "work", "config.yaml"), "model: y\n");
    const r = syncSelfReportMcp(enabledOpts({ agents: ["hermes"] }));
    expect(r.map((x) => x.action)).toEqual(["added", "added"]);
    for (const p of [resolve(home, ".hermes", "config.yaml"), resolve(home, ".hermes", "profiles", "work", "config.yaml")]) {
      const doc = parseYaml(read(p)) as { mcp_servers: { failproofai: { url: string } } };
      expect(doc.mcp_servers.failproofai.url).toBe("http://127.0.0.1:4319/mcp?agent=hermes");
      expect(read(p)).toContain("failproofai self-report MCP server");
    }
  });

  it("honours CLAUDE_CONFIG_DIR, CODEX_HOME and COPILOT_HOME", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", resolve(home, "claude-work"));
    vi.stubEnv("CODEX_HOME", resolve(home, "codex-x"));
    vi.stubEnv("COPILOT_HOME", resolve(home, "cop"));
    expect(pathOf("claude")).toBe(resolve(home, "claude-work", ".claude.json"));
    expect(pathOf("codex")).toBe(resolve(home, "codex-x", "config.toml"));
    expect(pathOf("copilot")).toBe(resolve(home, "cop", "mcp-config.json"));
  });

  it("uses OpenCode v2's mcp.servers when the file already has it", () => {
    put(pathOf("opencode"), JSON.stringify({ mcp: { servers: { mine: { type: "local", command: ["node"] } } } }));
    syncSelfReportMcp(enabledOpts({ agents: ["opencode"] }));
    const doc = JSON.parse(read(pathOf("opencode")));
    expect(doc.mcp.servers.failproofai).toEqual({ type: "remote", url: "http://127.0.0.1:4319/mcp?agent=opencode" });
    expect(doc.mcp.failproofai).toBeUndefined();
  });

  it("keeps a backup of the file it changed", () => {
    put(pathOf("factory"), '{"mcpServers":{}}\n');
    syncSelfReportMcp(enabledOpts({ agents: ["factory"] }));
    expect(read(`${pathOf("factory")}.failproofai-backup`)).toBe('{"mcpServers":{}}\n');
  });
});

describe("selfReportRegistrationStatus", () => {
  it("reports registered, transport, conflict and hooked per file without writing", () => {
    syncSelfReportMcp(enabledOpts({ agents: ["claude"] }, false));
    put(pathOf("cursor"), JSON.stringify({ mcpServers: { failproofai: { url: "https://elsewhere" } } }));
    const s = selfReportRegistrationStatus({ agents: ["claude", "cursor", "factory"], hooksInstalled: (a) => a === "claude" });
    expect(s).toEqual([
      expect.objectContaining({ agent: "claude", hooked: true, registered: true, transport: "stdio", conflict: false }),
      expect.objectContaining({ agent: "cursor", hooked: false, registered: false, conflict: true }),
      expect.objectContaining({ agent: "factory", hooked: false, registered: false, conflict: false }),
    ]);
    expect(existsSync(pathOf("factory"))).toBe(false);
  });
});

describe("mergeTomlManagedBlock", () => {
  const M = { begin: "# >>> b >>>", end: "# <<< b <<<" };
  it("appends, replaces in place and removes byte for byte", () => {
    const orig = 'a = 1\n[t]\nb = 2 # c\n';
    const one = mergeTomlManagedBlock(orig, "# >>> b >>>\nx = 1\n# <<< b <<<\n", M);
    expect(one).toBe(`${orig}\n# >>> b >>>\nx = 1\n# <<< b <<<\n`);
    const two = mergeTomlManagedBlock(one, "# >>> b >>>\nx = 2\n# <<< b <<<\n", M);
    expect(two).toContain("x = 2");
    expect(two).not.toContain("x = 1");
    expect(mergeTomlManagedBlock(two, null, M)).toBe(orig);
  });
  it("throws on a half block", () => {
    expect(() => mergeTomlManagedBlock("# >>> b >>>\nx=1\n", null, M)).toThrow();
  });
});
