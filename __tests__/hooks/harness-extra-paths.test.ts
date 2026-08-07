// @vitest-environment node
//
// `failproofai harness` and the `[collector.sources.*]` config it writes.
//
// The round trip through a real config.toml is the point of most of these:
// `writeConfig` regenerates the file wholesale, so the failure mode worth
// testing is not "did it write the key" but "did writing it drop something
// else", and "does what it wrote parse back to what it meant".
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { readConfig, writeConfig, DEFAULT_CONFIG } from "@/src/hooks/fp-config";
import { configFile } from "@/src/hooks/fp-home";
import { HARNESS_KEYS, addPath, removePath, listPaths, runHarnessCommand } from "@/src/hooks/harness-cli";

describe("harness extra paths", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.FAILPROOFAI_HOME;
    home = mkdtempSync(join(tmpdir(), "fpai-hx-"));
    process.env.FAILPROOFAI_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
    else process.env.FAILPROOFAI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  // ── the list that cannot be allowed to drift ───────────────────────────

  // Two hand-maintained copies of one list, in two languages, with nothing
  // generating either. A name here the daemon does not know writes a table
  // nothing reads; a name the daemon knows and this omits is a path the user
  // cannot add. Both parse cleanly and neither is mentioned anywhere else.
  it("matches HARNESS_KEYS in the daemon, which is the side that registers tasks", () => {
    const rust = readFileSync(
      resolve(__dirname, "../../crates/failproofaid/src/main.rs"),
      "utf8",
    );
    const block = /const HARNESS_KEYS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust);
    expect(block, "HARNESS_KEYS not found in main.rs — did it move or get renamed?").toBeTruthy();
    const rustKeys = [...block![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(rustKeys.length).toBeGreaterThan(0);
    expect([...rustKeys].sort()).toEqual([...HARNESS_KEYS].sort());
  });

  // ── the default-path-only regression ───────────────────────────────────

  it("writes no [collector.sources] table when nothing is configured", () => {
    writeConfig(DEFAULT_CONFIG);
    const text = readFileSync(configFile(), "utf8");
    expect(text).not.toContain("[collector.sources");
    expect(readConfig().collector.sources).toBeUndefined();
  });

  it("adding then removing the last path leaves no empty table behind", () => {
    writeConfig(DEFAULT_CONFIG);
    const before = readFileSync(configFile(), "utf8");

    addPath("claude", "work=/srv/team/projects");
    expect(readFileSync(configFile(), "utf8")).toContain("[collector.sources.claude]");

    removePath("claude", "work");
    expect(readFileSync(configFile(), "utf8")).not.toContain("[collector.sources");
    // Byte-identical to before: a user who adds and removes gets their file back.
    expect(readFileSync(configFile(), "utf8")).toBe(before);
  });

  // ── round trips ────────────────────────────────────────────────────────

  it("round-trips a labelled path through real TOML", () => {
    addPath("claude", "work=/srv/team/.claude/projects");
    expect(readConfig().collector.sources).toEqual({
      claude: { extraPaths: ["work=/srv/team/.claude/projects"] },
    });
  });

  it("keeps several paths for one harness, in the order they were added", () => {
    addPath("claude", "a=/srv/a");
    addPath("claude", "b=/srv/b");
    addPath("claude", "/srv/c");
    expect(readConfig().collector.sources?.claude.extraPaths).toEqual([
      "a=/srv/a",
      "b=/srv/b",
      "/srv/c",
    ]);
  });

  it("keeps paths for several harnesses independently", () => {
    addPath("claude", "w=/srv/claude");
    addPath("hermes", "p=/srv/hermes/state.db");
    const s = readConfig().collector.sources!;
    expect(s.claude.extraPaths).toEqual(["w=/srv/claude"]);
    expect(s.hermes.extraPaths).toEqual(["p=/srv/hermes/state.db"]);
  });

  // The regression that motivates writing sub-tables AFTER every scalar of
  // `[collector]`: get the order wrong and TOML reads `[telemetry]`/`[audit]`,
  // or worse a later `[collector]` scalar, as belonging to the sub-table.
  it("does not corrupt the rest of the config", () => {
    writeConfig({
      ...DEFAULT_CONFIG,
      mode: "cloud",
      daemon: { configured: true },
      collector: {
        ...DEFAULT_CONFIG.collector,
        sessions: true,
        environment: "prod",
        machineId: "m-123",
        redact: "off",
      },
      telemetry: { enabled: false },
      audit: { auto: true, intervalDays: 14 },
    });
    addPath("codex", "alt=/mnt/other/.codex/sessions");

    const cfg = readConfig();
    expect(cfg.mode).toBe("cloud");
    expect(cfg.daemon.configured).toBe(true);
    expect(cfg.collector.sessions).toBe(true);
    expect(cfg.collector.environment).toBe("prod");
    expect(cfg.collector.machineId).toBe("m-123");
    expect(cfg.collector.redact).toBe("off");
    expect(cfg.telemetry.enabled).toBe(false);
    expect(cfg.audit).toEqual({ auto: true, intervalDays: 14 });
    expect(cfg.collector.sources?.codex.extraPaths).toEqual(["alt=/mnt/other/.codex/sessions"]);
  });

  it("a path containing an equals sign survives the round trip", () => {
    addPath("claude", "k=/srv/a=b/projects");
    expect(readConfig().collector.sources?.claude.extraPaths).toEqual(["k=/srv/a=b/projects"]);
  });

  // ── rejections ─────────────────────────────────────────────────────────

  it("refuses an unknown harness and names the real ones", () => {
    const r = addPath("claud", "/srv/x");
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("Unknown harness: claud");
    expect(r.lines.join("\n")).toContain("claude");
    expect(existsSync(configFile())).toBe(false);
  });

  // Adding twice from a provisioning script must not fail the second time.
  it("is idempotent for an exact duplicate", () => {
    expect(addPath("claude", "w=/srv/x").exitCode).toBe(0);
    const r = addPath("claude", "w=/srv/x");
    expect(r.exitCode).toBe(0);
    expect(readConfig().collector.sources?.claude.extraPaths).toEqual(["w=/srv/x"]);
  });

  // Both of these are dropped by the daemon at startup. Caught here so the CLI
  // does not report success for a path that is never captured.
  it("refuses the same path under a second label", () => {
    addPath("claude", "a=/srv/x");
    const r = addPath("claude", "b=/srv/x");
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("already captures /srv/x");
    expect(readConfig().collector.sources?.claude.extraPaths).toEqual(["a=/srv/x"]);
  });

  it("refuses a second path under the same label", () => {
    addPath("claude", "a=/srv/x");
    const r = addPath("claude", "a=/srv/y");
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain('already uses the label "a"');
    expect(readConfig().collector.sources?.claude.extraPaths).toEqual(["a=/srv/x"]);
  });

  it("refuses an entry with no path", () => {
    expect(addPath("claude", "").exitCode).toBe(1);
    expect(addPath("claude", "label=").exitCode).toBe(1);
  });

  // ── removal ────────────────────────────────────────────────────────────

  it("removes by label, by path, or by the whole entry", () => {
    for (const target of ["w", "/srv/x", "w=/srv/x"]) {
      addPath("claude", "w=/srv/x");
      const r = removePath("claude", target);
      expect(r.exitCode, `removing by ${target}`).toBe(0);
      expect(readConfig().collector.sources).toBeUndefined();
    }
  });

  it("removing something absent fails rather than silently succeeding", () => {
    addPath("claude", "w=/srv/x");
    const r = removePath("claude", "nope");
    expect(r.exitCode).toBe(1);
    expect(readConfig().collector.sources?.claude.extraPaths).toEqual(["w=/srv/x"]);
  });

  it("removing one of several keeps the rest", () => {
    addPath("claude", "a=/srv/a");
    addPath("claude", "b=/srv/b");
    removePath("claude", "a");
    expect(readConfig().collector.sources?.claude.extraPaths).toEqual(["b=/srv/b"]);
  });

  // ── list ───────────────────────────────────────────────────────────────

  it("says so plainly when nothing is configured", () => {
    const r = listPaths();
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("No extra capture paths configured");
  });

  it("shows the namespace each path will produce", () => {
    addPath("claude", "work=/srv/team");
    addPath("hermes", "/srv/hermes-prod/state.db");
    const out = listPaths().lines.join("\n");
    expect(out).toContain("claude:");
    expect(out).toContain("/srv/team");
    expect(out).toContain("work-*");
    expect(out).toContain("hermes:");
    expect(out).toContain("derived from the folder name");
  });

  // A user who hand-edits config.toml runs `list` to check it, which is the
  // cheapest moment to find the typo. The daemon also reports this at startup.
  it("warns about an unknown harness table written by hand", () => {
    writeConfig({
      ...DEFAULT_CONFIG,
      collector: {
        ...DEFAULT_CONFIG.collector,
        sources: { claud: { extraPaths: ["/srv/x"] } },
      },
    });
    const out = listPaths().lines.join("\n");
    expect(out).toContain("unknown harness");
    expect(out).toContain("claud");
  });

  // ── dispatch ───────────────────────────────────────────────────────────

  it("rejects an unknown subcommand and prints usage", () => {
    const r = runHarnessCommand(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("add-path");
  });

  it("requires both arguments for add-path", () => {
    expect(runHarnessCommand(["add-path"]).exitCode).toBe(1);
    expect(runHarnessCommand(["add-path", "claude"]).exitCode).toBe(1);
  });

  it("dispatches add-path, list and remove-path", () => {
    expect(runHarnessCommand(["add-path", "claude", "w=/srv/x"]).exitCode).toBe(0);
    expect(runHarnessCommand(["list"]).lines.join("\n")).toContain("/srv/x");
    expect(runHarnessCommand(["remove-path", "claude", "w"]).exitCode).toBe(0);
  });

  // ── malformed config on disk ───────────────────────────────────────────

  it("ignores a sources table that is not shaped like one", () => {
    writeConfig(DEFAULT_CONFIG);
    const path = configFile();
    const text = readFileSync(path, "utf8");
    require("node:fs").writeFileSync(
      path,
      text +
        '\n[collector.sources.claude]\nextra_paths = "not-an-array"\n' +
        "\n[collector.sources.codex]\nextra_paths = [1, 2]\n",
    );
    // Neither becomes a phantom entry, and reading does not throw.
    expect(readConfig().collector.sources).toBeUndefined();
  });
});
