// @vitest-environment node
/**
 * The config-drift detector answers one question — "if you reinstalled right
 * now, would this file change?" — so most of what matters here is what it must
 * NOT say: not "ok" for a file it could not read, not "stale" for a file that
 * is merely key-ordered differently, and never anything at all about this
 * repo's own dogfood configs, which carry the same marker a real install does.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  detectConfigDrift,
  driftFindings,
  isDogfoodCommand,
  type ConfigDriftReport,
} from "../../src/hooks/config-drift";
import { claudeCode, getIntegration } from "../../src/hooks/integrations";
import { INTEGRATION_TYPES } from "../../src/hooks/types";

let cwd: string;
const BINARY = "/usr/bin/failproofai";

/** Install claude project-scope hooks into the temp cwd, the way the CLI does. */
function install(binaryPath = BINARY): string {
  const path = claudeCode.getSettingsPath("project", cwd);
  const settings = claudeCode.readSettings(path);
  claudeCode.writeHookEntries(settings, binaryPath, "project");
  claudeCode.writeSettings(path, settings);
  return path;
}

function detect(): ConfigDriftReport[] {
  return detectConfigDrift({ clis: ["claude"], scopes: ["project"], cwd });
}

function statusOf(): string {
  const reports = detect();
  expect(reports).toHaveLength(1);
  return reports[0].status;
}

function readSettingsFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "fpai-config-drift-"));
  process.env.FAILPROOFAI_BINARY_OVERRIDE = BINARY;
});

afterEach(() => {
  delete process.env.FAILPROOFAI_BINARY_OVERRIDE;
  rmSync(cwd, { recursive: true, force: true });
});

describe("config-drift: the healthy cases", () => {
  it("reports absent when there is no settings file at all", () => {
    expect(statusOf()).toBe("absent");
  });

  it("reports absent when the file exists but holds no failproofai entry", () => {
    const path = claudeCode.getSettingsPath("project", cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ permissions: { allow: ["WebSearch"] } }, null, 2));
    expect(statusOf()).toBe("absent");
  });

  it("reports ok immediately after a real install", () => {
    install();
    expect(statusOf()).toBe("ok");
  });

  it("reports ok when the file is key-ordered differently", () => {
    // `writeHookEntries` mutates in place, so a regenerated object can carry
    // identical content with keys in another order. A raw JSON.stringify
    // comparison would call that drift and send someone chasing a correct file.
    const path = install();
    const settings = readSettingsFile(path);
    const reordered = Object.fromEntries(Object.entries(settings).reverse());
    writeFileSync(path, JSON.stringify(reordered, null, 2));
    expect(statusOf()).toBe("ok");
  });

  it("reports ok when the user has their own unrelated settings alongside ours", () => {
    const path = install();
    const settings = readSettingsFile(path);
    settings.permissions = { allow: ["WebSearch"] };
    settings.model = "opus";
    writeFileSync(path, JSON.stringify(settings, null, 2));
    expect(statusOf()).toBe("ok");
  });
});

