// @vitest-environment node
/**
 * Self Reports: the shared text, names and settings (src/hooks/self-report.ts),
 * the stdio MCP server spawned for real (`failproofai mcp`), and the
 * `self-report status | enable | disable` commands.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_CATEGORIES,
  SELF_REPORT_SERVER_RECORDS,
  describe as describeTool,
  inputSchema,
  isSelfReportToolName,
  readEffectiveSelfReport,
  resolveSelfReport,
  selfReportArgs,
  selfReportCloudEnrolled,
  selfReportCloudManaged,
  validateSelfReportCategories,
  validateSelfReportGuidance,
  writeEffectiveSelfReport,
  selfReportInstructions,
} from "../../src/hooks/self-report";
import {
  handleSelfReportRpc,
  selfReportAgentId,
  selfReportCwdAffinity,
  selfReportFindSession,
  selfReportFindSessionMatch,
} from "../../src/hooks/self-report-mcp";
import { runSelfReportCommand } from "../../src/hooks/self-report-cli";

const BINARY = resolve(__dirname, "..", "..", "bin", "failproofai.mjs");

const EXPECTED_DESCRIPTION = `Report to FailproofAI that you are blocked. Call this BEFORE your final answer whenever something stops you that you cannot fix yourself, for example a missing, invalid or expired token or API key, a 401 or 403, a command, tool or MCP server that keeps failing, information or access you cannot get, or a request you cannot do here. Do not call it for normal work, clarifying questions or an error you then fixed. One call per distinct problem.
Reporting does not unblock you and changes no decision: afterwards, work around the problem or tell the user what is blocking you. There is no need to mention this report to the user.

Categories:
- looping: You keep repeating the same or circular steps without making progress.
- cannot_do_request: The user asked for something you cannot do here: a missing capability, tool or permission, or it is only possible by cheating.
- invalid_tool_or_credential: A tool, MCP server, plugin, API key or token you need is broken, invalid, expired or rejected.
- missing_context: Information or access you need is missing and you cannot get it yourself. Not for normal clarifying questions.
- repeated_tool_failure: A command or tool failed on several distinct attempts and is blocking you. A single error is not enough.
- task_failure: You genuinely tried and could not complete the task. Not for refusals or policy blocks.`;

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-sr-"));
  for (const k of ["FAILPROOFAI_HOME", "FAILPROOFAI_CLOUD_URL", "FAILPROOFAI_CLOUD_CREDENTIALS", "FAILPROOFAI_SELF_REPORT_PORT"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("tool text and schema (contract §3)", () => {
  it("describe() produces the exact contract text for the defaults", () => {
    expect(describeTool(DEFAULT_CATEGORIES)).toBe(EXPECTED_DESCRIPTION);
  });

  it("appends guidance after a blank line, and only when there is some", () => {
    expect(describeTool(DEFAULT_CATEGORIES, "Report tracker outages.")).toBe(`${EXPECTED_DESCRIPTION}\n\nReport tracker outages.`);
    expect(describeTool(DEFAULT_CATEGORIES, null)).toBe(EXPECTED_DESCRIPTION);
    expect(describeTool(DEFAULT_CATEGORIES, "")).toBe(EXPECTED_DESCRIPTION);
  });

  it("inputSchema() is the contract schema with the category names as the enum", () => {
    expect(inputSchema([{ name: "a", description: "x" }, { name: "b_2", description: "y" }])).toEqual({
      type: "object",
      properties: {
        category: { type: "string", enum: ["a", "b_2"] },
        detail: { type: "string", description: "One factual sentence: what is blocking you." },
      },
      required: ["category", "detail"],
      additionalProperties: false,
    });
  });

  it("selfReportArgs keeps unknown categories, defaults detail to empty, cuts at 2000, and unwraps arguments", () => {
    expect(selfReportArgs({ category: "nope" })).toEqual({ category: "nope", detail: "" });
    expect(selfReportArgs({ category: "looping", detail: "z".repeat(3000) }).detail).toHaveLength(2000);
    expect(selfReportArgs({ arguments: { category: "looping", detail: "d" } })).toEqual({ category: "looping", detail: "d" });
    expect(selfReportArgs({ arguments: '{"category":"looping","detail":"s"}' })).toEqual({ category: "looping", detail: "s" });
    expect(selfReportArgs(undefined)).toEqual({ category: "", detail: "" });
  });
});

describe("tool-name matching (contract §1)", () => {
  it.each(["mcp__failproofai_local__report", "failproofai_local__report", "failproofai_report", "failproofai_local.report", "failproofai_local/report", "MCP__FAILPROOFAI_LOCAL__REPORT"])(
    "matches %s",
    (name) => expect(isSelfReportToolName(name)).toBe(true),
  );
  it.each(["report", "mcp__other__report", "mcp__failproofai__report", "failproofai__report", "mcp__failproofai_local__report2", "xfailproofai_report", "Bash", "", undefined, 7])(
    "does not match %s",
    (name) => expect(isSelfReportToolName(name)).toBe(false),
  );
  it("lists the server-recorded integrations from the contract", () => {
    expect(SELF_REPORT_SERVER_RECORDS).toEqual([
      "openclaw", "pi", "devin", "hermes", "goose", "factory", "antigravity", "copilot", "opencode", "cursor",
    ]);
    for (const hookRecorded of ["claude", "codex"]) expect(SELF_REPORT_SERVER_RECORDS).not.toContain(hookRecorded);
  });
});

describe("validation (contract §2)", () => {
  it("accepts the defaults", () => {
    expect(validateSelfReportCategories(DEFAULT_CATEGORIES).ok).toBe(true);
  });
  it.each([
    [[], "empty"],
    [Array.from({ length: 33 }, (_, i) => ({ name: `c${i}`, description: "d" })), "too many"],
    [[{ name: "Bad", description: "d" }], "uppercase name"],
    [[{ name: "a".repeat(65), description: "d" }], "long name"],
    [[{ name: "ok", description: "" }], "empty description"],
    [[{ name: "ok", description: "x".repeat(501) }], "long description"],
    [[{ name: "ok", description: "a" }, { name: "ok", description: "b" }], "duplicate"],
    ["nope", "not a list"],
  ])("rejects %j (%s)", (input, _label) => {
    expect(validateSelfReportCategories(input).ok).toBe(false);
  });
  it("guidance: at most 2000 characters, blank is none", () => {
    expect(validateSelfReportGuidance("x".repeat(2000)).ok).toBe(true);
    expect(validateSelfReportGuidance("x".repeat(2001)).ok).toBe(false);
    expect(validateSelfReportGuidance("  ")).toEqual({ ok: true, value: null });
  });
});

describe("self-report.json (contract §4)", () => {
  it("missing or unparsable reads as disabled (null)", () => {
    expect(readEffectiveSelfReport()).toBeNull();
    writeFileSync(join(home, "self-report.json"), "{not json");
    expect(readEffectiveSelfReport()).toBeNull();
    writeFileSync(join(home, "self-report.json"), JSON.stringify({ version: 2, enabled: true }));
    expect(readEffectiveSelfReport()).toBeNull();
  });

  it("writes atomically at 0644 with the contract shape, and reads back", () => {
    process.env.FAILPROOFAI_SELF_REPORT_PORT = "4400";
    writeEffectiveSelfReport({ enabled: true, guidance: "g" });
    const path = join(home, "self-report.json");
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw).toMatchObject({
      version: 1,
      enabled: true,
      source: "local",
      guidance: "g",
      mcp: { port: 4400, url: "http://127.0.0.1:4400/mcp" },
    });
    expect(raw.categories).toEqual(DEFAULT_CATEGORIES);
    expect(raw.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readEffectiveSelfReport()).toMatchObject({ enabled: true, source: "local", guidance: "g" });
  });

  it("an enabled file with an unusable category list falls back to the defaults", () => {
    writeFileSync(join(home, "self-report.json"), JSON.stringify({ version: 1, enabled: true, source: "cloud", categories: [] }));
    expect(readEffectiveSelfReport()).toMatchObject({ enabled: true, source: "cloud", categories: DEFAULT_CATEGORIES });
  });
});

describe("resolveSelfReport: on by default (contract §4)", () => {
  const enrolled = () => true;
  const oss = () => false;
  it("a missing file is on with the defaults off Cloud, and off on Cloud", () => {
    expect(resolveSelfReport(undefined, oss)).toMatchObject({ enabled: true, source: "local", categories: DEFAULT_CATEGORIES, guidance: null });
    expect(resolveSelfReport(undefined, enrolled)).toBeNull();
  });
  it("an explicit local off in config.json wins over the default", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ selfReport: { enabled: false } }));
    expect(resolveSelfReport(undefined, oss)).toBeNull();
    writeFileSync(join(home, "config.json"), JSON.stringify({ selfReport: { categories: [] } }));
    expect(resolveSelfReport(undefined, oss)?.enabled).toBe(true);
  });
  it("a present file decides, and a malformed one is off", () => {
    writeEffectiveSelfReport({ enabled: false });
    expect(resolveSelfReport(undefined, oss)?.enabled).toBe(false);
    writeFileSync(join(home, "self-report.json"), "{not json");
    expect(resolveSelfReport(undefined, oss)).toBeNull();
    expect(resolveSelfReport(undefined, enrolled)).toBeNull();
  });
});

describe("settings-cases.golden.json: the same on/off as the daemon's readers", () => {
  const fixture = JSON.parse(
    readFileSync(resolve(__dirname, "..", "..", "test-fixtures", "self-report", "settings-cases.golden.json"), "utf8"),
  ) as { cases: { name: string; file?: unknown; text?: string; enrolled: boolean; on: boolean }[] };
  for (const c of fixture.cases) {
    it(c.name, () => {
      const path = join(home, "self-report.json");
      if (c.text !== undefined) writeFileSync(path, c.text);
      else if (c.file !== null && c.file !== undefined) writeFileSync(path, JSON.stringify(c.file, null, 2));
      expect(resolveSelfReport(path, () => c.enrolled)?.enabled === true).toBe(c.on);
    });
  }
});

describe("enrolling with a local settings file in place", () => {
  it("sets this machine's own file aside until the daemon writes the org's setting", async () => {
    writeEffectiveSelfReport({ enabled: true });
    expect(resolveSelfReport()?.enabled).toBe(true);
    // Enrolled now; the daemon's first poll has not been applied yet.
    process.env.FAILPROOFAI_CLOUD_URL = "https://cloud.example.invalid";
    expect(resolveSelfReport()).toBeNull();
    // Every reader agrees: the stdio server hides the tool, the hook records nothing.
    const listed = await handleSelfReportRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((listed as { result: { tools: unknown[] } }).result.tools).toEqual([]);
    const status = await runSelfReportCommand(["status"], { registrations: () => [], probeEndpoint: async () => false, daemonExpected: () => false });
    expect(status.lines[0]).toContain("off (waiting for FailproofAI Cloud");
    // The org's setting arrives (the daemon writes a cloud file): it decides.
    const cloud = { ...JSON.parse(readFileSync(join(home, "self-report.json"), "utf8")), source: "cloud", enabled: true };
    writeFileSync(join(home, "self-report.json"), JSON.stringify(cloud));
    expect(resolveSelfReport()?.enabled).toBe(true);
    writeFileSync(join(home, "self-report.json"), JSON.stringify({ ...cloud, enabled: false }));
    expect(resolveSelfReport()?.enabled).toBe(false);
  });
});

describe("selfReportCloudEnrolled (sync, the daemon's Enrolment::resolve)", () => {
  it("follows the env, the credential files and the oss veto", () => {
    expect(selfReportCloudEnrolled()).toBe(false);
    writeFileSync(join(home, "credentials.json"), JSON.stringify({ ingest: { key: "k" } }));
    expect(selfReportCloudEnrolled()).toBe(false);
    writeFileSync(join(home, "credentials.json"), JSON.stringify({ cloud: { url: "https://x", machine_id: "m", token: "t" } }));
    expect(selfReportCloudEnrolled()).toBe(true);
    writeFileSync(join(home, "credentials.json"), "{broken");
    expect(selfReportCloudEnrolled()).toBe(true);
    writeFileSync(join(home, "config.json"), JSON.stringify({ mode: { kind: "oss" } }));
    expect(selfReportCloudEnrolled()).toBe(false);
    process.env.FAILPROOFAI_CLOUD_URL = "https://example.invalid";
    expect(selfReportCloudEnrolled()).toBe(true);
    delete process.env.FAILPROOFAI_CLOUD_URL;
    rmSync(join(home, "config.json"));
    rmSync(join(home, "credentials.json"));
    writeFileSync(join(home, "cloud.json"), JSON.stringify({ schemaVersion: 1 }));
    expect(selfReportCloudEnrolled()).toBe(true);
  });
});

describe("Cloud enrolment", () => {
  it("is off with no credential, on with FAILPROOFAI_CLOUD_URL", async () => {
    expect(await selfReportCloudManaged()).toBe(false);
    process.env.FAILPROOFAI_CLOUD_URL = "https://example.invalid";
    expect(await selfReportCloudManaged()).toBe(true);
  });

  it("is on with a stored cloud credential, off again once config says oss", async () => {
    const creds = join(home, "cloud-creds.json");
    writeFileSync(creds, JSON.stringify({ schemaVersion: 1, url: "https://example.invalid", machineId: "m", token: "t" }));
    process.env.FAILPROOFAI_CLOUD_CREDENTIALS = creds;
    expect(await selfReportCloudManaged()).toBe(true);
    writeFileSync(join(home, "config.json"), JSON.stringify({ mode: { kind: "oss" } }));
    expect(await selfReportCloudManaged()).toBe(false);
  });
});

describe("MCP fallback recording helpers", () => {
  it("agent id mirrors the collector's <integration>-<project>", () => {
    expect(selfReportAgentId("pi", "/home/u/My Repo/")).toBe("pi-My-Repo");
    expect(selfReportAgentId("hermes", undefined)).toBe("hermes");
  });

  it("finds the newest session for the agent and cwd within 6 h", () => {
    const now = 1_800_000_000_000;
    mkdirSync(join(home, "hook-activity"), { recursive: true });
    const row = (o: Record<string, unknown>) => JSON.stringify({ eventType: "PreToolUse", decision: "allow", ...o });
    writeFileSync(
      join(home, "hook-activity", "current.jsonl"),
      [
        row({ integration: "pi", cwd: "/p", sessionId: "old", timestamp: now - 7 * 3600_000 }),
        row({ integration: "pi", cwd: "/p", sessionId: "s1", timestamp: now - 3600_000 }),
        row({ integration: "pi", cwd: "/p", sessionId: "s2", timestamp: now - 60_000 }),
        row({ integration: "pi", cwd: "/other", sessionId: "wrong-cwd", timestamp: now }),
        row({ integration: "goose", cwd: "/p", sessionId: "wrong-agent", timestamp: now }),
      ].join("\n") + "\n",
    );
    expect(selfReportFindSession("pi", "/p", now)).toBe("s2");
    // No row in or around this cwd, and pi's rows are in two projects: a guess
    // across projects is refused.
    expect(selfReportFindSession("pi", "/nowhere", now)).toBeNull();
    // ...but goose has one project in the window, so its newest session is it.
    expect(selfReportFindSession("goose", "/nowhere", now)).toBe("wrong-agent");
    expect(selfReportFindSession("hermes", "/p", now)).toBeNull();
    expect(selfReportFindSession("pi", "/p", now + 10 * 3600_000)).toBeNull();
  });

  it("prefers an exact cwd, then an ancestor or descendant, then any session, and returns the row's cwd", () => {
    const now = 1_800_000_000_000;
    mkdirSync(join(home, "hook-activity"), { recursive: true });
    const row = (o: Record<string, unknown>) => JSON.stringify({ eventType: "PreToolUse", decision: "allow", integration: "hermes", ...o });
    writeFileSync(
      join(home, "hook-activity", "current.jsonl"),
      [
        row({ cwd: "/root/.hermes/hermes-agent", sessionId: "below", timestamp: now - 5000 }),
        row({ cwd: "/srv/elsewhere", sessionId: "unrelated-newest", timestamp: now - 10 }),
        row({ cwd: "/", sessionId: "root-row", timestamp: now - 9000 }),
      ].join("\n") + "\n",
    );
    // Server in /root, the agent's rows below it: the descendant wins over a newer unrelated one.
    expect(selfReportFindSessionMatch("hermes", "/root", now)).toEqual({ sessionId: "below", cwd: "/root/.hermes/hermes-agent" });
    // `/` is an ancestor of everything; the newest related row wins.
    expect(selfReportFindSessionMatch("hermes", "/srv/elsewhere/sub", now)?.sessionId).toBe("unrelated-newest");
    expect(selfReportFindSessionMatch("hermes", "/srv/elsewhere/", now)?.sessionId).toBe("unrelated-newest");
    // Nothing related except `/`, which counts as an ancestor.
    expect(selfReportFindSessionMatch("hermes", "/work/ws", now)?.sessionId).toBe("root-row");
    expect(selfReportCwdAffinity("/a/b", "/a/bc")).toBe(0);
    expect(selfReportCwdAffinity("/a/b", "/a/b/")).toBe(2);
    expect(selfReportCwdAffinity("/a/b", "/a")).toBe(1);
    expect(selfReportCwdAffinity("/a/b", undefined)).toBe(0);
  });

  it("finds a project's session behind many pages of another project's hook activity", () => {
    // Project A's session started, then 80 events in project B rotated A's row
    // several pages back. The report from A's cwd still lands on A.
    const now = 1_800_000_000_000;
    const dir = join(home, "hook-activity");
    mkdirSync(dir, { recursive: true });
    const row = (o: Record<string, unknown>) =>
      JSON.stringify({ eventType: "PreToolUse", decision: "allow", integration: "copilot", ...o });
    let t = now - 3600_000;
    writeFileSync(join(dir, `page-${t + 1}-0.jsonl`), row({ cwd: "/work/a", sessionId: "sess-A", timestamp: t }) + "\n");
    for (let page = 1; page <= 4; page++) {
      const lines: string[] = [];
      for (let i = 0; i < 20; i++) lines.push(row({ cwd: "/work/b", sessionId: "sess-B", timestamp: (t += 1000) }));
      writeFileSync(join(dir, `page-${t + 1}-${page}.jsonl`), lines.join("\n") + "\n");
    }
    writeFileSync(join(dir, "current.jsonl"), row({ cwd: "/work/b", sessionId: "sess-B", timestamp: (t += 1000) }) + "\n");
    expect(selfReportFindSessionMatch("copilot", "/work/a", now)).toEqual({ sessionId: "sess-A", cwd: "/work/a" });
    expect(selfReportFindSessionMatch("copilot", "/work/b", now)?.sessionId).toBe("sess-B");
    // A third, unrelated cwd: two projects to choose from, so unattributed rather than B.
    expect(selfReportFindSessionMatch("copilot", "/work/c", now)).toBeNull();
  });

  it("does not read pages rotated before the window opened", () => {
    const now = 1_800_000_000_000;
    const dir = join(home, "hook-activity");
    mkdirSync(dir, { recursive: true });
    const old = now - 8 * 3600_000;
    writeFileSync(
      join(dir, `page-${old}-0.jsonl`),
      JSON.stringify({ eventType: "PreToolUse", integration: "pi", cwd: "/p", sessionId: "stale", timestamp: old - 1 }) + "\n",
    );
    expect(selfReportFindSessionMatch("pi", "/p", now)).toBeNull();
  });

  it("files a fallback report under the matched row's agent, not the server's cwd", async () => {
    writeEffectiveSelfReport({ enabled: true });
    const now = Date.now();
    mkdirSync(join(home, "hook-activity"), { recursive: true });
    writeFileSync(
      join(home, "hook-activity", "current.jsonl"),
      JSON.stringify({ timestamp: now - 1000, eventType: "PreToolUse", integration: "openclaw", cwd: "/root/.openclaw/workspace", sessionId: "oc-1", decision: "allow" }) + "\n",
    );
    const reply = await handleSelfReportRpc(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report", arguments: { category: "looping", detail: "d" } } },
      { agent: "openclaw", cwd: "/work/ws", now: () => now },
    );
    expect(reply).toMatchObject({ result: { content: [{ text: "Recorded." }] } });
    const dir = join(home, "custom-agents", "events");
    const [file] = readdirSync(dir);
    const event = JSON.parse(readFileSync(join(dir, file), "utf8").trim());
    expect(event).toMatchObject({ session_id: "oc-1", agent_id: "openclaw-workspace", integration: "openclaw" });
  });

  it("an unknown method gets -32601; a notification gets no reply; an unknown tool is an error result", async () => {
    expect(await handleSelfReportRpc({ jsonrpc: "2.0", id: 9, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await handleSelfReportRpc({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await handleSelfReportRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "other" } })).toMatchObject({
      result: { isError: true },
    });
  });
});

/** Spawn `failproofai mcp`, send these messages, collect the replies. */
function runMcp(agentArgs: string[], messages: unknown[], cwd: string): Promise<{ replies: Array<Record<string, unknown>>; code: number | null; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("bun", [BINARY, "mcp", ...agentArgs], {
      cwd,
      env: { ...process.env, HOME: home, FAILPROOFAI_HOME: home, FAILPROOFAI_TELEMETRY_DISABLED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolveRun({ replies: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)), code, stderr: err });
      } catch (e) {
        reject(new Error(`non-JSON on stdout: ${out}\n${String(e)}`));
      }
    });
    child.stdin.end(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  });
}

