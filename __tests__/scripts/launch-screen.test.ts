// @vitest-environment node
/**
 * The dashboard launch screen (`failproofai` with no arguments), built from
 * facts. Plain renders are compared whole, against the redesign's `launch`
 * reference with real data in it.
 */
import { describe, it, expect } from "vitest";
import {
  LAUNCH_SCREEN_LINKS,
  dashboardBrowseUrl,
  describeCloudConnection,
  describePoliciesOn,
  describeTracedAgents,
  exposedBindWarning,
  launchFailureLines,
  launchScreenLines,
  type LaunchScreenFacts,
} from "../../scripts/launch-screen";

const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

const FACTS: LaunchScreenFacts = {
  url: "http://127.0.0.1:8020",
  live: true,
  policies: "10 on from FailproofAI/policies@06b802b",
  agents: "9 traced: Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent and 5 more",
  cloud: "Connected as chetanraghuvanshi85",
  notEnforcing: false,
};

const PLAIN = { color: false, logo: false, version: "1.0.11" } as const;

const LINKS_BLOCK = [
  "LINKS",
  "  docs       https://docs.befailproof.ai",
  "  discord    https://discord.befailproof.ai/",
  "  github     https://github.com/failproofai/failproofai",
  "  reddit     https://www.reddit.com/r/failproofai/",
  "",
  "ctrl+c stop the dashboard",
  "",
];

/**
 * Drive the env vars the colour tier reads, then put the ambient ones back, so
 * the coloured assertions mean the same thing in every terminal CI hands them.
 */
