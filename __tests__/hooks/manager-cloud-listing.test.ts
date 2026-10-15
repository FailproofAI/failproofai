// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/hooks/cloud-managed-policies", () => ({
  readActiveCloudManagedPolicies: vi.fn(),
}));

import { listHooks } from "../../src/hooks/manager";
import { readActiveCloudManagedPolicies } from "../../src/hooks/cloud-managed-policies";

const readActive = vi.mocked(readActiveCloudManagedPolicies);

describe("failproofai policies — cloud-managed section", () => {
  let out: string[];
  let spy: ReturnType<typeof vi.spyOn>;
  let home: string;
  let project: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // A throwaway home, project and pack directory: the listing reads hook
    // settings, packs and convention files, and mirrors convention policies into
    // the user config. None of that may be the developer's own.
    home = mkdtempSync(join(tmpdir(), "fpai-cloud-listing-home-"));
    project = mkdtempSync(join(tmpdir(), "fpai-cloud-listing-proj-"));
    saved = {
      FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
      FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
    };
    process.env.FAILPROOFAI_HOME = home;
    process.env.FAILPROOFAI_PACK_DIR = join(home, "packs");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    out = [];
    spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    });
    // The listing prints one block through `process.stdout`, not a console.log
    // per line, so the capture has to follow the stream it actually writes to.
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(...String(chunk).split("\n"));
      return true;
    });
  });
  afterEach(() => {
    spy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, project]) rmSync(dir, { recursive: true, force: true });
  });

  const text = () => out.join("\n").replace(/\x1B\[[0-9;]*m/g, "");

  /** Wire Claude Code, so whether policies enforce is decided by the policies alone. */
  function wireClaude(): void {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: "npx -y failproofai --hook PreToolUse", __failproofai_hook__: true }] },
          ],
        },
      }),
    );
  }

  it("lists a deployed policy, with its version and the deployment number", async () => {
    readActive.mockReturnValue([
      { id: "org-guard", version: 3, effect: "enforce", sha256: "a", path: "p", deployment: 7 },
    ]);
    await listHooks(project);
    expect(text()).toMatch(/^CLOUD-MANAGED {2}deployment 7$/m);
    expect(text()).toMatch(/● org-guard\s+v3$/m);
  });

  it("marks an observe policy as observing, never as enforcing — its verdict is discarded", async () => {
    // The row says observe, and a wired machine whose only policy observes is
    // told it is not enforcing: two positive facts, where the old pin was the
    // absence of a chip label the redesign no longer prints anywhere.
    wireClaude();
    readActive.mockReturnValue([
      { id: "watch-only", version: 1, effect: "observe", sha256: "a", path: "p", deployment: 2 },
    ]);
    await listHooks(project);
    const line = text().split("\n").find((l) => l.includes("watch-only")) ?? "";
    expect(line).toMatch(/v1 {2}· {2}observe$/);
    expect(text()).toContain("▲ Policies are not enforcing yet.");
  });

  it("does not tag an enforcing one, and counts it as enforcing", async () => {
    wireClaude();
    readActive.mockReturnValue([
      { id: "org-guard", version: 1, effect: "enforce", sha256: "a", path: "p", deployment: 1 },
    ]);
    await listHooks(project);
    expect(text()).not.toContain("observe");
    expect(text()).not.toContain("Policies are not enforcing yet.");
  });

  it("lists them under the deployment's own heading, apart from anything switchable here", async () => {
    // Deliberately changed (D6): the "Managed from the dashboard — not
    // switchable with `failproofai policies`" note is gone. What says these
    // belong to the deployment, and that `--uninstall <name>` cannot touch
    // them, is the heading they sit under — never a pack or custom section.
    readActive.mockReturnValue([
      { id: "org-guard", version: 1, effect: "enforce", sha256: "a", path: "p", deployment: 1 },
    ]);
    await listHooks(project);
    const lines = text().split("\n");
    const heading = lines.findIndex((l) => l === "CLOUD-MANAGED  deployment 1");
    const row = lines.findIndex((l) => l.includes("org-guard"));
    expect(heading).toBeGreaterThan(-1);
    expect(row).toBe(heading + 1);
    expect(text()).not.toContain("Managed from the dashboard");
  });

  it("prints no section at all on a machine with no deployment", async () => {
    readActive.mockReturnValue([]);
    await listHooks(project);
    expect(text()).toContain("Turn on ours:");
    expect(text()).not.toContain("CLOUD-MANAGED");
  });

  it("survives an unreadable manifest rather than breaking the whole listing", async () => {
    readActive.mockImplementation(() => {
      throw new Error("corrupt manifest");
    });
    await expect(listHooks(project)).resolves.not.toThrow();
    expect(text()).not.toContain("CLOUD-MANAGED");
    // The rest of the listing must still have printed: it opens with the
    // wordmark header, like every other screen.
    expect(text()).toMatch(/^failproof ai {2}v\S+ {2}· {2}Policies$/m);
  });
});
