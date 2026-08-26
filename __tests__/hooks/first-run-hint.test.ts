// @vitest-environment node
/**
 * A machine that has just finished setup enforces almost nothing — setup wires
 * the hooks and deliberately chooses NO policies — and none of the three
 * surfaces a new user actually looks at said how to change that. `failproofai
 * policies` printed a header and a config path. The onboarding audit printed a
 * count of findings. Both are dead ends for the person most likely to hit them.
 *
 * Each surface names the pack in FULL (`FailproofAI/policies`), which is the
 * same shape anyone else's is typed in. That is the point: there is no short
 * name only we can use.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORE_SOURCE } from "../../src/hooks/pack-store";

const BINARY = resolve(__dirname, "..", "..", "bin", "failproofai.mjs");
const HOME = mkdtempSync(join(tmpdir(), "fpai-firstrun-"));

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function cli(...args: string[]): string {
  const r = spawnSync("bun", [BINARY, ...args], {
    // Run from a directory with no project config, so the listing is about the
    // fresh machine and not about this repo's own dogfood hooks.
    cwd: HOME,
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      FAILPROOFAI_HOME: join(HOME, ".failproofai"),
      FAILPROOFAI_TELEMETRY_DISABLED: "1",
      NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

describe("a machine with no policies says how to get some", () => {
  it("`policies` names the pack, in full", () => {
    const out = cli("policies");
    expect(out).toMatch(/Nothing is enforcing yet/);
    expect(out).toContain(`failproofai policies add ${CORE_SOURCE}`);
  });

  it("`policies` points at everyone else's packs too, not only ours", () => {
    // Ours being FIRST is a convenience, not a channel. If the listing named
    // only ours it would read as the place policies come from.
    const out = cli("policies");
    expect(out).toMatch(/policies add <owner>\/<repo>/);
    expect(out).toMatch(/policies show <owner>\/<repo>/);
  });

  it("offers no short name of our own anywhere in that hint", () => {
    // The whole reason `core` was retired: a spelling only we can type makes
    // our policies look like part of the tool rather than one pack among many.
    const out = cli("policies");
    expect(out).not.toMatch(/policies add core\b/);
  });
});