function withTruecolor<T>(fn: () => T): T {
  const saved = { COLORTERM: process.env.COLORTERM, TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
  process.env.COLORTERM = "truecolor";
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("launchScreenLines", () => {
  it("renders the connected, enforcing machine: header, DASHBOARD, LINKS and the key hint", () => {
    expect(launchScreenLines(FACTS, PLAIN)).toEqual([
      "",
      "failproof ai  v1.0.11  ·  End-to-end failure layer for AI agents",
      "",
      "DASHBOARD",
      "  url        http://127.0.0.1:8020  ● live",
      "  policies   10 on from FailproofAI/policies@06b802b",
      "  agents     9 traced: Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent and 5 more",
      "  cloud      Connected as chetanraghuvanshi85",
      "",
      ...LINKS_BLOCK,
    ]);
  });

  it("piped: no art and not one escape code", () => {
    const out = launchScreenLines({ ...FACTS, notEnforcing: true }, PLAIN).join("\n");
    expect(out).not.toContain("\x1B");
    expect(out).not.toMatch(/[▀▄█]/);
  });

  it("opens with the logomark above the header when asked, with one blank line between", () => {
    const lines = launchScreenLines(FACTS, { ...PLAIN, logo: true });
    expect(lines[0]).toBe("");
    const art = lines.slice(1, 11);
    expect(art).toHaveLength(10);
    for (const line of art) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line).toMatch(/[▀▄█]/);
    }
    expect(lines[11]).toBe("");
    expect(lines[12]).toBe("failproof ai  v1.0.11  ·  End-to-end failure layer for AI agents");
    // No escapes at the basic tier: the shape alone carries the mark.
    expect(art.join("")).not.toContain("\x1B");
  });

  it("draws no art on a terminal too narrow for it, rather than the retired ▮▮ line", () => {
    const lines = launchScreenLines(FACTS, { ...PLAIN, logo: true, cols: 21 });
    expect(lines[1]).toBe("failproof ai  v1.0.11  ·  End-to-end failure layer for AI agents");
    expect(lines.join("")).not.toContain("▮");
  });

  it("says the server is still starting when it missed the deadline", () => {
    const lines = launchScreenLines({ ...FACTS, live: false }, PLAIN);
    expect(lines).toContain("  url        http://127.0.0.1:8020  ○ starting");
    expect(lines.join("\n")).not.toContain("● live");
  });

  it("shows the one generic warning when policies are not enforcing", () => {
    const lines = launchScreenLines({ ...FACTS, policies: "none on", notEnforcing: true }, PLAIN);
    expect(lines.slice(3, 11)).toEqual([
      "DASHBOARD",
      "  url        http://127.0.0.1:8020  ● live",
      "  policies   none on",
      "  agents     9 traced: Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent and 5 more",
      "  cloud      Connected as chetanraghuvanshi85",
      "",
      "▲ Policies are not enforcing yet.  ·  failproofai config",
      "",
    ]);
    expect(lines.filter((l) => l.startsWith("▲"))).toHaveLength(1);
  });

  it("puts the exposed-bind security warning first, with all three consequences and its fix", () => {
    const lines = launchScreenLines(
      { ...FACTS, notEnforcing: true, exposed: { host: "0.0.0.0", fix: "unset FAILPROOFAI_DASHBOARD_HOST" } },
      PLAIN,
    );
    const at = lines.findIndex((l) => l.startsWith("▲"));
    expect(lines[at]).toBe(`▲ ${exposedBindWarning("0.0.0.0")}`);
    expect(lines[at + 1]).toBe("  unset FAILPROOFAI_DASHBOARD_HOST");
    // At most one attention line: the security one outranks "not enforcing".
    expect(lines.filter((l) => l.startsWith("▲"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("not enforcing");
  });

  it("shows no attention line at all on a healthy loopback machine", () => {
    expect(launchScreenLines(FACTS, PLAIN).some((l) => /^[▲✕]/.test(l))).toBe(false);
  });

  it("paints by role: grey labels, a pink address, a mint ●, an amber ▲ with a pink fix", () => {
    const lines = withTruecolor(() =>
      launchScreenLines({ ...FACTS, notEnforcing: true }, { color: true, logo: false, version: "1.0.11" }),
    );
    const url = lines.find((l) => strip(l).startsWith("  url"))!;
    expect(url).toContain("\x1B[38;2;118;127;139murl\x1B[0m");
    expect(url).toContain("\x1B[38;2;228;88;125mhttp://127.0.0.1:8020\x1B[0m");
    expect(url).toContain("\x1B[38;2;102;209;181m●\x1B[0m live");
    const warn = lines.find((l) => strip(l).startsWith("▲"))!;
    expect(warn).toContain("\x1B[38;2;227;179;65m▲\x1B[0m");
    expect(warn).toContain("\x1B[38;2;228;88;125mfailproofai config\x1B[0m");
    expect(lines.find((l) => strip(l) === "DASHBOARD")).toBe("\x1B[1mDASHBOARD\x1B[0m");
    expect(lines.find((l) => strip(l) === "ctrl+c stop the dashboard")).toBe(
      "\x1B[38;2;118;127;139mctrl+c stop the dashboard\x1B[0m",
    );
    // The same screen as the plain one, once the colour is taken out.
    expect(lines.map(strip)).toEqual(launchScreenLines({ ...FACTS, notEnforcing: true }, PLAIN));
  });

  it("keeps https:// on every link, and keeps reddit", () => {
    for (const [, href] of LAUNCH_SCREEN_LINKS) expect(href.startsWith("https://")).toBe(true);
    expect(LAUNCH_SCREEN_LINKS.map(([label]) => label)).toEqual(["docs", "discord", "github", "reddit"]);
  });

  it("says the agent, never a product, wherever the copy is ours", () => {
    const own = [
      ...launchScreenLines({ ...FACTS, notEnforcing: true }, PLAIN),
      exposedBindWarning("0.0.0.0"),
    ].join("\n");
    expect(own.replace(FACTS.agents, "")).not.toMatch(/Claude/);
    expect(own).not.toContain("!");
  });
});

describe("dashboardBrowseUrl", () => {
  it.each([
    ["127.0.0.1", "http://127.0.0.1:8020"],
    ["localhost", "http://localhost:8020"],
    ["127.0.0.2", "http://127.0.0.2:8020"],
    ["::1", "http://[::1]:8020"],
    ["[::1]", "http://[::1]:8020"],
    ["0.0.0.0", "http://127.0.0.1:8020"],
    ["::", "http://[::1]:8020"],
    ["192.168.1.20", "http://192.168.1.20:8020"],
    ["fe80::1", "http://[fe80::1]:8020"],
    ["dev-box.internal", "http://dev-box.internal:8020"],
  ])("binds %s → %s", (host, url) => {
    expect(dashboardBrowseUrl(host, 8020)).toBe(url);
  });

  it("uses the port it is given", () => {
    expect(dashboardBrowseUrl("127.0.0.1", "9000")).toBe("http://127.0.0.1:9000");
  });
});

describe("exposedBindWarning", () => {
  it("names the address and keeps every consequence", () => {
    const text = exposedBindWarning("10.0.0.5");
    expect(text).toContain("10.0.0.5");
    expect(text).toContain("reachable from outside this machine");
    expect(text).toContain("no authentication");
    expect(text).toContain("read your session transcripts");
    expect(text).toContain("disable your policies");
    expect(text).toContain("uninstall failproofai's hooks");
  });
});

describe("describePoliciesOn", () => {
  const pack = (label: string, count: number) => ({ label, count, pack: true });

  it("names the one pack the policies come from", () => {
    expect(describePoliciesOn({ sources: [pack("FailproofAI/policies@06b802b", 10)], customFiles: false })).toBe(
      "10 on from FailproofAI/policies@06b802b",
    );
  });

  it("counts packs when there are several", () => {
    expect(
      describePoliciesOn({ sources: [pack("FailproofAI/policies@06b802b", 10), pack("acme/finance@1.2.0", 2)], customFiles: false }),
    ).toBe("12 on from 2 packs");
  });

  it("counts sources when packs and the cloud deployment both contribute", () => {
    expect(
      describePoliciesOn({
        sources: [pack("FailproofAI/policies@06b802b", 10), { label: "FailproofAI Cloud", count: 3, pack: false }],
        customFiles: false,
      }),
    ).toBe("13 on from 2 sources");
  });

  it("names a cloud deployment or the legacy built-ins when they are the only source", () => {
    expect(describePoliciesOn({ sources: [{ label: "FailproofAI Cloud", count: 3, pack: false }], customFiles: false })).toBe(
      "3 on from FailproofAI Cloud",
    );
    expect(describePoliciesOn({ sources: [{ label: "built-in policies", count: 5, pack: false }], customFiles: false })).toBe(
      "5 on from built-in policies",
    );
  });

  it("says none on when nothing is", () => {
    expect(describePoliciesOn({ sources: [], customFiles: false })).toBe("none on");
  });

  it("never says none on while custom policy files exist", () => {
    expect(describePoliciesOn({ sources: [], customFiles: true })).toBe("custom policy files only");
    expect(describePoliciesOn({ sources: [pack("FailproofAI/policies@06b802b", 10)], customFiles: true })).toBe(
      "10 on from FailproofAI/policies@06b802b, plus custom policy files",
    );
  });
});

describe("describeTracedAgents", () => {
  const ALL = [
    "Claude Code",
    "OpenAI Codex",
    "GitHub Copilot",
    "Cursor Agent",
    "OpenCode",
    "Pi",
    "Hermes",
    "OpenClaw",
    "Factory Droid",
    "Devin CLI",
    "Antigravity CLI",
    "Goose",
  ];

  it.each([
    [0, "none traced"],
    [1, "1 traced: Claude Code"],
    [2, "2 traced: Claude Code and OpenAI Codex"],
    [4, "4 traced: Claude Code, OpenAI Codex, GitHub Copilot and Cursor Agent"],
    [5, "5 traced: Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent and OpenCode"],
    [6, "6 traced: Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent and 2 more"],
    [12, "12 traced: Claude Code, OpenAI Codex, GitHub Copilot, Cursor Agent and 8 more"],
  ])("%i agents → %s", (n, text) => {
    expect(describeTracedAgents(ALL.slice(0, n))).toBe(text);
  });
});

describe("describeCloudConnection", () => {
  const connected = {
    kind: "connected" as const,
    org: "chetanraghuvanshi85",
    host: "app.befailproof.ai",
    pulling: true,
    sending: true,
    refused: null,
  };

  it("says not connected when there is no credential", () => {
    expect(describeCloudConnection({ kind: "none" })).toBe("Not connected");
  });

  it("says who it is connected as", () => {
    expect(describeCloudConnection(connected)).toBe("Connected as chetanraghuvanshi85");
  });

  it("falls back to the host when the server never named an org", () => {
    expect(describeCloudConnection({ ...connected, org: null })).toBe("Connected to app.befailproof.ai");
  });

  it("names a half connection, as config --status does", () => {
    expect(describeCloudConnection({ ...connected, pulling: false })).toBe(
      "Connected as chetanraghuvanshi85, reporting only",
    );
    expect(describeCloudConnection({ ...connected, sending: false })).toBe(
      "Connected as chetanraghuvanshi85, not sending activity",
    );
  });

  it("never claims a healthy connection while the server refuses its uploads", () => {
    expect(describeCloudConnection({ ...connected, refused: { codes: [401], credential: true } })).toBe(
      "Connected as chetanraghuvanshi85, but its key is refused (401)",
    );
    expect(describeCloudConnection({ ...connected, refused: { codes: [400, 413], credential: false } })).toBe(
      "Connected as chetanraghuvanshi85, but its uploads are refused (400/413)",
    );
  });

  it("reports an environment override as such, the way config --status does", () => {
    expect(describeCloudConnection({ kind: "environment", url: "https://cloud.example.test" })).toBe(
      "Configured by environment (https://cloud.example.test)",
    );
  });
});

describe("launchFailureLines", () => {
  it("says the port is in use and how to get it back", () => {
    expect(
      launchFailureLines({ portInUse: true, cause: null, code: 1 }, { port: "8020", portFromFlag: false, color: false }),
    ).toEqual([
      "",
      "✕ Port 8020 is already in use, so the dashboard did not start.",
      "  Stop whatever is using it, often another failproofai dashboard, then run failproofai again.",
      "",
    ]);
  });

  it("points a contributor who chose the port at --port", () => {
    const lines = launchFailureLines(
      { portInUse: true, cause: null, code: 1 },
      { port: "9000", portFromFlag: true, color: false },
    );
    expect(lines[1]).toBe("✕ Port 9000 is already in use, so the dashboard did not start.");
    expect(lines[2]).toBe("  Pass a different --port, or stop whatever is using 9000.");
  });

  it("quotes the real cause when the server said one", () => {
    expect(
      launchFailureLines(
        { portInUse: false, cause: "listen EADDRNOTAVAIL: address not available 10.0.0.5:8020", code: 1 },
        { port: "8020", portFromFlag: false, color: false },
      ),
    ).toEqual(["", "✕ The dashboard did not start: listen EADDRNOTAVAIL: address not available 10.0.0.5:8020", ""]);
  });

  it("falls back to the exit code when the server said nothing", () => {
    const opts = { port: "8020", portFromFlag: false, color: false };
    expect(launchFailureLines({ portInUse: false, cause: null, code: 3 }, opts)[1]).toBe(
      "✕ The dashboard stopped before it was ready (exit code 3).",
    );
    expect(launchFailureLines({ portInUse: false, cause: null, code: null }, opts)[1]).toBe(
      "✕ The dashboard stopped before it was ready.",
    );
  });

  it("paints the ✕ red and the fix's command pink", () => {
    const lines = withTruecolor(() =>
      launchFailureLines({ portInUse: true, cause: null, code: 1 }, { port: "8020", portFromFlag: false, color: true }),
    );
    expect(lines[1]).toContain("\x1B[38;2;240;113;120m✕\x1B[0m");
    expect(lines[2]).toContain("\x1B[38;2;228;88;125mfailproofai\x1B[0m");
  });
});
