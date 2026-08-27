// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/hooks/cloud-managed-policies", () => ({
  readActiveCloudManagedPolicies: vi.fn(),
}));

import { listHooks } from "../../src/hooks/manager";
import { readActiveCloudManagedPolicies } from "../../src/hooks/cloud-managed-policies";

const readActive = vi.mocked(readActiveCloudManagedPolicies);

describe("failproofai policies — cloud-managed section", () => {
  let out: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
  afterEach(() => spy.mockRestore());

  const text = () => out.join("\n").replace(/\x1B\[[0-9;]*m/g, "");

  it("lists a deployed policy, with its version and the deployment number", async () => {
    readActive.mockReturnValue([
      { id: "org-guard", version: 3, effect: "enforce", sha256: "a", path: "p", deployment: 7 },
    ]);
    await listHooks();
    expect(text()).toContain("Cloud-managed — deployment 7");
    expect(text()).toContain("org-guard");
    expect(text()).toContain("v3");
  });

  it("marks an observe policy as OBS, never ON — its verdict is discarded", async () => {
    readActive.mockReturnValue([
      { id: "watch-only", version: 1, effect: "observe", sha256: "a", path: "p", deployment: 2 },
    ]);
    await listHooks();
    const line = text().split("\n").find((l) => l.includes("watch-only")) ?? "";
    expect(line).toContain("OBS");
    expect(line).not.toContain("✓ ON");
  });

  it("says these are not switchable locally, because --uninstall cannot touch them", async () => {
    readActive.mockReturnValue([
      { id: "org-guard", version: 1, effect: "enforce", sha256: "a", path: "p", deployment: 1 },
    ]);
    await listHooks();
    expect(text()).toContain("Managed from the dashboard");
  });

  it("prints no section at all on a machine with no deployment", async () => {
    readActive.mockReturnValue([]);
    await listHooks();
    expect(text()).not.toContain("Cloud-managed");
  });

  it("survives an unreadable manifest rather than breaking the whole listing", async () => {
    readActive.mockImplementation(() => {
      throw new Error("corrupt manifest");
    });
    await expect(listHooks()).resolves.not.toThrow();
    expect(text()).not.toContain("Cloud-managed");
    // The builtin listing above it must still have printed. The heading is the
    // command's own name now, like every other surface.
    expect(text()).toContain("failproofai policies");
  });
});