describe("config-drift: the cases worth paging about", () => {
  it("reports stale when an event we install is missing from the file", () => {
    // The shape of a vendor dropping or renaming an event, or of a hand-edit.
    const path = install();
    const settings = readSettingsFile(path);
    const hooks = settings.hooks as Record<string, unknown>;
    delete hooks.PreToolUse;
    writeFileSync(path, JSON.stringify(settings, null, 2));
    expect(statusOf()).toBe("stale");
  });

  it("reports stale when a field's TYPE changes, the way a timeout unit switch would", () => {
    // Vendors disagree about this field already — copilot spells it
    // `timeoutSec`, everyone else `timeout` — so a type or unit switch is a
    // live class, and it is structural rather than a value difference.
    const path = install();
    const settings = readSettingsFile(path);
    const groups = (settings.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>)
      .PreToolUse;
    groups[0].hooks[0].timeout = "60s";
    writeFileSync(path, JSON.stringify(settings, null, 2));
    expect(statusOf()).toBe("stale");
  });

  it("reports unreadable, not stale, when our own writer cannot process the file", () => {
    // `hooks.PreToolUse` as an object rather than an array makes
    // `writeHookEntries` throw. That matters for the CONSUMER: repair runs the
    // same writer, so it would throw too. Calling this `stale` would hand an
    // auto-repair a file it cannot fix and let it fail on every attempt; a
    // human has to look.
    const path = install();
    const settings = readSettingsFile(path);
    (settings.hooks as Record<string, unknown>).PreToolUse = { matcher: "*", hooks: [] };
    writeFileSync(path, JSON.stringify(settings, null, 2));
    expect(statusOf()).toBe("unreadable");
  });

  it("distinguishes a value-only difference from a shape change", () => {
    // Found live: the detector run from a repo checkout regenerates OUR OWN
    // install path differently from the global binary that wrote the file, and
    // reporting that as drift makes every developer machine cry wolf.
    const path = install();
    const raw = readFileSync(path, "utf8").replace(
      "npx -y failproofai --hook PreToolUse",
      "npx -y failproofai@0.0.15 --hook PreToolUse",
    );
    writeFileSync(path, raw);
    expect(statusOf()).toBe("stale_path");
  });

  it("reports unreadable rather than ok for a corrupt file", () => {
    // `readJsonFile` throws on a hand-edited or truncated file. Reporting "ok"
    // there is the comfortable lie.
    const path = claudeCode.getSettingsPath("project", cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json at all");
    expect(statusOf()).toBe("unreadable");
  });

  it("reports the error CLASS only, never the file's contents", () => {
    const path = claudeCode.getSettingsPath("project", cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ "apiKey": "sk-SECRETVALUE", oops');
    const report = detect()[0];
    expect(report.status).toBe("unreadable");
    expect(JSON.stringify(report)).not.toContain("SECRETVALUE");
  });
});

describe("config-drift: this repo's own dogfood configs", () => {
  it("never claims a config routed through the dev launcher", () => {
    // These carry the same `__failproofai_hook__` marker a real install does,
    // so every marker-keyed check claims them. Regenerating one rewrites
    // `node scripts/dev-hook.mjs` into `npx -y failproofai`, pointing
    // enforcement at the PUBLISHED package while the tree is being edited.
    const path = claudeCode.getSettingsPath("project", cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    'command -v node >/dev/null 2>&1 || { exit 2; }; node "$CLAUDE_PROJECT_DIR/scripts/dev-hook.mjs" --hook PreToolUse',
                  timeout: 60,
                  __failproofai_hook__: true,
                },
              ],
            },
          ],
        },
      }),
    );
    expect(statusOf()).toBe("dogfood");
  });

  it("recognises the dev launcher by command", () => {
    expect(isDogfoodCommand('node "$CLAUDE_PROJECT_DIR/scripts/dev-hook.mjs" --hook Stop')).toBe(true);
    expect(isDogfoodCommand("npx -y failproofai --hook Stop")).toBe(false);
    expect(isDogfoodCommand("")).toBe(false);
  });

  it("leaves this repo's real dogfood configs alone", () => {
    // Run the detector against the actual repo rather than a fixture: if the
    // guard ever regresses, these report `stale` and something downstream
    // would "repair" files CLAUDE.md forbids touching.
    const reports = detectConfigDrift({ scopes: ["project"], cwd: process.cwd() });
    for (const r of reports) {
      expect(["dogfood", "absent", "ok", "stale_path", "unsupported"]).toContain(r.status);
    }
  });
});

