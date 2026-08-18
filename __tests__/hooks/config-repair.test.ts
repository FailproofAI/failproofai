// @vitest-environment node
/**
 * Repair rewrites a file the user owns and the vendor reads, unattended, on
 * machines with no operator. So the assertions here are mostly about restraint:
 * what it refuses to touch, that it always leaves a way back, and that it puts
 * the original bytes back rather than leaving a file it could not verify.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repairConfigDrift } from "../../src/hooks/config-repair";
import { detectConfigDrift } from "../../src/hooks/config-drift";
import { claudeCode, getIntegration } from "../../src/hooks/integrations";
import { configBackupsDir } from "../../src/hooks/fp-home";

let cwd: string;
let home: string;
const BINARY = "/usr/bin/failproofai";

function install(): string {
  const path = claudeCode.getSettingsPath("project", cwd);
  const settings = claudeCode.readSettings(path);
  claudeCode.writeHookEntries(settings, BINARY, "project");
  claudeCode.writeSettings(path, settings);
  return path;
}

/** Break the installed config the way a vendor format change would. */
function makeStale(path: string): void {
  const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const groups = (settings.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>)
    .PreToolUse;
  groups[0].hooks[0].timeout = "60s";
  writeFileSync(path, JSON.stringify(settings, null, 2));
}

function statusOf(): string | undefined {
  return detectConfigDrift({ clis: ["claude"], scopes: ["project"], cwd })[0]?.status;
}

function repair(dryRun = false) {
  return repairConfigDrift({ cwd, clis: ["claude"], scopes: ["project"], dryRun });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "fpai-repair-"));
  home = mkdtempSync(join(tmpdir(), "fpai-repair-home-"));
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_BINARY_OVERRIDE = BINARY;
});

afterEach(() => {
  delete process.env.FAILPROOFAI_HOME;
  delete process.env.FAILPROOFAI_BINARY_OVERRIDE;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("config-repair: the happy path", () => {
  it("repairs a stale config and verifies it, rather than assuming", () => {
    const path = install();
    makeStale(path);
    expect(statusOf()).toBe("stale");

    const [outcome] = repair();
    expect(outcome.action).toBe("repaired");
    expect(outcome.reason).toBe("verified-ok");
    expect(statusOf()).toBe("ok");
  });

  it("keeps the user's own settings through the rewrite", () => {
    const path = install();
    const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    settings.permissions = { allow: ["WebSearch"] };
    settings.model = "opus";
    writeFileSync(path, JSON.stringify(settings, null, 2));
    makeStale(path);

    expect(repair()[0].action).toBe("repaired");

    const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(after.permissions).toEqual({ allow: ["WebSearch"] });
    expect(after.model).toBe("opus");
  });

  it("leaves a backup of the previous bytes", () => {
    const path = install();
    makeStale(path);
    const before = readFileSync(path, "utf8");

    const [outcome] = repair();
    expect(outcome.backupPath).toBeTruthy();
    expect(readFileSync(outcome.backupPath!, "utf8")).toBe(before);
  });

  it("bounds how many backups it keeps, pruning whole repairs", () => {
    // Pruned by repair, not by file: half a backup set cannot restore anything.
    const path = install();
    for (let i = 0; i < 6; i++) {
      makeStale(path);
      repair();
    }
    const dir = join(configBackupsDir(), "claude-project");
    expect(readdirSync(dir).length).toBe(3);
  });
});

describe("config-repair: what it refuses to touch", () => {
  it("does nothing for a healthy config", () => {
    install();
    expect(repair()[0].action).toBe("skipped");
    expect(repair()[0].reason).toContain("ok");
  });

  it("does not install where the user never did", () => {
    // `absent` is not drift — deciding to install for them is not repair.
    expect(repair()).toHaveLength(0);
  });

  it("refuses a file our own writer cannot process", () => {
    // Repair runs that same writer, so it would fail every attempt while
    // looking like it tried. A human has to look.
    const path = install();
    const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    (settings.hooks as Record<string, unknown>).PreToolUse = { matcher: "*", hooks: [] };
    writeFileSync(path, JSON.stringify(settings, null, 2));

    const [outcome] = repair();
    expect(outcome.action).toBe("skipped");
    expect(outcome.reason).toContain("unreadable");
  });

  it("never touches this repo's own dogfood configs", () => {
    const path = claudeCode.getSettingsPath("project", cwd);
    mkdirSync(dirname(path), { recursive: true });
    const dogfood = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: 'node "$CLAUDE_PROJECT_DIR/scripts/dev-hook.mjs" --hook PreToolUse',
                timeout: 60,
                __failproofai_hook__: true,
              },
            ],
          },
        ],
      },
    });
    writeFileSync(path, dogfood);

    const [outcome] = repair();
    expect(outcome.action).toBe("skipped");
    expect(readFileSync(path, "utf8")).toBe(dogfood);
  });

  it("changes nothing in dry-run, including the backup directory", () => {
    const path = install();
    makeStale(path);
    const before = readFileSync(path, "utf8");

    const [outcome] = repair(true);
    expect(outcome.action).toBe("skipped");
    expect(outcome.reason).toBe("dry-run");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(() => readdirSync(configBackupsDir())).toThrow();
  });
});

