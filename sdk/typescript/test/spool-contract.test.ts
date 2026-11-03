import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  expandUser,
  failproofaiCustomAgentsDir,
  getBaseDir,
  legacyAgenteyeDir,
  setBaseDir,
} from "../src/resolver.js";

/**
 * Four implementations resolve where this SDK's spool lives, and they must
 * agree or the SDK writes where no daemon reads — with NO error on either side,
 * which is the whole reason this file exists:
 *
 *   * this package's `resolver.ts`
 *   * the Python SDK's `failproofai_sdk/_resolver.py`
 *   * the daemon's `crates/fpai-collect/src/config.rs`
 *   * the CLI's `src/hooks/fp-home.ts`
 *
 * These assertions read the OTHER THREE from disk rather than restating them.
 * A test that spelled the path out a fifth time would pass while the daemon
 * watched somewhere else.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function read(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

afterEach(() => {
  setBaseDir(null);
});

describe("agreement with the other implementations", () => {
  it("matches the daemon's custom_agents_events_dir", () => {
    const rust = read("crates/fpai-collect/src/config.rs");
    // `home.join("custom-agents").join("events")`
    expect(rust).toMatch(/\.join\("custom-agents"\)\s*\.join\("events"\)/);
    expect(join(failproofaiCustomAgentsDir(), "events")).toBe(
      join(homedir(), ".failproofai", "custom-agents", "events"),
    );
  });

  it("matches the CLI's customAgentsDir", () => {
    const hooks = read("src/hooks/fp-home.ts");
    expect(hooks).toContain('atHome(home, "custom-agents")');
    expect(hooks).toMatch(/process\.env\.FAILPROOFAI_HOME\s*\|\|\s*resolve\(homedir\(\), "\.failproofai"\)/);
  });

  it("matches the Python SDK's resolver", () => {
    const python = read("sdk/python/failproofai_sdk/_resolver.py");
    expect(python).toContain('base / "custom-agents"');
    expect(python).toContain('os.environ.get("FAILPROOFAI_HOME")');
  });

  it("keeps the daemon watching the legacy root, so an older SDK is not stranded", () => {
    const rust = read("crates/fpai-collect/src/config.rs");
    expect(rust).toContain("agenteye_events_dir()");
    expect(legacyAgenteyeDir()).toBe(join(homedir(), ".agenteye"));
  });
});

describe("resolution order", () => {
  it("prefers an explicit base directory over everything", () => {
    setBaseDir("/tmp/somewhere-explicit");
    expect(getBaseDir()).toBe("/tmp/somewhere-explicit");
  });

  it("moves with FAILPROOFAI_HOME but never leaves it", () => {
    const previous = process.env.FAILPROOFAI_HOME;
    process.env.FAILPROOFAI_HOME = "/opt/fp";
    try {
      // The `custom-agents` segment is appended unconditionally: the variable
      // MOVES the umbrella, it cannot take the spool outside it.
      expect(failproofaiCustomAgentsDir()).toBe(join("/opt/fp", "custom-agents"));
    } finally {
      if (previous === undefined) delete process.env.FAILPROOFAI_HOME;
      else process.env.FAILPROOFAI_HOME = previous;
    }
  });

  it("is NOT redirected by AGENTEYE_HOME", () => {
    const previous = process.env.AGENTEYE_HOME;
    process.env.AGENTEYE_HOME = "/tmp/agenteye-elsewhere";
    try {
      // A redirect with no confirmation and no error means batches land in a
      // directory nothing reads, and an unread spool is indistinguishable from
      // an idle one. The Python SDK removed this for the same reason.
      expect(getBaseDir()).not.toContain("agenteye-elsewhere");
    } finally {
      if (previous === undefined) delete process.env.AGENTEYE_HOME;
      else process.env.AGENTEYE_HOME = previous;
    }
  });
});

describe("tilde expansion", () => {
  it("expands a leading ~, so the documented migration bridge does not create one", () => {
    // `configure({ baseDir: "~/.agenteye" })` is the documented explicit bridge.
    // Without expansion, the writer's recursive mkdir cheerfully creates a
    // directory literally named `~` under the process's cwd and spools into it:
    // nothing on the machine watches that path, so 100% of the telemetry is
    // lost.
    setBaseDir("~/.agenteye");
    expect(getBaseDir()).toBe(join(homedir(), ".agenteye"));
    expect(getBaseDir().startsWith("~")).toBe(false);
  });

  it("leaves a tilde that is not a home reference alone", () => {
    expect(expandUser("/var/lib/~weird")).toBe("/var/lib/~weird");
  });

  it("resolves a relative base directory against the cwd", () => {
    setBaseDir("relative/spool");
    expect(getBaseDir()).toBe(resolve("relative/spool"));
  });
});
