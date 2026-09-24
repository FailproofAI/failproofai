// @vitest-environment node
//
// The config `setup --key-from-env` writes — sound, with no stored key — in a
// shell that does not set FAILPROOFAI_JEV_API_KEY. That is the normal case for
// a new shell and the only case for the daemon, which never sees a shell's
// environment, and it is not a broken file: Jev is simply off HERE.
//
// What this pins:
// - the loader reports it as its own state (`key-missing`), not `refused`;
// - `jev status` exits 0, says the config is fine, and does not tell its owner
//   to overwrite it — the advice that would undo the one reason to choose
//   --key-from-env;
// - `status --json` reports a configured machine (provider, endpoint, keySource
//   "env") so a provisioning check can tell it from a file it should rewrite;
// - a keyless file that is ALSO wrong further down is still `refused`;
// - `loadJevConfig()` stays null throughout: this state never turns Jev on.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { JEV_API_KEY_ENV, inspectJevConfig, jevConfigPath, loadJevConfig } from "../../src/hooks/semantic/jev-config";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["env", "key", "0123456789abcdef"].join("-");
const ACCOUNT = "0123456789abcdef0123456789abcdef";

// `setup` reads `<base>/models` before it writes, and a unit test must not reach a
// provider to do it — so every deps object in this file reads no list. The read
// itself is exercised in `jev-cli-contracts.test.ts`.
const noModelList = async () => ({ ok: false as const, reason: "no list read in tests" });

const RENDER = { render: { cols: 100, color: false }, readModelList: noModelList } satisfies JevCliDeps;
const noTty: JevCliDeps = { ...RENDER, stdinIsTTY: false, readStdin: async () => "" };
const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");

describe("a config whose key comes from the environment, in a shell without it", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV, "FAILPROOFAI_EVALUATOR"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-env-key-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  /** A jev.json written by hand, owner-only, in an owner-only directory. */
  function write(obj: Record<string, unknown>): void {
    mkdirSync(join(home, ".failproofai"), { recursive: true, mode: 0o700 });
    writeFileSync(jevConfigPath(), JSON.stringify(obj), { mode: 0o600 });
  }

  /** What `setup --key-from-env` leaves behind, written by the CLI itself. */
  async function setupFromEnv(...args: string[]): Promise<void> {
    process.env[JEV_API_KEY_ENV] = KEY;
    const r = await runJevCommand(["setup", "--key-from-env", ...args], noTty);
    expect(r.exitCode, text(r)).toBe(0);
    delete process.env[JEV_API_KEY_ENV];
  }

  it("is its own state in the loader, not a refusal", async () => {
    await setupFromEnv("--provider", "typesafe");
    const r = inspectJevConfig();
    expect(r.status).toBe("key-missing");
    if (r.status === "key-missing") {
      expect(r.routing.provider).toBe("typesafe");
      expect(r.problem).toContain(JEV_API_KEY_ENV);
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
    // Off here all the same: the hook path is unchanged.
    expect(loadJevConfig()).toBeNull();

    // And on again wherever the variable is set, from the same file.
    process.env[JEV_API_KEY_ENV] = KEY;
    expect(inspectJevConfig().status).toBe("ok");
    expect(loadJevConfig()?.apiKey).toBe(KEY);
  });

  it("status exits 0 and does not tell its owner to overwrite the config", async () => {
    await setupFromEnv("--provider", "cloudflare", "--account-id", ACCOUNT);
    const r = await runJevCommand(["status"], RENDER);
    expect(r.exitCode).toBe(0);
    const out = text(r);
    expect(out).toContain(JEV_API_KEY_ENV);
    expect(out).toContain("not set");
    expect(out).not.toContain("was refused");
    expect(out).not.toContain("Write a valid one");
    // It still shows where requests would go, so the config can be checked.
    expect(out).toContain("cloudflare");
    expect(out).toContain(ACCOUNT);
    expect(out).not.toContain(KEY);
  });

  it("status --json reports a configured machine, not an invalid one", async () => {
    await setupFromEnv("--provider", "vercel", "--mode", "shadow");
    const r = await runJevCommand(["status", "--json"], RENDER);
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.json as string) as Record<string, unknown>;
    expect(j.status).toBe("key-missing");
    expect(j.reason).toBe("no-env-key");
    expect(j.provider).toBe("vercel");
    expect(j.mode).toBe("shadow");
    expect(j.keySource).toBe("env");
    expect(j.keyEnvVar).toBe(JEV_API_KEY_ENV);
    expect(String(j.endpoint)).toContain("vercel");
    expect(r.json).not.toContain(KEY);
  });

  it("test says the variable is unset here, not that the file was refused", async () => {
    await setupFromEnv("--provider", "typesafe");
    const human = await runJevCommand(["test"], RENDER);
    expect(human.exitCode).toBe(1);
    expect(text(human)).toContain(JEV_API_KEY_ENV);
    expect(text(human)).not.toContain("was refused");
    const json = await runJevCommand(["test", "--json"], RENDER);
    expect(JSON.parse(json.json as string).error.code).toBe("no-env-key");
  });

  describe("a keyless file that is wrong further down is still refused", () => {
    // Validation stops at the missing key, so everything after it is unchecked
    // until the loader asks again with a stand-in.
    it.each([
      ["custom with no baseUrl", { provider: "custom" }],
      ["cloudflare with no accountId", { provider: "cloudflare" }],
      ["a model from another Jev family", { provider: "typesafe", model: "jev-1.14.0" }],
      ["a timeout out of bounds", { provider: "typesafe", timeoutMs: 60_000 }],
      ["a mode that is neither", { provider: "typesafe", mode: "off" }],
      ["loopback http in enforce mode", { provider: "custom", baseUrl: "http://localhost:8787/v1" }],
    ])("%s", (_name, obj) => {
      write(obj);
      const r = inspectJevConfig();
      expect(r.status).toBe("refused");
      expect(r.status === "refused" && r.reason).toBe("invalid");
      expect(loadJevConfig()).toBeNull();
    });

    it("and a variable that is set but malformed is refused, not reported as unset", () => {
      write({ provider: "typesafe" });
      process.env[JEV_API_KEY_ENV] = `${KEY}\r\nX-Injected: 1`;
      const r = inspectJevConfig();
      expect(r.status).toBe("refused");
      expect(r.status === "refused" && r.problem).toContain(JEV_API_KEY_ENV);
      expect(loadJevConfig()).toBeNull();
    });
  });
});