describe("config-repair: the old-shape case it exists for", () => {
  it("repairs a config whose shape we no longer recognise", () => {
    // Copilot 1.0.71: `hooks` went array -> object, older files were rejected
    // wholesale, and the session ran unhooked. Our entry IS in the file; we
    // simply cannot see it through the shape we expect.
    const copilot = getIntegration("copilot");
    const path = copilot.getSettingsPath("project", cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        hooks: [
          {
            event: "PreToolUse",
            type: "command",
            bash: "npx -y failproofai --hook PreToolUse --cli copilot",
            __failproofai_hook__: true,
          },
        ],
      }),
    );

    const before = detectConfigDrift({ clis: ["copilot"], scopes: ["project"], cwd })[0];
    expect(before.status).toBe("stale");
    expect(before.detail).toBe("unrecognised-shape");

    const outcome = repairConfigDrift({ cwd, clis: ["copilot"], scopes: ["project"] })[0];
    expect(outcome.action).toBe("repaired");

    // The array is gone; `hooks` is the object shape 1.0.71 requires.
    const after = JSON.parse(readFileSync(path, "utf8")) as { hooks: unknown };
    expect(Array.isArray(after.hooks)).toBe(false);
    expect(detectConfigDrift({ clis: ["copilot"], scopes: ["project"], cwd })[0].status).toBe("ok");
  });
});

describe("config-repair: it must never throw", () => {
  it("survives a settings path that cannot be backed up", () => {
    const path = install();
    makeStale(path);
    // Make the backup root un-creatable by putting a file where the dir goes.
    mkdirSync(home, { recursive: true });
    writeFileSync(configBackupsDir(), "not a directory");

    const [outcome] = repair();
    expect(outcome.action).toBe("failed");
    expect(outcome.reason).toContain("backup-failed");
    // Refusing to repair leaves the machine exactly as it was.
    expect(statusOf()).toBe("stale");
  });

  it("does not throw when asked to repair every CLI on an empty machine", () => {
    expect(() => repairConfigDrift({ cwd })).not.toThrow();
  });
});


describe("config-repair: sidecars are backed up, not just the settings file", () => {
  /** OpenCode resolves its project paths from process.cwd(). */
  function inCwd<T>(fn: () => T): T {
    const prev = process.cwd();
    process.chdir(cwd);
    try {
      return fn();
    } finally {
      process.chdir(prev);
    }
  }

  function installOpencode(): { settingsPath: string; shimPath: string } {
    const oc = getIntegration("opencode");
    const settingsPath = oc.getSettingsPath("project", cwd);
    mkdirSync(dirname(settingsPath), { recursive: true });
    const settings = oc.readSettings(settingsPath);
    oc.writeHookEntries(settings, BINARY, "project");
    oc.writeSettings(settingsPath, settings);
    return { settingsPath, shimPath: oc.sidecarFiles!(BINARY, "project", settingsPath)[0].path };
  }

  it("copies the generated shim too, so a repair can be undone whole", () => {
    // Repair rewrites BOTH the settings file and the shim. Backing up only the
    // settings file meant it could write two files and undo one — a bad shim
    // beside a restored settings file is a mismatched pair, and a machine left
    // worse than we found it.
    inCwd(() => {
      const { shimPath } = installOpencode();
      writeFileSync(shimPath, "// a shim from an older install\n");

      const outcome = repairConfigDrift({ cwd, clis: ["opencode"], scopes: ["project"] })[0];
      expect(outcome.action).toBe("repaired");

      const setDir = dirname(outcome.backupPath!);
      const manifest = JSON.parse(readFileSync(join(setDir, "manifest.json"), "utf8")) as {
        files: { original: string; existed: boolean }[];
      };
      expect(manifest.files.map((f) => f.original)).toContain(shimPath);
      expect(readFileSync(join(setDir, "sidecar-0.bak"), "utf8")).toBe(
        "// a shim from an older install\n",
      );
    });
  });

  it("records a sidecar that did not exist, so rollback deletes rather than keeps it", () => {
    // The inverse operation. A repair that CREATES a file must, on rollback,
    // remove it — restoring "nothing" by doing nothing leaves the machine
    // holding a file it never had.
    inCwd(() => {
      const { shimPath } = installOpencode();
      rmSync(shimPath, { force: true });

      const outcome = repairConfigDrift({ cwd, clis: ["opencode"], scopes: ["project"] })[0];
      expect(outcome.action).toBe("repaired");

      const manifest = JSON.parse(
        readFileSync(join(dirname(outcome.backupPath!), "manifest.json"), "utf8"),
      ) as { files: { original: string; existed: boolean }[] };
      const shim = manifest.files.find((f) => f.original === shimPath);
      expect(shim?.existed).toBe(false);
      // And the repair really did put it back.
      expect(existsSync(shimPath)).toBe(true);
    });
  });
});