describe("self-report sync on a stale home", () => {
  it("refuses, like a scheduled audit, instead of migrating (and resetting) the home unattended", async () => {
    // What failproofaid runs at startup and after each settings change.
    writeFileSync(join(home, "VERSION"), JSON.stringify({ layout: 1, cli: "0.0.1" }));
    const toml = "[telemetry]\nenabled = false\n";
    writeFileSync(join(home, "config.toml"), toml);
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((ok, fail) => {
      const child = spawn("bun", [BINARY, "self-report", "sync", "--quiet"], {
        cwd: home,
        env: { ...process.env, HOME: home, FAILPROOFAI_HOME: home, FAILPROOFAI_TELEMETRY_DISABLED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (b: Buffer) => (err += b.toString()));
      child.on("error", fail);
      child.on("close", (c) => ok({ code: c, stderr: err }));
    });
    expect(code).toBe(1);
    expect(stderr).toContain("refusing to run unattended");
    expect(stderr).toContain("failproofai config");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(toml);
    expect(JSON.parse(readFileSync(join(home, "VERSION"), "utf8")).layout).toBe(1);
  }, 30_000);
});

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const CALL_ARGS = { category: "looping", detail: "stuck in a retry loop" };
const CALL = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report", arguments: CALL_ARGS } };
const PING = { jsonrpc: "2.0", id: 4, method: "ping" };

describe("failproofai mcp (stdio, spawned)", () => {
  it("answers initialize, ping, and an empty tools/list while disabled — with no daemon", async () => {
    writeEffectiveSelfReport({ enabled: false });
    const { replies, code } = await runMcp([], [INIT, INITIALIZED, LIST, PING], home);
    expect(code).toBe(0);
    expect(replies.map((r) => r.id)).toEqual([1, 2, 4]);
    expect(replies[0]).toMatchObject({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "failproofai_local" } } });
    expect((replies[0].result as Record<string, unknown>)).not.toHaveProperty("instructions");
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(replies[2]).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
  }, 30_000);

  it("lists the report tool from self-report.json and answers a call with exactly Recorded.", async () => {
    writeEffectiveSelfReport({ enabled: true, categories: [{ name: "looping", description: "loops" }], guidance: "be terse" });
    const { replies } = await runMcp(["--agent", "claude"], [INIT, LIST, CALL], home);
    expect((replies[0].result as Record<string, unknown>).instructions).toBe(
      selfReportInstructions([{ name: "looping", description: "loops" }], "be terse"),
    );
    const tools = (replies[1].result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("report");
    expect(tools[0].description).toBe(describeTool([{ name: "looping", description: "loops" }], "be terse"));
    expect(tools[0].inputSchema).toEqual(inputSchema([{ name: "looping", description: "loops" }]));
    expect(replies[2]).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "Recorded." }] } });
  }, 30_000);

  it("with no settings file (not Cloud enrolled) lists the tool and records: on by default", async () => {
    const { replies } = await runMcp(["--agent", "pi"], [INIT, LIST, CALL], home);
    expect((replies[0].result as Record<string, unknown>).instructions).toBe(selfReportInstructions(DEFAULT_CATEGORIES));
    const tools = (replies[1].result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["report"]);
    expect(readdirSync(join(home, "custom-agents", "events"))).toHaveLength(1);
  }, 30_000);

  it("with no settings file on a Cloud-enrolled machine lists nothing and records nothing", async () => {
    writeFileSync(join(home, "credentials.json"), JSON.stringify({ cloud: { url: "https://x", machine_id: "m", token: "t" } }));
    const { replies } = await runMcp(["--agent", "pi"], [INIT, LIST, CALL], home);
    expect((replies[0].result as Record<string, unknown>)).not.toHaveProperty("instructions");
    expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    expect(() => readdirSync(join(home, "custom-agents", "events"))).toThrow();
  }, 30_000);

  // Claude Code and Codex: the hook records, so the server writes nothing for
  // a call the hook already recorded. The hook runs before the MCP call is
  // sent, so its row is there first.
  it("writes no event for a hook-recorded agent (claude) whose hook recorded the call", async () => {
    writeEffectiveSelfReport({ enabled: true });
    mkdirSync(join(home, "hook-activity"), { recursive: true });
    writeFileSync(
      join(home, "hook-activity", "current.jsonl"),
      JSON.stringify({
        timestamp: Date.now() - 500, eventType: "PreToolUse", integration: "claude", sessionId: "c1", decision: "allow",
        toolName: "mcp__failproofai_local__report", selfReport: { ...CALL_ARGS, source: "mcp" },
      }) + "\n",
    );
    await runMcp(["--agent", "claude"], [INIT, CALL], home);
    expect(() => readdirSync(join(home, "custom-agents", "events"))).toThrow();
  }, 30_000);

  // ...and records it when the hook did not (an untrusted Codex runs no hook):
  // otherwise the report would be lost.
  it("records a hook-recorded agent's report when its hook did not", async () => {
    writeEffectiveSelfReport({ enabled: true });
    for (const agent of ["codex", "claude"]) {
      await runMcp(["--agent", agent], [INIT, CALL], home);
    }
    const files = readdirSync(join(home, "custom-agents", "events"));
    expect(files).toHaveLength(2);
    const events = files.map((f) => JSON.parse(readFileSync(join(home, "custom-agents", "events", f), "utf8")));
    expect(events.map((e) => e.integration).sort()).toEqual(["claude", "codex"]);
    for (const e of events) expect(e).toMatchObject({ type: "self_report", ...CALL_ARGS, source: "mcp" });
  }, 30_000);

  it("writes one self_report event in the SDK spool format for a server-recorded agent, attributed to its session", async () => {
    writeEffectiveSelfReport({ enabled: true });
    const project = join(home, "proj");
    mkdirSync(project);
    mkdirSync(join(home, "hook-activity"), { recursive: true });
    writeFileSync(
      join(home, "hook-activity", "current.jsonl"),
      JSON.stringify({ timestamp: Date.now() - 1000, eventType: "PreToolUse", integration: "pi", cwd: project, sessionId: "pi-sess", decision: "allow" }) + "\n",
    );
    const { replies } = await runMcp(["--agent", "pi"], [INIT, CALL], project);
    expect(replies[1]).toMatchObject({ result: { content: [{ type: "text", text: "Recorded." }] } });
    const dir = join(home, "custom-agents", "events");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^event-\d{4}-\d\d-\d\dT[\d-]+Z-\d+-\d+\.jsonl$/);
    expect(statSync(join(dir, files[0])).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const lines = readFileSync(join(dir, files[0]), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event).toMatchObject({
      type: "self_report",
      session_id: "pi-sess",
      agent_id: "pi-proj",
      environment: "local",
      category: "looping",
      detail: "stuck in a retry loop",
      source: "mcp",
      integration: "pi",
    });
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
  }, 30_000);

  it("records the detail a model sent under an alias (sentence) instead of an empty one", async () => {
    writeEffectiveSelfReport({ enabled: true });
    const aliased = { ...CALL, params: { name: "report", arguments: { category: "looping", sentence: "retrying the same fix", extra: 1 } } };
    const { replies } = await runMcp(["--agent", "hermes"], [INIT, aliased], home);
    expect(replies[1]).toMatchObject({ result: { content: [{ type: "text", text: "Recorded." }] } });
    const dir = join(home, "custom-agents", "events");
    const event = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    expect(event).toMatchObject({ category: "looping", detail: "retrying the same fix" });
  }, 30_000);

  it("falls back to session \"unattributed\" when no live session matches", async () => {
    writeEffectiveSelfReport({ enabled: true });
    await runMcp(["--agent", "hermes"], [INIT, CALL], home);
    const dir = join(home, "custom-agents", "events");
    const event = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    expect(event.session_id).toBe("unattributed");
  }, 30_000);

  it("rejects a missing --agent value on stderr, never on stdout", async () => {
    const { replies, code, stderr } = await runMcp(["--agent"], [INIT], home);
    expect(code).toBe(1);
    expect(replies).toEqual([]);
    expect(stderr).toContain("--agent");
  }, 30_000);
});

