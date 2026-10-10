// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { runOtelCommand, chooseWizardOtel, OTEL_ORG_OFF, OTEL_WIZARD_QUESTION } from "../../src/hooks/otel-cli";
import { agentConfigPath, editAgentConfig, parseAgentConfig, vscodeSettingsPath, vscodeInstalled, agentOtelWrites } from "../../src/hooks/otel-writers";
import { configFile, credentialsFile, otelAgentStateFile, otelAgentStateDir, otlpSpoolDir, resettablePaths } from "../../src/hooks/fp-home";
import { readConfig, updateConfig } from "../../src/hooks/fp-config";
import { agentSessionsEnabled } from "../../src/hooks/collector-config";
import { introspectKey } from "../../src/hooks/cloud-introspect";

let home: string;
const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ permissions: ["events:add"] })));
const originalEnv = { ...process.env };
const options = () => ({ home, fetchImpl });
function seed(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-otel-test-"));
  process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  delete process.env.FAILPROOFAI_INGEST_KEY;
  delete process.env.FAILPROOFAI_INGEST_URL;
  delete process.env.XDG_CONFIG_HOME;
  seed(credentialsFile(), JSON.stringify({ ingest: { url: "https://cloud.example/v1/events", key: "capture-test-secret" } }));
  seed(configFile(), JSON.stringify({ mode: { kind: "cloud" }, collector: { sessions: false }, future: { keep: true } }));
  fetchImpl.mockReset().mockImplementation(async () => new Response(JSON.stringify({ permissions: ["events:add"] })));
});
afterEach(() => {
  for (const key of ["FAILPROOFAI_HOME", "FAILPROOFAI_INGEST_KEY", "FAILPROOFAI_INGEST_URL", "XDG_CONFIG_HOME"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("managed OTEL settings", () => {
  it("migrations never discard restore credentials or undelivered OTLP batches", () => {
    expect(resettablePaths()).not.toContain(otelAgentStateDir());
    expect(resettablePaths()).not.toContain(otlpSpoolDir());
  });
  it("round-trips Claude byte-equal, backs up once, preserves unknown keys and keeps keys out of config", async () => {
    const path = agentConfigPath("claude", home);
    const before = '{\n "env": {"EXISTING": "yes", "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=old-secret"},\n "hooks": {"keep": true}\n}\n';
    seed(path, before);
    expect((await runOtelCommand(["enable", "claude"], options())).exitCode).toBe(0);
    const enabled = JSON.parse(readFileSync(path, "utf8"));
    expect(enabled.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(enabled.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://cloud.example");
    expect(enabled.env.OTEL_LOG_USER_PROMPTS).toBe("1");
    expect(enabled.env.EXISTING).toBe("yes");
    expect(enabled.hooks).toEqual({ keep: true });
    expect(readFileSync(`${path}.failproofai-bak`, "utf8")).toBe(before);
    const raw = readFileSync(configFile(), "utf8");
    expect(raw).not.toContain("old-secret");
    expect(raw).not.toContain("capture-test-secret");
    expect(statSync(otelAgentStateFile("claude")).mode & 0o777).toBe(0o600);
    expect((await runOtelCommand(["enable", "claude", "--no-content", "--local"], options())).exitCode).toBe(0);
    expect(readFileSync(`${path}.failproofai-bak`, "utf8")).toBe(before);
    expect((await runOtelCommand(["disable", "claude"], options())).exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(configFile(), "utf8")).future).toEqual({ keep: true });
    expect(readConfig().collector.otlp?.enabled).toBe(false);
  });

  it("local Claude writes only documented content flags and never writes auth header variables", async () => {
    const path = agentConfigPath("claude", home);
    const before = '{"env":{"KEEP":"yes"}}\n';
    seed(path, before);
    await runOtelCommand(["enable", "claude", "--local"], options());
    const env = JSON.parse(readFileSync(path, "utf8")).env;
    expect(env.OTEL_LOG_ASSISTANT_RESPONSES).toBeUndefined();
    for (const key of ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_TOOL_DETAILS", "OTEL_LOG_TOOL_CONTENT"]) expect(env[key]).toBe("1");
    expect(Object.keys(env).some(key => key.endsWith("_HEADERS"))).toBe(false);
    expect(agentOtelWrites("claude", "http://127.0.0.1:4318", "key", true, true)
      .some(write => write.path.some(key => key.endsWith("_HEADERS")))).toBe(false);
    await runOtelCommand(["disable", "claude"], options());
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("Cloud-to-local Claude restores prior headers and stops owning them", async () => {
    const path = agentConfigPath("claude", home);
    const before = '{"env":{"OTEL_EXPORTER_OTLP_HEADERS":"Authorization=prior","OTEL_EXPORTER_OTLP_LOGS_HEADERS":"custom=prior"}}\n';
    seed(path, before);
    await runOtelCommand(["enable", "claude"], options());
    await runOtelCommand(["enable", "claude", "--local"], options());
    expect(JSON.parse(readFileSync(path, "utf8")).env).toMatchObject({
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=prior", OTEL_EXPORTER_OTLP_LOGS_HEADERS: "custom=prior",
    });
    const record = JSON.parse(readFileSync(configFile(), "utf8")).otel.agents.claude;
    expect(record.keys.some((key: { path: string[] }) => key.path.some(p => p.endsWith("_HEADERS")))).toBe(false);
    await runOtelCommand(["disable", "claude"], options());
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("restores only owned keys after unrelated Claude changes", async () => {
    const path = agentConfigPath("claude", home);
    seed(path, '{"env":{"KEEP":"x","OTEL_LOG_USER_PROMPTS":"old"},"theme":"old"}');
    await runOtelCommand(["enable", "claude"], options());
    const changed = JSON.parse(readFileSync(path, "utf8"));
    changed.theme = "new";
    changed.env.NEW_KEY = "keep";
    writeFileSync(path, JSON.stringify(changed));
    await runOtelCommand(["disable", "claude"], options());
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      env: { KEEP: "x", OTEL_LOG_USER_PROMPTS: "old", NEW_KEY: "keep" }, theme: "new",
    });
  });

  it("re-enabling after unrelated edits preserves them on disable and status still recognizes owned keys", async () => {
    const path = agentConfigPath("claude", home);
    seed(path, '{"theme":"old"}\n');
    await runOtelCommand(["enable", "claude"], options());
    const changed = JSON.parse(readFileSync(path, "utf8"));
    changed.theme = "new";
    writeFileSync(path, JSON.stringify(changed));
    expect((await runOtelCommand(["status"], options())).lines.join("\n")).toContain("Claude Code: on by failproofai");
    await runOtelCommand(["enable", "claude", "--no-content"], options());
    await runOtelCommand(["disable", "claude"], options());
    expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("new");
  });

  it("Codex changes only OTEL table regions with comments, nested exporter tables and multiline strings", async () => {
    const path = agentConfigPath("codex", home);
    const prefix = '# user config\nmodel = "test"\nprompt = """\n[not_a_table]\n"""\n[projects."/work"] # trust\ntrust_level = "trusted"\n\n';
    const otel = '# OTEL\n[otel] # existing\nlog_user_prompt = false\nenvironment = "keep"\n[otel.exporter.otlp-http]\nendpoint = "http://old/v1/logs"\nprotocol = "json"\n';
    const suffix = '# introduces MCP table\n\n[mcp_servers.keep]\n# comment kept\ncommand = "keep"\n';
    const before = prefix + otel + suffix;
    seed(path, before);
    const result = await runOtelCommand(["enable", "codex"], options());
    expect(result.exitCode, result.lines.join("\n")).toBe(0);
    const next = readFileSync(path, "utf8");
    expect(next.startsWith(prefix + "# OTEL\n")).toBe(true);
    expect(next).toContain("[otel] # existing\n");
    expect(next.endsWith(suffix)).toBe(true);
    const parsed = parseAgentConfig(next, "codex");
    expect(parsed.otel).toMatchObject({
      environment: "keep",
      exporter: { "otlp-http": { endpoint: "https://cloud.example/v1/logs", headers: { Authorization: "Bearer capture-test-secret" } } },
      trace_exporter: { "otlp-http": { endpoint: "https://cloud.example/v1/traces" } },
    });
    await runOtelCommand(["disable", "codex"], options());
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("Codex supports quoted OTEL headers, CRLF, no final newline; refuses root assignments and malformed files", () => {
    const writes = agentOtelWrites("codex", "http://127.0.0.1:4318", "", true, false);
    const before = 'model="x"\r\n["otel"]\r\nlog_user_prompt=true\r\n[other]\r\nvalue=1';
    const next = editAgentConfig(before, "codex", writes);
    expect(next.startsWith('model="x"\r\n')).toBe(true);
    expect(next.endsWith("[other]\r\nvalue=1")).toBe(true);
    expect(() => editAgentConfig('otel = {log_user_prompt=true}\n', "codex", writes)).toThrow("root dotted");
    expect(() => editAgentConfig("[broken", "codex", writes)).toThrow();
  });

  it("local Codex omits headers from all exporters and restores original config bytes", async () => {
    const path = agentConfigPath("codex", home);
    const before = '# kept\n[otel] # old config\nexporter = { otlp-http = { endpoint="https://old/v1/logs", protocol="json", headers={Authorization="Bearer old"} } }\n[other]\nkey="kept"\n';
    seed(path, before);
    const enabled = await runOtelCommand(["enable", "codex", "--local"], options());
    expect(enabled.exitCode, enabled.lines.join("\n")).toBe(0);
    const text = readFileSync(path, "utf8");
    const parsed = parseAgentConfig(text, "codex").otel as Record<string, { "otlp-http": Record<string, unknown> }>;
    for (const name of ["exporter", "trace_exporter", "metrics_exporter"]) {
      expect(parsed[name]["otlp-http"]).not.toHaveProperty("headers");
      expect(parsed[name]["otlp-http"].endpoint).toContain("http://127.0.0.1:4318/v1/");
    }
    expect(text).not.toContain("headers");
    expect((await runOtelCommand(["disable", "codex"], options())).exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it.each(["gemini", "copilot"] as const)("writes %s with automatic auth-free relay and restores JSONC byte-equal", async agent => {
    const path = agentConfigPath(agent, home);
    const before = '{\n// user comment\n"editor.fontSize": 13,\n"telemetry": {"unknown": 42},\n}\n';
    seed(path, before);
    if (agent === "copilot") mkdirSync(join(home, ".vscode/extensions/github.copilot-chat-0.55.0"), { recursive: true });
    const result = await runOtelCommand(["enable", agent, "--no-content"], options());
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("automatically");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("// user comment");
    expect(text).not.toContain("capture-test-secret");
    expect(text).toContain("127.0.0.1:4318");
    const parsed = parseAgentConfig(text, agent);
    expect(agent === "gemini" ? (parsed.telemetry as Record<string, unknown>).logPrompts : parsed["github.copilot.chat.otel.captureContent"]).toBe(false);
    expect(readConfig().collector.otlp?.enabled).toBe(true);
    await runOtelCommand(["disable", agent], options());
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("skips VS Code when absent and resolves macOS, Linux and Windows user paths", async () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      mkdirSync(dirname(agentConfigPath("copilot", home)), { recursive: true });
      const before = readFileSync(configFile(), "utf8");
      expect((await runOtelCommand(["enable", "copilot"], options())).lines).toEqual(["VS Code not found — skipping copilot"]);
      expect(readFileSync(configFile(), "utf8")).toBe(before);
      expect(vscodeInstalled(home)).toBe(false);
    } finally { process.env.PATH = savedPath; }
    expect(existsSync(agentConfigPath("copilot", home))).toBe(false);
    expect(vscodeSettingsPath(home, "darwin")).toContain("Library/Application Support/Code/User/settings.json");
    expect(vscodeSettingsPath(home, "linux")).toContain(".config/Code/User/settings.json");
    const before = process.env.APPDATA;
    process.env.APPDATA = join(home, "Roaming");
    expect(vscodeSettingsPath(home, "win32")).toBe(join(home, "Roaming/Code/User/settings.json"));
    if (before === undefined) delete process.env.APPDATA; else process.env.APPDATA = before;
  });

  it("detects an executable or Copilot extension, not an unrelated extension", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      mkdirSync(join(home, ".vscode/extensions/unrelated.extension-1.0"), { recursive: true });
      expect(vscodeInstalled(home)).toBe(false);
      mkdirSync(join(home, ".vscode/extensions/github.copilot-1.0"), { recursive: true });
      expect(vscodeInstalled(home)).toBe(true);
      rmSync(join(home, ".vscode"), { recursive: true });
      const bin = join(home, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "code-insiders"), "#!/bin/sh\n", { mode: 0o755 });
      process.env.PATH = bin;
      expect(vscodeInstalled(home)).toBe(true);
    } finally { process.env.PATH = savedPath; }
  });

  it("never overwrites an invalid config or creates a backup for it", async () => {
    const path = agentConfigPath("claude", home);
    seed(path, "{ invalid json");
    expect((await runOtelCommand(["enable", "claude"], options())).exitCode).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("{ invalid json");
    expect(existsSync(`${path}.failproofai-bak`)).toBe(false);
  });
});

describe("opt-in, one path and status", () => {
  it("one-path question defaults No; --yes sets only Claude override and disable restores absence", async () => {
    updateConfig({ collector: { sessions: true } });
    const path = agentConfigPath("claude", home);
    const question = vi.fn(async () => false);
    await runOtelCommand(["enable", "claude"], { ...options(), confirm: question });
    expect(question).toHaveBeenCalledWith("failproofai already sends Claude Code sessions to Cloud. Send them with OTEL instead? Transcript upload for Claude Code stops.");
    expect(existsSync(path)).toBe(false);
    // Real non-TTY prompt has the conservative default, too.
    await runOtelCommand(["enable", "claude"], options());
    expect(existsSync(path)).toBe(false);
    await runOtelCommand(["enable", "claude", "--yes"], options());
    expect(agentSessionsEnabled("claude")).toBe(false);
    expect(agentSessionsEnabled("codex")).toBe(true);
    updateConfig({ telemetry: { enabled: false } });
    expect(agentSessionsEnabled("claude")).toBe(false);
    await runOtelCommand(["disable", "claude"], options());
    expect(readConfig().collector.agents?.claude?.sessions).toBeUndefined();
    expect(agentSessionsEnabled("claude")).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("Gemini has no transcript source and does not ask a misleading switch question", async () => {
    updateConfig({ collector: { sessions: true } });
    const confirm = vi.fn(async () => false);
    const result = await runOtelCommand(["enable", "gemini"], { ...options(), confirm });
    expect(result.exitCode).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(readConfig().collector.agents?.gemini).toBeUndefined();
  });

  it("restores explicit sessions override and keeps relay on until last local agent disables", async () => {
    updateConfig({ collector: { agents: { claude: { sessions: true } }, otlp: { enabled: false, port: 14318 } } });
    await runOtelCommand(["enable", "claude", "--yes", "--local"], options());
    await runOtelCommand(["enable", "gemini"], options());
    await runOtelCommand(["disable", "claude"], options());
    expect(readConfig().collector.agents?.claude?.sessions).toBe(true);
    expect(readConfig().collector.otlp?.enabled).toBe(true);
    await runOtelCommand(["disable", "gemini"], options());
    expect(readConfig().collector.otlp?.enabled).toBe(false);
  });

  it("status shows all agents, Cloud/local, relay, last upload and unknown for old introspect", async () => {
    await runOtelCommand(["enable", "claude"], options());
    await runOtelCommand(["enable", "gemini"], options());
    const result = await runOtelCommand(["status"], options());
    const output = result.lines.join("\n");
    for (const agent of ["Claude Code", "Codex", "Gemini CLI", "Copilot"]) expect(output).toContain(agent);
    expect(output).toContain("on by failproofai");
    expect(output).toContain("https://cloud.example");
    expect(output).toContain("http://127.0.0.1:4318");
    expect(output).toContain("org: unknown");
    expect(output).toContain("Relay:");
    expect(output).toContain("last upload: none");
    const identity = await introspectKey("https://cloud.example", "key", fetchImpl);
    expect(identity.kind === "ok" && identity.identity.otelIngest).toBeUndefined();
  });

  it("status uses recorded relay mode, not a loopback Cloud hostname", async () => {
    process.env.FAILPROOFAI_INGEST_URL = "http://127.0.0.1:18765/v1/events";
    await runOtelCommand(["enable", "codex"], options());
    let line = (await runOtelCommand(["status"], options())).lines.find(line => line.startsWith("Codex:"));
    expect(line).toContain("destination: Cloud (http://127.0.0.1:18765)");
    expect(line).not.toContain("local relay");
    await runOtelCommand(["enable", "codex", "--local"], options());
    line = (await runOtelCommand(["status"], options())).lines.find(line => line.startsWith("Codex:"));
    expect(line).toContain("destination: local relay (http://127.0.0.1:4318)");
  });

  it("reports unmanaged OTEL and warns but writes when org ingest is off", async () => {
    seed(agentConfigPath("codex", home), '[otel]\nexporter = { "otlp-http" = { endpoint="http://external/v1/logs", protocol="json" } }\n');
    expect((await runOtelCommand(["status"], options())).lines.join("\n")).toContain("Codex: on, not managed");
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ permissions: ["events:add"], otel_ingest: false })));
    const result = await runOtelCommand(["enable", "claude"], options());
    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain(OTEL_ORG_OFF);
    expect((await runOtelCommand(["status"], options())).lines.join("\n")).toContain("org: off");
  });

  it("missing key errors before writes; env is shell-safe and has the correct protocol/header", async () => {
    const result = await runOtelCommand(["env", "--service", "service's name"], options());
    expect(result.lines.join("\n")).toContain("http/protobuf");
    expect(result.lines.join("\n")).toContain("Authorization=Bearer%20capture-test-secret");
    expect(result.lines.join("\n")).toContain("'service'\\''s name'");
    expect((await runOtelCommand(["env", "--local"], options())).lines.join("\n")).not.toContain("capture-test-secret");
    rmSync(credentialsFile());
    const error = await runOtelCommand(["enable", "claude"], options());
    expect(error.exitCode).toBe(1);
    expect(error.lines.join("\n")).toContain("failproofai config");
    expect(existsSync(agentConfigPath("claude", home))).toBe(false);
  });

  it("wizard question defaults No and uses the shared enable entry point", async () => {
    expect(await chooseWizardOtel()).toBe(false);
    const choose = vi.fn(async () => true);
    expect(await chooseWizardOtel(choose)).toBe(true);
    expect(choose).toHaveBeenCalledWith(OTEL_WIZARD_QUESTION);
    const source = readFileSync(join(__dirname, "../../src/hooks/configure-wizard.ts"), "utf8");
    expect(source).toContain('runOtelCommand(["enable", agent]');
    expect(source).toContain("!unattended && !preAnswered");
  });

  it("analytics properties contain only agent, local and content", async () => {
    const onEvent = vi.fn();
    await runOtelCommand(["enable", "claude", "--local", "--no-content"], { ...options(), onEvent });
    await runOtelCommand(["disable", "claude"], { ...options(), onEvent });
    expect(onEvent.mock.calls).toEqual([
      ["otel_enabled", { agent: "claude", local: true, content: false }],
      ["otel_disabled", { agent: "claude", local: true, content: false }],
    ]);
  });

  it.each([{ args: [] }, { args: ["enable"] }, { args: ["disable"] }, { args: ["status"] }, { args: ["env"] }])("real CLI help $args follows harness section style", ({ args }) => {
    const result = spawnSync("bun", ["bin/failproofai.mjs", "otel", ...args, "--help"], {
      cwd: join(__dirname, "../.."), env: { ...process.env, HOME: home, FAILPROOFAI_TELEMETRY_DISABLED: "1" },
      encoding: "utf8", timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("otel");
    expect(result.stdout.toLowerCase()).toContain("usage");
    expect(result.stdout.toLowerCase()).toContain("notes");
  });

  it.each([
    { verb: "status", flags: [] },
    { verb: "enable", flags: ["--local", "--no-content", "--yes"] },
    { verb: "disable", flags: [] },
    { verb: "env", flags: ["--service", "--local"] },
  ])("$verb help mentions only flags that verb accepts", ({ verb, flags }) => {
    const result = spawnSync("bun", ["bin/failproofai.mjs", "otel", verb, "--help"], {
      cwd: join(__dirname, "../.."), env: { ...process.env, HOME: home, FAILPROOFAI_TELEMETRY_DISABLED: "1" },
      encoding: "utf8", timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(0);
    for (const flag of ["--local", "--no-content", "--yes", "--service"]) {
      if (flags.includes(flag)) expect(result.stdout).toContain(flag);
      else expect(result.stdout).not.toContain(flag);
    }
  });
});
