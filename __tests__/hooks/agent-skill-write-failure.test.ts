// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const write = vi.hoisted(() => vi.fn());
vi.mock("../../src/hooks/safe-config-write", () => ({ writeConfigFileAtomic: write }));

import { installAgentSkill } from "../../src/hooks/agent-skill";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "fpai-skill-failure-"));
  process.env.HOME = home;
  write.mockReset().mockImplementation(() => { throw new Error("disk full"); });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("installAgentSkill after a write failure", () => {
  it("removes only the empty directory this call created", () => {
    const dir = join(home, ".claude", "skills", "failproofai");
    expect(installAgentSkill(["claude"])).toEqual([]);
    expect(existsSync(dir)).toBe(false);

    mkdirSync(dir, { recursive: true });
    expect(installAgentSkill(["claude"])).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});
