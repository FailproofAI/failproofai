import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STATUS_DASHBOARD_PORT,
  countDecisionsSince,
  gatherStatusFacts,
  pickStatusAttention,
  probeDashboardListening,
  readCollectorHealth,
  renderStatusScreen,
  startOfLocalDay,
  type StatusDeps,
  type StatusFacts,
} from "../../src/hooks/config-status";
import { persistHookActivity, _resetForTest } from "../../src/hooks/hook-activity-store";
import { writePause } from "../../src/hooks/session-pause";

const NOW = Date.UTC(2026, 9, 11, 14, 2, 0);
const CLOCK = { locale: "en-GB", timeZone: "UTC" };
const PLAIN = { version: "1.0.11", cols: 104, color: false, clock: CLOCK };
const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

const MINT = "\x1B[38;2;102;209;181m";
const GREY = "\x1B[38;2;118;127;139m";
const PINK = "\x1B[38;2;228;88;125m";
const AMBER = "\x1B[38;2;227;179;65m";
const RED = "\x1B[38;2;240;113;120m";

function withTrueColor<T>(fn: () => T): T {
  const keys = ["COLORTERM", "TERM", "NO_COLOR"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env.COLORTERM = "truecolor";
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const NO_REFUSALS = { total: 0, rejected: 0, credentialRejected: 0, byStatus: {} };

/** A healthy connected machine — the reference screen's sample, as facts. */
function facts(over: Partial<StatusFacts> = {}): StatusFacts {
  return {
    now: NOW,
    daemon: {
      supported: true,
      platform: "linux",
      service: "running",
      answering: true,
      configured: true,
      version: "1.0.11",
      skew: null,
      checkCommand: "systemctl status failproofaid@chetan",
    },
    dashboard: { url: "http://127.0.0.1:8020", listening: true },
    pauses: [],
    cloud: {
      kind: "file",
      host: "be.failproof.ai",
      org: "chetanraghuvanshi85",
      machine: "chetan-pc (dde01f39)",
      pullsPolicies: true,
      sendsEvents: true,
    },
    delivery: {
      health: { writtenAt: NOW - 5_000, lastEventAt: NOW - 12_000, lastOkAt: NOW - 20_000, delivering: true },
      refused: NO_REFUSALS,
      queued: 0,
    },
    agents: { traced: 9, notInstalled: 3 },
    policies: {
      packOn: 10,
      firstPack: "FailproofAI/policies@06b802b1c2d3",
      morePacks: 0,
      cloudOn: 0,
      observing: 0,
      customFiles: 0,
      legacy: 0,
      refusedPacks: 0,
      packsInstalled: 1,
      anyPack: "FailproofAI/policies@06b802b1c2d3",
    },
    today: { blocked: 3, warned: 7 },
    hermes: [],
    notEnforcing: null,
    ...over,
  };
}

const UNCONNECTED: Partial<StatusFacts> = {
  cloud: { kind: "none" },
  delivery: undefined,
};

/** The value of the first row with this label, plain. */
function rowValue(lines: string[], label: string): string | undefined {
  const line = lines.find((l) => new RegExp(`^  ${label}\\s{2,}`).test(strip(l)));
  return line === undefined ? undefined : strip(line).replace(new RegExp(`^  ${label}\\s+`), "");
}

describe("config --status — the screen", () => {
  it("draws a connected, healthy machine in the reference's three sections", () => {
    expect(renderStatusScreen(facts(), PLAIN)).toEqual([
      "failproof ai  v1.0.11  ·  Status",
      "",
      "THIS MACHINE",
      "  daemon     ● Running failproofaid 1.0.11",
      "  dashboard  ● http://127.0.0.1:8020",
      "  paused     No",
      "",
      "CLOUD",
      "  account    chetanraghuvanshi85 on be.failproof.ai",
      "  machine    chetan-pc (dde01f39)",
      "  delivery   ● Healthy, last event 12s ago, nothing queued",
      "",
      "ENFORCEMENT",
      "  agents     9 traced, 3 not installed",
      "  policies   10 on from FailproofAI/policies@06b802b1c2d3",
      "  today      3 blocked, 7 warned",
    ]);
  });

  it("gives an unconnected machine one cloud row that says how to connect", () => {
    const lines = renderStatusScreen(facts(UNCONNECTED), PLAIN);
    const cloud = lines.slice(lines.indexOf("CLOUD"), lines.indexOf("ENFORCEMENT"));
    expect(cloud).toEqual(["CLOUD", "  account    Not connected  ·  failproofai config", ""]);
    expect(lines.join("\n")).not.toMatch(/delivery|machine/);
  });

  it("says where an environment-configured cloud comes from, and still reports delivery", () => {
    const lines = renderStatusScreen(facts({ cloud: { kind: "env", url: "https://staging.example" } }), PLAIN);
    expect(rowValue(lines, "account")).toBe("Set by FAILPROOFAI_CLOUD_URL to https://staging.example");
    // The file's machine may describe a connection that is not the one in effect.
    expect(rowValue(lines, "machine")).toBeUndefined();
    expect(rowValue(lines, "delivery")).toMatch(/^● Healthy/);
  });

  it("names the host when the org was never recorded, and a half connection as such", () => {
    const reporting = renderStatusScreen(
      facts({ cloud: { kind: "file", host: "be.failproof.ai", pullsPolicies: false, sendsEvents: true } }),
      PLAIN,
    );
    expect(rowValue(reporting, "account")).toBe("Connected to be.failproof.ai, for reporting only");
    const policyOnly = renderStatusScreen(
      facts({
        cloud: { kind: "file", host: "be.failproof.ai", org: "acme", machine: "m-1", pullsPolicies: true, sendsEvents: false },
      }),
      PLAIN,
    );
    expect(rowValue(policyOnly, "delivery")).toBe("○ Not sending, connected for policy only");
  });

  it("puts every section's values on ONE column, derived from the labels", () => {
    const lines = renderStatusScreen(facts({ hermes: [{ profile: "work", problem: "plugin not enabled" }] }), PLAIN);
    const starts = lines
      .filter((l) => l.startsWith("  ") && !l.startsWith("   "))
      .map((l) => l.length - l.replace(/^ {2}\S+\s+/, "").length);
    expect(new Set(starts)).toEqual(new Set([13]));
  });

  it("never cuts a value, however narrow the terminal", () => {
    const long = "a-machine-label-long-enough-to-wrap-twice-at-forty (0b1c2d3e)";
    const lines = renderStatusScreen(
      facts({ cloud: { kind: "file", host: "policies.internal.example.com", org: "acme", machine: long, pullsPolicies: true, sendsEvents: true } }),
      { ...PLAIN, cols: 40 },
    );
    expect(rowValue(lines, "machine")).toBe(long);
  });

  it("opens with the header and the version it is given", () => {
    expect(renderStatusScreen(facts(), { ...PLAIN, version: "9.9.9" })[0]).toBe("failproof ai  v9.9.9  ·  Status");
  });

  it("paints by role in a terminal, and is the same text as the plain render", () => {
    const f = facts({
      daemon: { ...facts().daemon, service: "stopped", answering: false, configured: false },
      notEnforcing: "no-hooks",
    });
    const painted = withTrueColor(() => renderStatusScreen(f, { ...PLAIN, color: true }));
    const text = painted.join("\n");
    expect(text).toContain(`${GREY}○\x1B[0m Installed, not running`); // off: grey
    expect(text).toContain(`${MINT}●\x1B[0m ${PINK}http://127.0.0.1:8020\x1B[0m`); // on: mint, URL: pink
    expect(text).toContain(`${GREY}daemon\x1B[0m`); // labels grey
    expect(text).toContain("\x1B[1mTHIS MACHINE\x1B[0m"); // headings bold
    expect(text).toContain(`${AMBER}▲\x1B[0m Policies are not enforcing yet.`);
    expect(text).toContain(`${PINK}failproofai config\x1B[0m`);
    expect(painted.map(strip)).toEqual(renderStatusScreen(f, PLAIN));
    expect(renderStatusScreen(f, PLAIN).join("\n")).not.toContain("\x1B");
  });

  it("paints a failure red", () => {
    const painted = withTrueColor(() =>
      renderStatusScreen(facts({ daemon: { ...facts().daemon, answering: false, service: "stopped" } }), {
        ...PLAIN,
        color: true,
      }),
    );
    expect(painted.join("\n")).toContain(`${RED}✕\x1B[0m failproofaid is not answering, so every tool call is denied.`);
  });
});

describe("config --status — THIS MACHINE", () => {
  const daemonRow = (over: Partial<StatusFacts["daemon"]>) =>
    rowValue(renderStatusScreen(facts({ daemon: { ...facts().daemon, configured: false, ...over } }), PLAIN), "daemon");

  it("says which daemon runs, or the real state when none does", () => {
    expect(daemonRow({})).toBe("● Running failproofaid 1.0.11");
    expect(daemonRow({ version: undefined })).toBe("● Running failproofaid");
    expect(daemonRow({ service: "stopped", answering: false })).toBe("○ Installed, not running");
    expect(daemonRow({ service: "condition-failed", answering: false })).toBe(
      "○ Installed, will not start: its binary or worker is missing",
    );
    expect(daemonRow({ service: "not-installed", answering: false })).toBe("○ Not installed");
    expect(daemonRow({ service: "not-installed", answering: true })).toBe("● Running outside the service manager");
    expect(daemonRow({ supported: false, platform: "win32", service: "unsupported-platform", answering: false })).toBe(
      "○ Not supported on win32",
    );
  });

  it("keeps a version mismatch on the row, where a worse problem cannot take it away", () => {
    expect(daemonRow({ version: "1.0.10", skew: { installed: "1.0.10", expected: "1.0.11" } })).toBe(
      "● Running failproofaid 1.0.10, this CLI is 1.0.11",
    );
  });

  it("keeps macOS's unreadable service state as a fact, answering or not", () => {
    expect(daemonRow({ service: "unknown", answering: true })).toBe("● Answering, its service state needs root to read");
    expect(daemonRow({ service: "unknown", answering: false })).toBe(
      "○ Not answering, its service state needs root to read",
    );
  });

  it("shows the dashboard's URL only while something listens there", () => {
    expect(rowValue(renderStatusScreen(facts(), PLAIN), "dashboard")).toBe("● http://127.0.0.1:8020");
    const down = facts({ dashboard: { url: "http://127.0.0.1:8020", listening: false } });
    expect(rowValue(renderStatusScreen(down, PLAIN), "dashboard")).toBe("○ Not running");
  });

  it("says so plainly when nothing is paused", () => {
    expect(rowValue(renderStatusScreen(facts(), PLAIN), "paused")).toBe("No");
    expect(renderStatusScreen(facts(), PLAIN).join("\n")).not.toMatch(/Resume early|keep enforcing/);
  });

  it("lists each paused session with its id and time left, says cloud keeps enforcing, and how to resume it", () => {
    const lines = renderStatusScreen(
      facts({ pauses: [{ sessionId: "0b1c2d3e-0000-4000-8000-000000000001", expiresAt: NOW + 28 * 60_000, cwd: "/home/u/project" }] }),
      PLAIN,
    );
    const machine = lines.slice(lines.indexOf("THIS MACHINE"), lines.indexOf("CLOUD") - 1);
    expect(machine).toEqual([
      "THIS MACHINE",
      "  daemon     ● Running failproofaid 1.0.11",
      "  dashboard  ● http://127.0.0.1:8020",
      "  paused     1 session",
      "             0b1c2d3e-0000-4000-8000-000000000001  28m left, until 14:30  ·  /home/u/project",
      "             Cloud-managed policies keep enforcing.",
    ]);
    expect(lines.slice(-2)).toEqual([
      "",
      "Resume early:  failproofai config --resume --session 0b1c2d3e-0000-4000-8000-000000000001",
    ]);
  });

  it("keeps one row per session when several are paused, and names the id to pass", () => {
    const lines = renderStatusScreen(
      facts({
        pauses: [
          { sessionId: "s-new", expiresAt: NOW + 10 * 60_000 },
          { sessionId: "s-old", expiresAt: NOW + 90 * 60_000, cwd: "/w" },
        ],
      }),
      PLAIN,
    );
    expect(rowValue(lines, "paused")).toBe("2 sessions");
    expect(lines).toContain("             s-new  10m left, until 14:12");
    expect(lines).toContain("             s-old  1h30m left, until 15:32  ·  /w");
    expect(lines[lines.length - 1]).toBe("Resume early:  failproofai config --resume --session <id>");
  });
});

describe("config --status — delivery", () => {
  const deliveryRow = (over: Partial<NonNullable<StatusFacts["delivery"]>>) =>
    rowValue(renderStatusScreen(facts({ delivery: { ...facts().delivery!, ...over } }), PLAIN), "delivery");
  const health = facts().delivery!.health!;

  it("reports a healthy pipe with its last event and backlog", () => {
    expect(deliveryRow({})).toBe("● Healthy, last event 12s ago, nothing queued");
    expect(deliveryRow({ queued: 2, oldestQueuedMs: 60_000 })).toBe("● Healthy, last event 12s ago, 2 batches queued");
    expect(deliveryRow({ queued: 1, oldestQueuedMs: 60_000 })).toBe("● Healthy, last event 12s ago, 1 batch queued");
    expect(deliveryRow({ health: { ...health, lastEventAt: undefined } })).toBe(
      "● Healthy, no events since failproofaid started, nothing queued",
    );
  });

  it("puts refused batches in the row, with their status and age", () => {
    const refused = { total: 26, rejected: 26, credentialRejected: 26, byStatus: { 401: 26 }, oldestAgeMs: 134 * 60_000 };
    expect(deliveryRow({ refused })).toBe("▲ 26 batches refused (401), oldest 2h14m");
  });

  it("says when the daemon has not reported, or stopped reporting", () => {
    expect(deliveryRow({ health: null })).toBe("○ No report from failproofaid yet");
    expect(deliveryRow({ health: { ...health, writtenAt: NOW - 12 * 60_000 } })).toBe(
      "▲ No report from failproofaid for 12m",
    );
    expect(deliveryRow({ health: { ...health, delivering: false } })).toBe("○ Not delivering, failproofaid has no key");
  });

  it("calls a backlog stuck only when it is old AND nothing has been delivered for as long", () => {
    // Draining: old batches, but uploads are succeeding.
    expect(deliveryRow({ queued: 120, oldestQueuedMs: 40 * 60_000 })).toBe(
      "● Healthy, last event 12s ago, 120 batches queued",
    );
    expect(
      deliveryRow({ queued: 50, oldestQueuedMs: 3 * 3_600_000, health: { ...health, lastOkAt: NOW - 3 * 3_600_000 } }),
    ).toBe("▲ 50 batches queued, oldest 3h, last delivered 3h ago");
    expect(deliveryRow({ queued: 5, oldestQueuedMs: 20 * 60_000, health: { ...health, lastOkAt: undefined } })).toBe(
      "▲ 5 batches queued, oldest 20m, nothing delivered since failproofaid started",
    );
  });
});

describe("config --status — ENFORCEMENT", () => {
  const policiesRow = (over: Partial<StatusFacts["policies"]>) =>
    rowValue(renderStatusScreen(facts({ policies: { ...facts().policies, ...over } }), PLAIN), "policies");

  it("counts traced agents and the ones not installed", () => {
    expect(rowValue(renderStatusScreen(facts(), PLAIN), "agents")).toBe("9 traced, 3 not installed");
    expect(rowValue(renderStatusScreen(facts({ agents: { traced: 12, notInstalled: 0 } }), PLAIN), "agents")).toBe(
      "12 traced",
    );
  });

  it("says how many policies are on and where they come from", () => {
    expect(policiesRow({})).toBe("10 on from FailproofAI/policies@06b802b1c2d3");
    expect(policiesRow({ morePacks: 1, packOn: 14 })).toBe("14 on from FailproofAI/policies@06b802b1c2d3 and 1 more pack");
    expect(policiesRow({ morePacks: 2 })).toBe("10 on from FailproofAI/policies@06b802b1c2d3 and 2 more packs");
    expect(policiesRow({ cloudOn: 3 })).toBe("10 on from FailproofAI/policies@06b802b1c2d3, 3 from cloud");
    expect(policiesRow({ packOn: 0, firstPack: undefined, cloudOn: 3 })).toBe("3 on from cloud");
    expect(policiesRow({ customFiles: 2 })).toBe("10 on from FailproofAI/policies@06b802b1c2d3, custom policies from 2 files");
    expect(policiesRow({ packOn: 0, firstPack: undefined, customFiles: 1 })).toBe("Custom policies from 1 file");
    expect(policiesRow({ packOn: 0, firstPack: undefined, observing: 4 })).toBe("4 observing");
    expect(policiesRow({ packOn: 0, firstPack: undefined, packsInstalled: 0, anyPack: undefined, legacy: 8 })).toBe(
      "8 on from legacy builtins",
    );
  });

  it("counts a pack that will not load apart from what is on", () => {
    expect(policiesRow({ refusedPacks: 1 })).toBe("10 on from FailproofAI/policies@06b802b1c2d3, 1 pack will not load");
    expect(policiesRow({ packOn: 0, firstPack: undefined, packsInstalled: 0, anyPack: undefined, refusedPacks: 2 })).toBe(
      "2 packs will not load",
    );
  });

  it("names the pack that is installed with everything off, and an empty machine as empty", () => {
    expect(policiesRow({ packOn: 0, firstPack: undefined })).toBe("0 on from FailproofAI/policies@06b802b1c2d3");
    expect(policiesRow({ packOn: 0, firstPack: undefined, packsInstalled: 0, anyPack: undefined })).toBe("None installed");
  });

  it("counts today's decisions", () => {
    expect(rowValue(renderStatusScreen(facts({ today: { blocked: 0, warned: 0 } }), PLAIN), "today")).toBe(
      "0 blocked, 0 warned",
    );
  });

  it("lists every unhealthy Hermes profile with what is wrong", () => {
    const lines = renderStatusScreen(
      facts({
        hermes: [
          { profile: "default", problem: "plugin not enabled" },
          { profile: "work", problem: "legacy shell hooks: Hermes cron jobs are not checked. Run `failproofai update`" },
        ],
      }),
      PLAIN,
    );
    expect(lines).toContain("  hermes     ▲ default: plugin not enabled");
    expect(lines).toContain(
      "             ▲ work: legacy shell hooks: Hermes cron jobs are not checked. Run failproofai update",
    );
  });

  it("paints a command inside a Hermes problem as a command, not in backticks", () => {
    const painted = withTrueColor(() =>
      renderStatusScreen(facts({ hermes: [{ profile: "work", problem: "Run `failproofai update`" }] }), {
        ...PLAIN,
        color: true,
      }),
    ).join("\n");
    expect(painted).toContain(`${PINK}failproofai update\x1B[0m`);
    expect(painted).not.toContain("`");
  });
});

describe("config --status — the attention line", () => {
  /** Every problem at once; each test takes the worst away and expects the next. */
  const everything = (): StatusFacts =>
    facts({
      daemon: {
        ...facts().daemon,
        configured: true,
        answering: false,
        service: "stopped",
        skew: { installed: "1.0.10", expected: "1.0.11" },
      },
      delivery: {
        ...facts().delivery!,
        refused: { total: 3, rejected: 3, credentialRejected: 2, byStatus: { 401: 2, 422: 1 } },
      },
      notEnforcing: "no-policies",
      hermes: [{ profile: "work", problem: "plugin not enabled" }],
      policies: { ...facts().policies, refusedPacks: 1 },
    });

  const attentionLines = (f: StatusFacts) =>
    renderStatusScreen(f, PLAIN).filter((l) => l.startsWith("▲") || l.startsWith("✕"));

  it("shows at most one, the most severe", () => {
    expect(attentionLines(everything())).toEqual([
      "✕ failproofaid is not answering, so every tool call is denied.  ·  failproofai config",
    ]);
    expect(attentionLines(facts())).toEqual([]);
  });

  it("walks down the severity order as each problem is fixed", () => {
    const f = everything();
    f.daemon = { ...f.daemon, configured: false };
    // Not configured: a down daemon no longer denies, but a refused pack still does.
    expect(pickStatusAttention(f)).toEqual({
      severity: "fail",
      text: "A pack will not load, so the tool calls it covers are denied.",
      fix: "failproofai policies",
    });

    f.policies = { ...f.policies, refusedPacks: 0 };
    expect(pickStatusAttention(f)).toEqual({
      severity: "fail",
      text: "The cloud is refusing this machine's key, so nothing reaches the dashboard.",
      fix: "failproofai config",
    });

    f.delivery = { ...f.delivery!, refused: { total: 1, rejected: 1, credentialRejected: 0, byStatus: { 422: 1 } } };
    expect(pickStatusAttention(f)).toEqual({
      severity: "caution",
      text: "Policies are not enforcing yet.",
      fix: "failproofai policies add",
    });

    f.notEnforcing = null;
    expect(pickStatusAttention(f)).toEqual({
      severity: "caution",
      text: "Hermes profile work is unhealthy.",
      fix: "failproofai update",
    });

    f.hermes = [];
    expect(pickStatusAttention(f)).toEqual({
      severity: "caution",
      text: "failproofaid is not running, so nothing is pulled or delivered.",
      fix: "failproofai config",
    });

    f.daemon = { ...f.daemon, answering: true, service: "running" };
    expect(pickStatusAttention(f)).toEqual({
      severity: "caution",
      text: "The cloud refused 1 batch (422); they are not retried.",
    });

    f.delivery = { ...f.delivery!, refused: NO_REFUSALS };
    expect(pickStatusAttention(f)).toEqual({
      severity: "caution",
      text: "failproofaid 1.0.10 does not match this CLI (1.0.11).",
      fix: "failproofai update",
    });

    f.daemon = { ...f.daemon, skew: null };
    expect(pickStatusAttention(f)).toBeNull();
  });

  it("fixes 'not enforcing' with the command for its cause", () => {
    const fixFor = (reason: StatusFacts["notEnforcing"], packsInstalled = 1) =>
      pickStatusAttention(facts({ notEnforcing: reason, policies: { ...facts().policies, packsInstalled } }))?.fix;
    expect(fixFor("no-hooks")).toBe("failproofai config");
    expect(fixFor("observe-only")).toBe("failproofai policies");
    expect(fixFor("no-policies", 1)).toBe("failproofai policies add");
    expect(fixFor("no-policies", 0)).toBe("failproofai policies add FailproofAI/policies");
  });

  it("never calls a machine with a refused pack 'not enforcing': it is denying", () => {
    const f = facts({ notEnforcing: "no-policies", policies: { ...facts().policies, packOn: 0, refusedPacks: 2 } });
    expect(pickStatusAttention(f)).toEqual({
      severity: "fail",
      text: "2 packs will not load, so the tool calls they cover are denied.",
      fix: "failproofai policies",
    });
  });

  it("says how many Hermes profiles are unhealthy when there are several", () => {
    const f = facts({
      hermes: [
        { profile: "a", problem: "x" },
        { profile: "b", problem: "y" },
      ],
    });
    expect(pickStatusAttention(f)?.text).toBe("2 Hermes profiles are unhealthy.");
  });

  it("names what stands idle when the daemon is down on a connected machine", () => {
    const down = (cloud: StatusFacts["cloud"], over: Partial<StatusFacts["daemon"]> = {}) =>
      pickStatusAttention(
        facts({ cloud, daemon: { ...facts().daemon, configured: false, answering: false, service: "stopped", ...over } }),
      );
    const both = facts().cloud;
    expect(down(both)?.text).toBe("failproofaid is not running, so nothing is pulled or delivered.");
    expect(down({ kind: "file", host: "h", pullsPolicies: true, sendsEvents: false })?.text).toBe(
      "failproofaid is not running, so no cloud policy is pulled.",
    );
    expect(down({ kind: "file", host: "h", pullsPolicies: false, sendsEvents: true })?.text).toBe(
      "failproofaid is not running, so nothing is delivered.",
    );
    expect(down(both, { service: "not-installed" })?.text).toBe(
      "failproofaid is not installed, so nothing is pulled or delivered.",
    );
    // macOS: the state needs root to read, so the fix is the command that reads it.
    expect(down(both, { service: "unknown", checkCommand: "sudo launchctl print system/ai.failproof.failproofaid" })).toEqual({
      severity: "caution",
      text: "No daemon is answering, so nothing is pulled or delivered.",
      fix: "sudo launchctl print system/ai.failproof.failproofaid",
    });
    expect(down(both, { supported: false, service: "unsupported-platform" })).toEqual({
      severity: "caution",
      text: "failproofaid does not run on this platform, so nothing is pulled or delivered.",
    });
    // Nothing connected: a stopped daemon on an unconfigured machine costs nothing.
    expect(down({ kind: "none" })).toBeNull();
  });
});

// ── reading the machine ──────────────────────────────────────────────────────

let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV = [
  "HOME",
  "FAILPROOFAI_HOME",
  "FAILPROOFAI_CLOUD_URL",
  "FAILPROOFAI_CLOUD_CREDENTIALS",
  "FAILPROOFAI_DAEMON_SOCKET",
  "FAILPROOFAI_DAEMON_BINARY",
  "FAILPROOFAI_STATE_DIR",
  "FAILPROOFAI_DASHBOARD_HOST",
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fpai-status-"));
  for (const key of ENV) saved[key] = process.env[key];
  for (const key of ENV) delete process.env[key];
  // A throwaway HOME as well: some readers resolve through homedir().
  process.env.HOME = join(dir, "home");
  process.env.FAILPROOFAI_HOME = join(dir, "home", ".failproofai");
  mkdirSync(process.env.FAILPROOFAI_HOME, { recursive: true });
  _resetForTest();
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetForTest();
  rmSync(dir, { recursive: true, force: true });
});

const fp = (...parts: string[]) => join(process.env.FAILPROOFAI_HOME!, ...parts);
const put = (rel: string, body: unknown) => {
  const file = fp(rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
};

/** Nothing here reaches systemd, PATH, a socket or the network. */
const seams = (over: StatusDeps = {}): StatusDeps => ({
  now: NOW,
  cwd: join(dir, "project"),
  daemonStatus: () => "not-installed",
  daemonAnswering: () => false,
  detectInstalled: () => ["claude", "codex"],
  probeDashboard: async () => false,
  hermesRows: () => [],
  notEnforcing: () => null,
  ...over,
});

describe("gatherStatusFacts", () => {
  it("reads a fresh, unconnected machine", async () => {
    const f = await gatherStatusFacts(seams());
    expect(f.cloud).toEqual({ kind: "none" });
    expect(f.delivery).toBeUndefined();
    expect(f.pauses).toEqual([]);
    // No selection saved means every agent is traced; two binaries were found.
    expect(f.agents).toEqual({ traced: 12, notInstalled: 10 });
    expect(f.today).toEqual({ blocked: 0, warned: 0 });
    expect(f.policies.packsInstalled).toBe(0);
    expect(f.daemon).toMatchObject({ service: "not-installed", answering: false, configured: false });
    expect(f.dashboard).toEqual({ url: `http://127.0.0.1:${STATUS_DASHBOARD_PORT}`, listening: false });
  });

  it("probes the bind host the dashboard would use, reaching a wildcard on loopback", async () => {
    const asked: string[] = [];
    const probe = async (host: string, port: number) => {
      asked.push(`${host}:${port}`);
      return true;
    };
    process.env.FAILPROOFAI_DASHBOARD_HOST = "::1";
    expect((await gatherStatusFacts(seams({ probeDashboard: probe }))).dashboard).toEqual({
      url: "http://[::1]:8020",
      listening: true,
    });
    process.env.FAILPROOFAI_DASHBOARD_HOST = "0.0.0.0";
    expect((await gatherStatusFacts(seams({ probeDashboard: probe }))).dashboard.url).toBe("http://127.0.0.1:8020");
    expect(asked).toEqual(["::1:8020", "127.0.0.1:8020"]);
  });

  it("counts the saved agent selection, ignoring ids that are not agents", async () => {
    put("config.json", { agents: { selected: ["claude", "codex", "goose", "not-an-agent"], seen: ["claude"] } });
    const f = await gatherStatusFacts(seams({ detectInstalled: () => ["claude", "codex", "goose"] }));
    expect(f.agents).toEqual({ traced: 3, notInstalled: 9 });
  });

  it("reads the connection, delivery health, refusals and backlog from disk — never the token", async () => {
    put("credentials.json", {
      cloud: { url: "https://be.failproof.ai", machine_id: "dde01f39-afba-40eb-bf1a-815d9f17ac2d", token: "abcdefghijkl", machine_label: "chetan-pc" },
      ingest: { url: "https://be.failproof.ai/v1/events", key: "abcdefghijkl" },
      org: { id: "o-1", slug: "failproofai", name: "FailproofAI" },
    });
    put("state/collector-health.json", {
      ts: Math.floor((NOW - 10_000) / 1000),
      sources: { claude: { root_present: true, last_event_ts: Math.floor((NOW - 30_000) / 1000), events: 4, cursor: 9, last_error: null, errors: 0 } },
      delivery: { accepted: 4, skipped: 0, batches_fully_skipped: 0, last_ok_ts: Math.floor((NOW - 25_000) / 1000) },
    });
    put("state/failed/hooks-a-1-0.a1.c401.jsonl", "{}\n");
    put("state/spool/claude-x-1-0.jsonl", "{}\n");

    const f = await gatherStatusFacts(seams());
    expect(f.cloud).toEqual({
      kind: "file",
      host: "be.failproof.ai",
      org: "FailproofAI (failproofai)",
      machine: "chetan-pc (dde01f39)",
      pullsPolicies: true,
      sendsEvents: true,
    });
    expect(f.delivery?.health).toEqual({
      writtenAt: Math.floor((NOW - 10_000) / 1000) * 1000,
      lastEventAt: Math.floor((NOW - 30_000) / 1000) * 1000,
      lastOkAt: Math.floor((NOW - 25_000) / 1000) * 1000,
      delivering: true,
    });
    expect(f.delivery?.refused).toMatchObject({ rejected: 1, credentialRejected: 1, byStatus: { 401: 1 } });
    expect(f.delivery?.queued).toBe(1);

    const screen = renderStatusScreen(f, PLAIN).join("\n");
    expect(screen).not.toContain("abcdefghijkl");
    expect(screen).toContain("FailproofAI (failproofai) on be.failproof.ai");
  });

  it("says the environment is in charge when FAILPROOFAI_CLOUD_URL is set", async () => {
    put("credentials.json", { cloud: { url: "https://from-file", machine_id: "m", token: "t" } });
    process.env.FAILPROOFAI_CLOUD_URL = "https://from-env";
    const f = await gatherStatusFacts(seams());
    expect(f.cloud).toEqual({ kind: "env", url: "https://from-env" });
    expect(renderStatusScreen(f, PLAIN).join("\n")).not.toMatch(/from-file/);
  });

  it("lists active pauses with time left, and omits expired ones", async () => {
    writePause({ sessionId: "live", durationMs: 600_000, now: NOW, cwd: "/tmp/p" });
    writePause({ sessionId: "dead", durationMs: 1_000, now: NOW - 60_000 });
    const f = await gatherStatusFacts(seams());
    expect(f.pauses).toEqual([{ sessionId: "live", expiresAt: NOW + 600_000, cwd: "/tmp/p" }]);
    const out = renderStatusScreen(f, PLAIN).join("\n");
    expect(out).toMatch(/live {2}10m left/);
    expect(out).not.toMatch(/dead/);
  });

  it("counts today's blocks and warnings from the activity store, not yesterday's", async () => {
    const noon = startOfLocalDay(NOW) + 12 * 3_600_000;
    const row = (timestamp: number, decision: "allow" | "deny" | "instruct") =>
      persistHookActivity({ timestamp, eventType: "PreToolUse", toolName: "Bash", policyName: null, decision, reason: null, durationMs: 1 });
    row(startOfLocalDay(NOW) - 3_600_000, "deny"); // yesterday
    row(noon - 3_600_000, "deny");
    row(noon - 1_800_000, "deny");
    row(noon - 600_000, "instruct");
    row(noon - 60_000, "allow");
    expect((await gatherStatusFacts(seams({ now: noon }))).today).toEqual({ blocked: 2, warned: 1 });
  });

  it("keeps only unhealthy Hermes profiles, in their own words", async () => {
    const f = await gatherStatusFacts(
      seams({
        hermesRows: () => [
          ["hermes/default", "native plugin enabled"],
          ["hermes/work", "UNHEALTHY — plugin not enabled"],
        ],
      }),
    );
    expect(f.hermes).toEqual([{ profile: "work", problem: "plugin not enabled" }]);
  });

  it("records the daemon's version and a version skew", async () => {
    put("VERSION", { layout: 4, cli: "1.0.11", daemon: "1.0.0" });
    put("bin/failproofaid-1.0.0", "binary");
    const f = await gatherStatusFacts(seams({ daemonStatus: () => "running", daemonAnswering: () => true }));
    expect(f.daemon.version).toBe("1.0.0");
    expect(f.daemon.skew?.installed).toBe("1.0.0");
    expect(pickStatusAttention(f)?.text).toMatch(/^failproofaid 1\.0\.0 does not match this CLI/);
  });

  it("asks the shared not-enforcing predicate, for this directory", async () => {
    const asked: Array<string | undefined> = [];
    const f = await gatherStatusFacts(
      seams({
        notEnforcing: (cwd) => {
          asked.push(cwd);
          return "no-hooks";
        },
      }),
    );
    expect(f.notEnforcing).toBe("no-hooks");
    expect(asked).toEqual([join(dir, "project")]);
  });
});

describe("readCollectorHealth", () => {
  it("converts the daemon's seconds and takes the newest source event", () => {
    const file = put("state/collector-health.json", {
      ts: 1_800_000_000,
      sources: {
        claude: { root_present: true, last_event_ts: 1_799_999_000, events: 3 },
        codex: { root_present: true, last_event_ts: 1_799_999_500, events: 1 },
        goose: { root_present: false, last_event_ts: 0, events: 0 },
      },
      delivery: { accepted: 4, skipped: 0, batches_fully_skipped: 0, last_ok_ts: 1_799_999_900 },
    });
    expect(readCollectorHealth(file)).toEqual({
      writtenAt: 1_800_000_000_000,
      lastEventAt: 1_799_999_500_000,
      lastOkAt: 1_799_999_900_000,
      delivering: true,
    });
  });

  it("reads zero as none, and a missing delivery block as a daemon with no key", () => {
    const file = put("state/collector-health.json", {
      ts: 1_800_000_000,
      sources: { claude: { root_present: true, last_event_ts: 0, events: 0 } },
    });
    expect(readCollectorHealth(file)).toEqual({ writtenAt: 1_800_000_000_000, delivering: false });
    const idle = put("state/collector-health.json", { ts: 1_800_000_000, sources: {}, delivery: { last_ok_ts: 0 } });
    expect(readCollectorHealth(idle)).toEqual({ writtenAt: 1_800_000_000_000, delivering: true });
  });

  it("returns null rather than throwing on a missing, malformed or undated record", () => {
    expect(readCollectorHealth(fp("state", "collector-health.json"))).toBeNull();
    expect(readCollectorHealth(put("state/collector-health.json", "{ half"))).toBeNull();
    expect(readCollectorHealth(put("state/collector-health.json", { sources: {} }))).toBeNull();
    expect(readCollectorHealth(put("state/collector-health.json", "[]"))).toBeNull();
  });

  it("defaults to the file the daemon writes", () => {
    put("state/collector-health.json", { ts: 1_800_000_000, sources: {} });
    expect(readCollectorHealth()?.writtenAt).toBe(1_800_000_000_000);
  });
});

describe("countDecisionsSince and startOfLocalDay", () => {
  it("starts today at local midnight", () => {
    const d = new Date(NOW);
    expect(startOfLocalDay(NOW)).toBe(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
    expect(startOfLocalDay(startOfLocalDay(NOW))).toBe(startOfLocalDay(NOW));
  });

  it("counts deny as blocked and instruct as warned, from the window on", () => {
    const at = (timestamp: number, decision: "allow" | "deny" | "instruct") =>
      persistHookActivity({ timestamp, eventType: "PreToolUse", toolName: "Bash", policyName: "p", decision, reason: null, durationMs: 1 });
    at(1_000, "deny");
    at(5_000, "deny");
    at(6_000, "instruct");
    at(7_000, "allow");
    expect(countDecisionsSince(2_000)).toEqual({ blocked: 1, warned: 1 });
    expect(countDecisionsSince(0)).toEqual({ blocked: 2, warned: 1 });
  });

  it("is zero on a machine with no activity", () => {
    expect(countDecisionsSince(0)).toEqual({ blocked: 0, warned: 0 });
  });
});

describe("probeDashboardListening", () => {
  it("answers true while something listens on loopback, and false once it stops", async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    expect(await probeDashboardListening("127.0.0.1", port)).toBe(true);
    await new Promise<void>((done) => server.close(() => done()));
    expect(await probeDashboardListening("127.0.0.1", port)).toBe(false);
  });
});

describe("the backlog age the delivery row reads", () => {
  it("comes from the oldest spooled batch", async () => {
    put("credentials.json", { ingest: { url: "https://be.failproof.ai/v1/events", key: "k" } });
    // Both stamped relative to the injected clock, never the real one.
    const stamp = (file: string, ageMs: number) => {
      const when = new Date(NOW - ageMs);
      utimesSync(file, when, when);
    };
    stamp(put("state/spool/old-1-0.jsonl", "{}\n"), 30 * 60_000);
    stamp(put("state/spool/new-1-0.jsonl", "{}\n"), 60_000);
    const f = await gatherStatusFacts(seams());
    expect(f.delivery?.queued).toBe(2);
    expect(f.delivery?.oldestQueuedMs).toBe(30 * 60_000);
  });
});