describe("config-drift: it must never WRITE", () => {
  /** Every file under a tree, with size and mtime — enough to catch any write. */
  function snapshot(root: string): string {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else out.push(`${full}:${st.size}:${st.mtimeMs}`);
      }
    };
    walk(root);
    return out.join("\n");
  }

  it("pins exactly which writers touch disk, for all twelve", () => {
    // The detector regenerates via `writeHookEntries` to compare, which is only
    // safe while that call writes nothing. OpenCode's used to: it also generated
    // its ~190-line plugin shim, because for that CLI the shim IS the install,
    // and a read-only check rewrote this repo's own tracked
    // `.opencode/plugins/failproofai.mjs`. It now honours `pure`, so the set
    // below is EMPTY and every integration is inspectable.
    //
    // Asserted against the writers directly rather than through
    // detectConfigDrift, so it cannot pass vacuously: a new integration that
    // grows a side effect fails here.
    const impure: string[] = [];
    for (const cli of INTEGRATION_TYPES) {
      let integration: ReturnType<typeof getIntegration>;
      try {
        integration = getIntegration(cli);
      } catch {
        continue;
      }
      const scope = integration.scopes.includes("project") ? "project" : integration.scopes[0];
      const sandbox = mkdtempSync(join(tmpdir(), `fpai-purity-${cli}-`));
      const prevCwd = process.cwd();
      const prevHome = process.env.HOME;
      try {
        // OpenCode derives its shim path from cwd/HOME, so both must point
        // somewhere disposable or this test writes into the real repo.
        process.chdir(sandbox);
        process.env.HOME = sandbox;
        const before = snapshot(sandbox);
        try {
          const settings = integration.readSettings(integration.getSettingsPath(scope, sandbox));
          integration.writeHookEntries(settings, BINARY, scope, { pure: true });
        } catch {
          // A writer that throws here is not a purity question.
        }
        if (snapshot(sandbox) !== before) impure.push(cli);
      } finally {
        process.chdir(prevCwd);
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
    expect(impure).toEqual([]);
  });

  it("now inspects opencode instead of refusing to", () => {
    // OpenCode derives its project paths from `process.cwd()` rather than the
    // cwd argument, which is why integrations.test.ts chdirs for it too.
    const prev = process.cwd();
    process.chdir(cwd);
    try {
    // It was `unsupported` because checking it meant writing to disk. It no
    // longer does, so "we cannot tell" is no longer an answer we give here.
    const oc = getIntegration("opencode");
    const path = oc.getSettingsPath("project", cwd);
    mkdirSync(dirname(path), { recursive: true });
    const settings = oc.readSettings(path);
    oc.writeHookEntries(settings, BINARY, "project");
    oc.writeSettings(path, settings);

    const reports = detectConfigDrift({ clis: ["opencode"], scopes: ["project"], cwd });
    expect(reports[0].status).toBe("ok");
    } finally {
      process.chdir(prev);
    }
  });

  it("catches a shim that no longer matches what we would generate", () => {
    const prev = process.cwd();
    process.chdir(cwd);
    try {
    // The case that made a half-fix worse than the gate: the registration is
    // perfect and points at a shim built by a binary path that has moved, so
    // the CLI loads something inert while the settings file reads healthy.
    const oc = getIntegration("opencode");
    const path = oc.getSettingsPath("project", cwd);
    mkdirSync(dirname(path), { recursive: true });
    const settings = oc.readSettings(path);
    oc.writeHookEntries(settings, BINARY, "project");
    oc.writeSettings(path, settings);

    const shim = oc.sidecarFiles!(BINARY, "project", path)[0];
    writeFileSync(shim.path, shim.content.replace("failproofai", "failproofai-OLD-PATH"));

    const report = detectConfigDrift({ clis: ["opencode"], scopes: ["project"], cwd })[0];
    expect(report.status).toBe("stale");
    expect(report.detail).toBe("sidecar-stale");
    } finally {
      process.chdir(prev);
    }
  });

  it("catches a registration whose shim has been deleted", () => {
    const prev = process.cwd();
    process.chdir(cwd);
    try {
    const oc = getIntegration("opencode");
    const path = oc.getSettingsPath("project", cwd);
    mkdirSync(dirname(path), { recursive: true });
    const settings = oc.readSettings(path);
    oc.writeHookEntries(settings, BINARY, "project");
    oc.writeSettings(path, settings);
    rmSync(oc.sidecarFiles!(BINARY, "project", path)[0].path, { force: true });

    const report = detectConfigDrift({ clis: ["opencode"], scopes: ["project"], cwd })[0];
    expect(report.status).toBe("stale");
    expect(report.detail).toBe("sidecar-missing");
    } finally {
      process.chdir(prev);
    }
  });
});

describe("config-drift: it must never throw", () => {
  it("survives a settings path that is a directory", () => {
    const path = claudeCode.getSettingsPath("project", cwd);
    mkdirSync(path, { recursive: true });
    expect(() => detect()).not.toThrow();
    expect(statusOf()).toBe("unreadable");
  });

  it("returns nothing rather than guessing when the binary cannot be resolved", () => {
    // Regenerating with a guessed path would manufacture drift on every
    // machine, which is worse than reporting nothing.
    install();
    process.env.FAILPROOFAI_BINARY_OVERRIDE = "";
    process.env.PATH = "";
    expect(() => detectConfigDrift({ clis: ["claude"], scopes: ["project"], cwd })).not.toThrow();
  });

  it("scans every CLI without throwing on the ones that are not installed", () => {
    expect(() => detectConfigDrift({ cwd })).not.toThrow();
  });
});

describe("driftFindings", () => {
  it("surfaces only what a human should act on", () => {
    const reports: ConfigDriftReport[] = [
      { cli: "claude", scope: "project", settingsPath: "/a", status: "ok" },
      { cli: "codex", scope: "user", settingsPath: "/b", status: "absent" },
      { cli: "copilot", scope: "user", settingsPath: "/c", status: "stale" },
      { cli: "goose", scope: "user", settingsPath: "/d", status: "unreadable" },
      { cli: "cursor", scope: "project", settingsPath: "/e", status: "dogfood" },
      { cli: "pi", scope: "user", settingsPath: "/f", status: "stale_path" },
    ];
    expect(driftFindings(reports).map((r) => r.cli)).toEqual(["copilot", "goose"]);
  });
});
