// @vitest-environment node
//
// `jev test` scrubs the key from whatever error it prints, independently of
// jev-client's own scrubbing: the transport here throws raw text carrying the
// key, the way a future transport (or a wrapper such as the throttle) might.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = ["scrub", "cli", "0123456789abcdefXYZ"].join("-");
const thrown: { current: unknown } = { current: null };

vi.mock("../../src/hooks/semantic/jev-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/semantic/jev-client")>();
  return {
    ...actual,
    transportForConfig: (cfg: Parameters<typeof actual.transportForConfig>[0]) => {
      const built = actual.transportForConfig(cfg);
      return {
        ...built,
        transport: async () => {
          throw thrown.current;
        },
      };
    },
  };
});

const { runJevCommand } = await import("../../src/hooks/jev-cli");
const { JevError } = await import("../../src/hooks/semantic/jev-client");
const { JEV_API_KEY_ENV } = await import("../../src/hooks/semantic/jev-config");

const RENDER = { render: { cols: 100, color: false } };
const withKey = { ...RENDER, stdinIsTTY: false, readStdin: async () => `${KEY}\n` };

describe("jev test: the last line of defence", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-cli-scrub-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ["a JevError", () => new JevError("upstream-error", `rejected ${KEY}`), "upstream-error"],
    ["a plain Error", () => new Error(`boom ${KEY}`), "error"],
  ])("scrubs %s carrying the key (human and --json)", async (_name, make, code) => {
    expect((await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey)).exitCode).toBe(0);
    thrown.current = make();
    const human = await runJevCommand(["test"], RENDER);
    expect(human.exitCode).toBe(1);
    const out = human.lines.join("\n");
    expect(out).toContain(code);
    expect(out).toContain("[key]");
    expect(out).not.toContain(KEY);
    const json = await runJevCommand(["test", "--json"], RENDER);
    expect(json.json).not.toContain(KEY);
    expect(JSON.parse(json.json as string)).toMatchObject({ ok: false, error: { code } });
  });

  it("scrubs an environment-supplied key too", async () => {
    process.env[JEV_API_KEY_ENV] = KEY;
    expect((await runJevCommand(["setup", "--provider", "typesafe", "--key-from-env"], { ...RENDER, stdinIsTTY: false })).exitCode).toBe(0);
    thrown.current = new JevError("network", `socket hang up ${KEY}`);
    const human = await runJevCommand(["test"], RENDER);
    expect(human.lines.join("\n")).not.toContain(KEY);
  });
});