describe("failproofai self-report enable | disable | status", () => {
  const deps = { skipSync: true, probeEndpoint: async () => false };

  it("enable writes config.json's selfReport and self-report.json; status shows it", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ unrelated: { keep: true } }));
    const enabled = await runSelfReportCommand(["enable", "--guidance", "say what tool"], deps);
    expect(enabled.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.selfReport).toEqual({ enabled: true, guidance: "say what tool" });
    expect(config.unrelated).toEqual({ keep: true });
    expect(readEffectiveSelfReport()).toMatchObject({ enabled: true, source: "local", guidance: "say what tool", categories: DEFAULT_CATEGORIES });

    const status = await runSelfReportCommand(["status"], deps);
    expect(status.exitCode).toBe(0);
    const text = status.lines.join("\n");
    expect(text).toContain("Self Reports: on");
    expect(text).toContain("this machine");
    expect(text).toContain("looping, cannot_do_request");
    expect(text).toContain("Daemon MCP: not running (agents use stdio)");
  });

  it("enable --categories-file replaces the defaults; a bad file is refused and writes nothing", async () => {
    const good = join(home, "cats.json");
    writeFileSync(good, JSON.stringify({ categories: [{ name: "tracker_down", description: "The tracker is down." }] }));
    expect((await runSelfReportCommand(["enable", "--categories-file", good], deps)).exitCode).toBe(0);
    expect(readEffectiveSelfReport()?.categories).toEqual([{ name: "tracker_down", description: "The tracker is down." }]);

    rmSync(join(home, "self-report.json"));
    const bad = join(home, "bad.json");
    writeFileSync(bad, JSON.stringify([{ name: "Bad Name", description: "x" }]));
    const refused = await runSelfReportCommand(["enable", "--categories-file", bad], deps);
    expect(refused.exitCode).toBe(1);
    expect(refused.lines.join(" ")).toContain("name must match");
    expect(readEffectiveSelfReport()).toBeNull();
  });

  it("disable turns it off and keeps the categories for next time", async () => {
    const cats = join(home, "cats.json");
    writeFileSync(cats, JSON.stringify([{ name: "x_y", description: "d" }]));
    await runSelfReportCommand(["enable", "--categories-file", cats], deps);
    const off = await runSelfReportCommand(["disable"], deps);
    expect(off.exitCode).toBe(0);
    expect(readEffectiveSelfReport()).toMatchObject({ enabled: false });
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).selfReport).toEqual({
      enabled: false,
      categories: [{ name: "x_y", description: "d" }],
    });
    expect((await runSelfReportCommand(["enable"], deps)).exitCode).toBe(0);
    expect(readEffectiveSelfReport()?.categories).toEqual([{ name: "x_y", description: "d" }]);
  });

  it("refuses enable and disable on a Cloud-managed machine and changes nothing", async () => {
    process.env.FAILPROOFAI_CLOUD_URL = "https://example.invalid";
    for (const verb of ["enable", "disable"]) {
      const r = await runSelfReportCommand([verb], deps);
      expect(r.exitCode).toBe(1);
      expect(r.lines.join(" ")).toContain("FailproofAI Cloud");
    }
    expect(readEffectiveSelfReport()).toBeNull();
    expect(() => readFileSync(join(home, "config.json"))).toThrow();
  });

  const row = (o: Record<string, unknown>) => ({
    agent: "claude", path: "/x", hooked: true, registered: true, transport: "http", endpoint: null, conflict: false, ...o,
  }) as never;

  it("status shows each agent's actual transport and whether its endpoint answers", async () => {
    writeEffectiveSelfReport({ enabled: true });
    const runnable = join(home, "failproofai");
    writeFileSync(runnable, "#!/bin/sh\n", { mode: 0o755 });
    const r = await runSelfReportCommand(["status"], {
      skipSync: true,
      probeEndpoint: async (_url, port) => port === 4319,
      daemonLive: async (port) => port === 4319,
      registrations: () => [
        row({ agent: "claude", transport: "http", endpoint: "http://127.0.0.1:4319/mcp?agent=claude" }),
        row({ agent: "codex", transport: "http", endpoint: "http://127.0.0.1:4999/mcp?agent=codex" }),
        row({ agent: "cursor", transport: "stdio", endpoint: runnable }),
        row({ agent: "factory", transport: "stdio", endpoint: join(home, "missing", "failproofai") }),
      ],
    });
    const text = r.lines.join("\n");
    expect(text).not.toContain("still works");
    expect(text).toContain("Daemon MCP: http://127.0.0.1:4319/mcp (answering)");
    expect(text).toMatch(/claude +http +http:\/\/127\.0\.0\.1:4319\/mcp\?agent=claude \(answering\)/);
    expect(text).toMatch(/codex +http +http:\/\/127\.0\.0\.1:4999\/mcp\?agent=codex \(NOT answering\)/);
    expect(text).toMatch(new RegExp(`cursor +stdio +${runnable} \\(runnable\\)`));
    expect(text).toMatch(/factory +stdio +.*\(NOT runnable\)/);
    // Cursor's line is followed by how to approve the server in cursor-agent; nobody else's is.
    const lines = text.split("\n");
    const at = lines.findIndex((l) => /^ +cursor +stdio/.test(l));
    expect(lines[at + 1]).toContain("cursor-agent mcp enable failproofai");
    expect(lines.filter((l) => l.includes("cursor-agent mcp enable"))).toHaveLength(1);
  });

  it("status says the daemon is not running, not \"not answering\", when there is no daemon", async () => {
    writeEffectiveSelfReport({ enabled: true });
    const status = (expected: boolean) =>
      runSelfReportCommand(["status"], {
        skipSync: true,
        probeEndpoint: async () => false,
        daemonExpected: () => expected,
        registrations: () => [row({ agent: "claude", transport: "stdio", endpoint: "/usr/bin/failproofai" })],
      });
    const none = (await status(false)).lines.join("\n");
    expect(none).toContain("Daemon MCP: not running (agents use stdio)");
    expect(none).not.toContain("not answering");
    const down = (await status(true)).lines.join("\n");
    expect(down).toContain("Daemon MCP: http://127.0.0.1:4319/mcp (not answering)");
    expect(down).not.toContain("not running");
  });

  it("status expects a daemon when setup configured one or its socket file is there", async () => {
    writeEffectiveSelfReport({ enabled: true });
    const status = async () =>
      (await runSelfReportCommand(["status"], {
        skipSync: true,
        probeEndpoint: async () => false,
        registrations: () => [],
      })).lines.join("\n");
    const sock = join(home, "fake-daemon.sock");
    const prev = process.env.FAILPROOFAI_DAEMON_SOCKET;
    process.env.FAILPROOFAI_DAEMON_SOCKET = sock;
    try {
      expect(await status()).toContain("Daemon MCP: not running (agents use stdio)");
      writeFileSync(sock, "");
      expect(await status()).toContain("(not answering)");
    } finally {
      if (prev === undefined) delete process.env.FAILPROOFAI_DAEMON_SOCKET;
      else process.env.FAILPROOFAI_DAEMON_SOCKET = prev;
    }
  });

  it("status re-syncs agents left on an HTTP endpoint that is not answering", async () => {
    writeEffectiveSelfReport({ enabled: true });
    let synced = 0;
    let rows = [row({ transport: "http", endpoint: "http://127.0.0.1:4319/mcp?agent=claude" })];
    const r = await runSelfReportCommand(["status"], {
      probeEndpoint: async () => false,
      registrations: () => rows,
      sync: async () => {
        synced++;
        rows = [row({ transport: "stdio", endpoint: "/usr/bin/failproofai" })];
        return [{ agent: "claude", path: "/x", action: "updated", transport: "stdio", status: "ok" }];
      },
    });
    expect(synced).toBe(1);
    const text = r.lines.join("\n");
    expect(text).toContain("Repaired:");
    expect(text).toContain("updated in Claude Code (stdio)");
    expect(text).toMatch(/claude +stdio/);

    // Healthy, or skipSync: no write.
    synced = 0;
    rows = [row({ transport: "http", endpoint: "http://127.0.0.1:4319/mcp?agent=claude" })];
    await runSelfReportCommand(["status"], {
      probeEndpoint: async () => true, daemonLive: async () => true, registrations: () => rows, sync: async () => (synced++, []),
    });
    await runSelfReportCommand(["status"], { skipSync: true, probeEndpoint: async () => false, registrations: () => rows, sync: async () => (synced++, []) });
    expect(synced).toBe(0);
  });

  it("status re-syncs an agent whose HTTP endpoint answers as another home's daemon", async () => {
    writeEffectiveSelfReport({ enabled: true });
    let synced = 0;
    const http = [row({ transport: "http", endpoint: "http://127.0.0.1:4319/mcp?agent=claude" })];
    const seen = await runSelfReportCommand(["status"], {
      skipSync: true,
      probeEndpoint: async () => true,
      daemonLive: async () => false,
      registrations: () => http,
    });
    expect(seen.lines.join("\n")).toMatch(/claude +http +\S+ \(answering, but NOT this home's daemon\)/);
    let rows = http;
    const r = await runSelfReportCommand(["status"], {
      probeEndpoint: async () => true,
      daemonLive: async () => false,
      registrations: () => rows,
      sync: async () => {
        synced++;
        rows = [row({ transport: "stdio", endpoint: "/usr/bin/failproofai" })];
        return [{ agent: "claude", path: "/x", action: "updated", transport: "stdio", status: "ok" }];
      },
    });
    expect(synced).toBe(1);
    expect(r.lines.join("\n")).toContain("Repaired:");
  });

  it("status moves a server-recorded agent off HTTP even while the endpoint answers", async () => {
    writeEffectiveSelfReport({ enabled: true });
    let synced = 0;
    let rows = [row({ agent: "copilot", transport: "http", endpoint: "http://127.0.0.1:4319/mcp?agent=copilot" })];
    const r = await runSelfReportCommand(["status"], {
      probeEndpoint: async () => true,
      registrations: () => rows,
      sync: async () => {
        synced++;
        rows = [row({ agent: "copilot", transport: "stdio", endpoint: "/usr/bin/failproofai" })];
        return [{ agent: "copilot", path: "/x", action: "updated", transport: "stdio", status: "ok" }];
      },
    });
    expect(synced).toBe(1);
    expect(r.lines.join("\n")).toContain("Repaired:");
  });

  it("enable says \"Agents updated.\" only when a sync changed something", async () => {
    const quiet = await runSelfReportCommand(["enable"], { probeEndpoint: async () => false, sync: async () => [{ agent: "claude", path: "/x", action: "unchanged", transport: "http", status: "ok" }] });
    expect(quiet.lines.join("\n")).not.toContain("Agents updated.");
    const changed = await runSelfReportCommand(["enable"], { probeEndpoint: async () => false, sync: async () => [{ agent: "claude", path: "/x", action: "added", transport: "http", status: "ok" }] });
    expect(changed.lines.join("\n")).toContain("Agents updated.");
    const off = await runSelfReportCommand(["disable"], { sync: async () => [] });
    expect(off.lines).toEqual([
      "✓ Self Reports is off. Agents lose the report tool and nothing is recorded.",
      "  Turn it back on with `failproofai self-report enable`.",
    ]);
  });

  it("status with no settings file says it is on by default, and how to turn it off", async () => {
    const r = await runSelfReportCommand(["status"], deps);
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toBe("Self Reports: on");
    expect(r.lines.join("\n")).toContain("the default (no settings file yet)");
    expect(r.lines.join("\n")).toContain("`failproofai self-report disable`");
  });

  it("status with no settings file on a Cloud-enrolled machine says it is off until Cloud sends it", async () => {
    process.env.FAILPROOFAI_CLOUD_URL = "https://example.invalid";
    const r = await runSelfReportCommand(["status"], deps);
    expect(r.lines[0]).toContain("off (waiting for FailproofAI Cloud");
  });

  it("status with a malformed settings file says it is off", async () => {
    writeFileSync(join(home, "self-report.json"), "{not json");
    const r = await runSelfReportCommand(["status"], deps);
    expect(r.lines[0]).toBe("Self Reports: off (the settings file cannot be read)");
  });

  it("test refuses while disabled and rejects an unknown agent", async () => {
    writeEffectiveSelfReport({ enabled: false });
    expect((await runSelfReportCommand(["test", "--agent", "claude"], deps)).exitCode).toBe(1);
    writeEffectiveSelfReport({ enabled: true });
    const r = await runSelfReportCommand(["test", "--agent", "nope"], deps);
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toContain("Not an agent");
  });

  it("test --agent pi drives the real stdio server and reports the event file", async () => {
    writeEffectiveSelfReport({ enabled: true });
    const r = await runSelfReportCommand(["test", "--agent", "pi"], { ...deps, cliCommand: ["bun", BINARY], cwd: home });
    expect(r.exitCode).toBe(0);
    const dir = join(home, "custom-agents", "events");
    expect(r.lines.join("\n")).toContain(join(dir, readdirSync(dir)[0]));
  }, 30_000);

  it("test --agent pi passes when a collector consumes the batch before the check", async () => {
    // The wrapper runs the real CLI, then deletes every published batch the way
    // a running collector does after uploading it, before the command looks.
    writeEffectiveSelfReport({ enabled: true });
    const consume = `bun "${BINARY}" "$@"; code=$?; rm -f "$FAILPROOFAI_HOME"/custom-agents/events/*.jsonl; exit $code`;
    const r = await runSelfReportCommand(["test", "--agent", "pi"], { ...deps, cliCommand: ["sh", "-c", consume, "sh"], cwd: home });
    expect(r.lines.join("\n")).toContain("recorded by the MCP server");
    expect(r.lines.join("\n")).toContain("already picked up by the collector");
    expect(r.exitCode).toBe(0);
    expect(readdirSync(join(home, "custom-agents", "events")).filter((f) => f.endsWith(".jsonl"))).toEqual([]);
  }, 30_000);

  it("test --agent pi still fails when the server recorded nothing", async () => {
    writeEffectiveSelfReport({ enabled: true });
    // The server answers Recorded. but cannot write (the spool is a file).
    mkdirSync(join(home, "custom-agents"), { recursive: true });
    writeFileSync(join(home, "custom-agents", "events"), "not a directory");
    const r = await runSelfReportCommand(["test", "--agent", "pi"], { ...deps, cliCommand: ["bun", BINARY], cwd: home });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toContain("did not land");
  }, 30_000);

  it("test --agent claude goes through --hook and lands in hook activity", async () => {
    writeEffectiveSelfReport({ enabled: true });
    const r = await runSelfReportCommand(["test", "--agent", "claude"], { ...deps, cliCommand: ["bun", BINARY], cwd: home });
    expect(r.exitCode).toBe(0);
    const rows = readFileSync(join(home, "hook-activity", "current.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.pop()).toMatchObject({ toolName: "mcp__failproofai_local__report", decision: "allow", selfReport: { source: "mcp" } });
  }, 30_000);
});
