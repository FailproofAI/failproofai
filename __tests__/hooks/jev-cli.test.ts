// @vitest-environment node
//
// `failproofai jev setup | status | test | remove`, driven in-process against a
// throwaway FAILPROOFAI_HOME with a mocked fetch. The one rule that runs through
// every case: no output — human or --json, success or failure — contains the key.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevStatsLines, runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { JEV_API_KEY_ENV, jevConfigPath, loadJevConfig } from "../../src/hooks/semantic/jev-config";

const KEY = ["cli", "test", "0123456789abcdef"].join("-");
const OTHER_KEY = ["cli", "other", "fedcba9876543210"].join("-");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const posix = process.platform !== "win32";

// `setup` reads `<base>/models` before it writes, and a unit test must not reach a
// provider to do it — so every deps object in this file reads no list. The read
// itself is exercised in `jev-cli-contracts.test.ts`.
const noModelList = async () => ({ ok: false as const, reason: "no list read in tests" });

const RENDER = { render: { cols: 100, color: false }, readModelList: noModelList } satisfies JevCliDeps;
const withKey = (key: string): JevCliDeps => ({ ...RENDER, stdinIsTTY: false, readStdin: async () => `${key}\n` });
const noTty: JevCliDeps = { ...RENDER, stdinIsTTY: false, readStdin: async () => "" };

// Whitespace collapsed, so an assertion does not depend on where a line wrapped.
const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");
const readFile = () => JSON.parse(readFileSync(jevConfigPath(), "utf8")) as Record<string, unknown>;

const realFetch = globalThis.fetch;

describe("failproofai jev", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV, "FAILPROOFAI_EVALUATOR"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-cli-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  describe("setup", () => {
    it("writes jev.json owner-only from a key on stdin, and never prints the key", async () => {
      const r = await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      expect(r.exitCode).toBe(0);
      expect(text(r)).not.toContain(KEY);
      expect(readFile()).toEqual({ provider: "typesafe", apiKey: KEY });
      if (posix) expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
      if (posix) expect(statSync(join(home, ".failproofai")).mode & 0o077).toBe(0);
      expect(text(r)).toContain("https://api.typesafe.ai/v1/systemone");
      expect(text(r)).toContain("jev-1.13.0 (provider default)");
      expect(text(r)).toContain("enforce");
      expect(text(r)).toContain("failproofai jev test");
      expect(loadJevConfig()).toMatchObject({ provider: "typesafe", apiKey: KEY, mode: "enforce" });
    });

    it("writes every option it is given", async () => {
      const r = await runJevCommand(
        ["setup", "--provider=cloudflare", "--account-id", ACCOUNT, "--model", "typesafe/jev", "--mode", "shadow", "--timeout-ms", "900", "--key-stdin"],
        withKey(KEY),
      );
      expect(r.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "cloudflare", apiKey: KEY, accountId: ACCOUNT, model: "typesafe/jev", mode: "shadow", timeoutMs: 900 });
      expect(text(r)).toContain(`accounts/${ACCOUNT}/ai/run`);
      expect(text(r)).toContain("shadow");
    });

    it("needs --provider the first time, and a real one", async () => {
      expect((await runJevCommand(["setup", "--key-stdin"], withKey(KEY))).exitCode).toBe(1);
      const bad = await runJevCommand(["setup", "--provider", "anthropic", "--key-stdin"], withKey(KEY));
      expect(bad.exitCode).toBe(1);
      expect(text(bad)).toContain("Unknown provider");
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("writes nothing when the result would not load", async () => {
      const r = await runJevCommand(["setup", "--provider", "cloudflare", "--key-stdin"], withKey(KEY));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("accountId");
      expect(existsSync(jevConfigPath())).toBe(false);

      const http = await runJevCommand(["setup", "--provider", "custom", "--base-url", "http://jev.example.com", "--key-stdin"], withKey(KEY));
      expect(http.exitCode).toBe(1);
      expect(text(http)).toContain("https");

      const model = await runJevCommand(["setup", "--provider", "typesafe", "--model", "jev-1.14.0", "--key-stdin"], withKey(KEY));
      expect(model.exitCode).toBe(1);
      expect(text(model)).toContain("calibrated");

      const timeout = await runJevCommand(["setup", "--provider", "typesafe", "--timeout-ms", "soon", "--key-stdin"], withKey(KEY));
      expect(timeout.exitCode).toBe(1);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("refuses a key that is not one clean line, without echoing it", async () => {
      const dirty = `${KEY} trailing-part`;
      const r = await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(dirty));
      expect(r.exitCode).toBe(1);
      expect(text(r)).not.toContain(KEY);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("with no key and no terminal, says how to pass one and writes nothing", async () => {
      const r = await runJevCommand(["setup", "--provider", "typesafe"], noTty);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("--key-stdin");
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("on a terminal, --key-stdin uses the masked prompt instead of an echoing read", async () => {
      let stdinRead = false;
      let prompted = false;
      const r = await runJevCommand(["setup", "--provider", "vercel", "--key-stdin"], {
        ...RENDER,
        stdinIsTTY: true,
        readStdin: async () => {
          stdinRead = true;
          return "";
        },
        promptKey: async () => {
          prompted = true;
          return KEY;
        },
      });
      expect(r.exitCode).toBe(0);
      expect(prompted).toBe(true);
      expect(stdinRead).toBe(false);
      expect(readFile().apiKey).toBe(KEY);
    });

    it("a cancelled prompt writes nothing", async () => {
      const r = await runJevCommand(["setup", "--provider", "vercel"], { ...RENDER, stdinIsTTY: true, promptKey: async () => null });
      expect(r.exitCode).toBe(1);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("re-running for the same provider keeps the key, so a mode switch is one flag", async () => {
      await runJevCommand(["setup", "--provider", "cloudflare", "--account-id", ACCOUNT, "--key-stdin"], withKey(KEY));
      const r = await runJevCommand(["setup", "--mode", "shadow"], noTty);
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain("kept from the existing config");
      expect(readFile()).toEqual({ provider: "cloudflare", apiKey: KEY, accountId: ACCOUNT, mode: "shadow" });
    });

    it("switching provider starts over: no key, model or URL carries across, mode does", async () => {
      await runJevCommand(["setup", "--provider", "custom", "--base-url", "https://jev.example.com/v1", "--mode", "shadow", "--key-stdin"], withKey(KEY));
      const noKey = await runJevCommand(["setup", "--provider", "vercel"], noTty);
      expect(noKey.exitCode).toBe(1);
      expect(readFile().provider).toBe("custom");

      const r = await runJevCommand(["setup", "--provider", "vercel", "--key-stdin"], withKey(OTHER_KEY));
      expect(r.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "vercel", apiKey: OTHER_KEY, mode: "shadow" });
    });

    it("`default` clears a model or base URL override", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--model", "jev-1.13.2", "--base-url", "https://eu.api.typesafe.ai/v1", "--key-stdin"], withKey(KEY));
      expect(readFile()).toMatchObject({ model: "jev-1.13.2", baseUrl: "https://eu.api.typesafe.ai/v1" });
      await runJevCommand(["setup", "--model", "default", "--base-url", "default"], noTty);
      expect(readFile()).toEqual({ provider: "typesafe", apiKey: KEY });
    });

    it.skipIf(!posix)("re-saves a file that was too open at 0600, keeping its key", async () => {
      mkdirSync(join(home, ".failproofai"), { recursive: true });
      writeFileSync(jevConfigPath(), JSON.stringify({ provider: "typesafe", apiKey: KEY }), { mode: 0o644 });
      chmodSync(jevConfigPath(), 0o644);
      expect(loadJevConfig()).toBeNull();
      const r = await runJevCommand(["setup"], noTty);
      expect(r.exitCode).toBe(0);
      expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
      expect(loadJevConfig()?.apiKey).toBe(KEY);
    });

    it(`--key-from-env stores no key and reads ${JEV_API_KEY_ENV} at run time`, async () => {
      const unset = await runJevCommand(["setup", "--provider", "typesafe", "--key-from-env"], noTty);
      expect(unset.exitCode).toBe(0);
      expect(text(unset)).toContain("is not set in this shell");
      expect(readFile()).toEqual({ provider: "typesafe" });
      expect(loadJevConfig()).toBeNull();

      process.env[JEV_API_KEY_ENV] = KEY;
      const r = await runJevCommand(["setup", "--provider", "typesafe", "--key-from-env"], noTty);
      expect(r.exitCode).toBe(0);
      expect(text(r)).not.toContain(KEY);
      expect(readFile()).toEqual({ provider: "typesafe" });
      expect(loadJevConfig()?.apiKey).toBe(KEY);
      // A re-run for the same provider keeps it an environment-key config.
      const again = await runJevCommand(["setup", "--mode", "shadow"], noTty);
      expect(again.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "typesafe", mode: "shadow" });
      // A variable that is set but malformed is refused, not stored around.
      process.env[JEV_API_KEY_ENV] = "two words";
      expect((await runJevCommand(["setup", "--provider", "typesafe", "--key-from-env"], noTty)).exitCode).toBe(1);
      delete process.env[JEV_API_KEY_ENV];
      expect(loadJevConfig()).toBeNull();
    });

    it("rejects unknown options and stray arguments", async () => {
      expect((await runJevCommand(["setup", "--provider", "typesafe", "--key", KEY], noTty)).exitCode).toBe(1);
      expect((await runJevCommand(["setup", "typesafe"], noTty)).exitCode).toBe(1);
      expect((await runJevCommand(["setup", "--provider"], noTty)).exitCode).toBe(1);
      expect((await runJevCommand(["setup", "--key-stdin", "--key-from-env", "--provider", "typesafe"], noTty)).exitCode).toBe(1);
      expect(existsSync(jevConfigPath())).toBe(false);
    });
  });

  describe("status", () => {
    it("says Jev is off, and how to turn it on, when there is no config", async () => {
      const r = await runJevCommand(["status"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain("Jev is off");
      expect(text(r)).toContain("regex policies exactly as before");
      expect(text(r)).toContain("failproofai jev setup");
      expect(text(r)).toContain("No Jev evaluations recorded");
    });

    it("shows provider, endpoint, model, mode, path and permissions — never the key", async () => {
      await runJevCommand(["setup", "--provider", "openrouter", "--mode", "shadow", "--key-stdin"], withKey(KEY));
      const r = await runJevCommand(["status"], RENDER);
      expect(r.exitCode).toBe(0);
      const out = text(r);
      expect(out).not.toContain(KEY);
      expect(out).toContain("openrouter");
      expect(out).toContain("https://openrouter.ai/api/v1/systemone");
      expect(out).toContain("typesafe/jev-1.13 (provider default)");
      expect(out).toContain("shadow");
      expect(out).toContain(jevConfigPath());
      if (posix) expect(out).toContain("0600 (owner-only)");
      expect(out).toContain("set in the config file");
    });

    it("--json carries the same facts, machine-readable, without the key", async () => {
      await runJevCommand(["setup", "--provider", "cloudflare", "--account-id", ACCOUNT, "--key-stdin"], withKey(KEY));
      const r = await runJevCommand(["status", "--json"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(r.json).toBeDefined();
      expect(r.json).not.toContain(KEY);
      const j = JSON.parse(r.json as string);
      expect(j).toMatchObject({
        status: "ok",
        path: jevConfigPath(),
        provider: "cloudflare",
        endpoint: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`,
        model: "typesafe/jev",
        modelIsDefault: true,
        mode: "enforce",
        timeoutMs: 3000,
        keySource: "file",
        legacyOverride: false,
      });
      if (posix) expect(j.permissions).toBe("0600");
      expect(j.stats).toMatchObject({ total: 0 });
    });

    it.skipIf(!posix)("reports a too-open config as refused, with the fix, and exits 1", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      chmodSync(jevConfigPath(), 0o644);
      const r = await runJevCommand(["status"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("refused");
      expect(text(r)).toContain(`chmod 600 ${jevConfigPath()}`);
      expect(text(r)).not.toContain(KEY);
    });

    it("notices FAILPROOFAI_EVALUATOR=legacy in this shell", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      process.env.FAILPROOFAI_EVALUATOR = "legacy";
      const r = await runJevCommand(["status"], RENDER);
      expect(text(r)).toContain("FAILPROOFAI_EVALUATOR=legacy");
    });

    it("renders activity from jevStats()", () => {
      const lines = jevStatsLines(
        {
          windowMs: 24 * 3_600_000,
          total: 200,
          fallbackRate: 0.035,
          fallbackReasons: { "http-429": 5, timeout: 2 },
          latencyP50Ms: 41.2,
          latencyP95Ms: 212.7,
          clearsByPolicy: { "block-read-outside-cwd": 12, "protect-env-vars": 3 },
        },
        { cols: 100 },
      ).join("\n");
      expect(lines).toContain("last 24 hours");
      expect(lines).toContain("200");
      expect(lines).toContain("3.5% (http-429 ×5, timeout ×2)");
      expect(lines).toContain("p50 41 ms · p95 213 ms");
      expect(lines).toContain("block-read-outside-cwd ×12, protect-env-vars ×3");
      expect(jevStatsLines(null).join("\n")).toContain("could not be read");
    });
  });

  describe("test", () => {
    function answerWith(model: string | null, opts: { status?: number; body?: unknown; cloudflare?: boolean } = {}) {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ url: String(url), body });
        if (opts.body !== undefined) return new Response(JSON.stringify(opts.body), { status: opts.status ?? 200 });
        const native = { ...(model ? { model } : {}), answers: { jev_test: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 31 } };
        const payload = opts.cloudflare ? { success: true, result: { state: "Completed", result: native } } : native;
        return new Response(JSON.stringify(payload), { status: opts.status ?? 200 });
      }) as typeof fetch;
      return calls;
    }

    it("sends one tiny request and prints latency and the version that answered", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      const calls = answerWith("jev-1.13.0");
      const r = await runJevCommand(["test"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(Object.keys(calls[0].body.questions as object)).toEqual(["jev_test"]);
      expect(JSON.stringify(calls[0].body).length).toBeLessThan(400);
      const out = text(r);
      expect(out).toMatch(/latency\s+\d+ ms — within the 3000 ms timeout/);
      expect(out).toContain("jev-1.13.0 (Jev 1.13 family — verified)");
      expect(out).toContain("p = 0.970");
      expect(out).not.toContain(KEY);
    });

    it("--json reports the reported model, verification and latency", async () => {
      await runJevCommand(["setup", "--provider", "openrouter", "--key-stdin"], withKey(KEY));
      answerWith("typesafe/jev-1.13-20260917");
      const r = await runJevCommand(["test", "--json"], RENDER);
      expect(r.exitCode).toBe(0);
      const j = JSON.parse(r.json as string);
      expect(j).toMatchObject({ ok: true, provider: "openrouter", model: "typesafe/jev-1.13", reportedModel: "typesafe/jev-1.13-20260917", modelVerified: true, answer: 0.97, inputTokens: 31, timeoutMs: 3000 });
      expect(typeof j.latencyMs).toBe("number");
      expect(r.json).not.toContain(KEY);
    });

    it("says so when the provider names Jev only by an alias", async () => {
      await runJevCommand(["setup", "--provider", "cloudflare", "--account-id", ACCOUNT, "--key-stdin"], withKey(KEY));
      answerWith("typesafe/jev", { cloudflare: true });
      const r = await runJevCommand(["test", "--json"], RENDER);
      const j = JSON.parse(r.json as string);
      expect(j).toMatchObject({ ok: true, modelVerified: false, reportedModel: null });
      const human = await runJevCommand(["test"], RENDER);
      expect(text(human)).toContain("modelVerified: false");
    });

    it.each([
      [401, { error: { message: "bad key" } }, "http-401", "refused the key"],
      [402, { error: { message: "Insufficient credits" } }, "out-of-credits", "out of credits"],
      [429, { error: { message: "slow down" } }, "http-429", "rate-limited"],
      [503, { error: { message: "down" } }, "http-503", "server error"],
    ])("HTTP %s → exit 1 with %s and what to do", async (status, body, code, hint) => {
      await runJevCommand(["setup", "--provider", "vercel", "--key-stdin"], withKey(KEY));
      answerWith(null, { status, body });
      const r = await runJevCommand(["test"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain(code);
      expect(text(r)).toContain(hint);
      expect(text(r)).not.toContain(KEY);
      const j = await runJevCommand(["test", "--json"], RENDER);
      expect(JSON.parse(j.json as string)).toMatchObject({ ok: false, error: { code } });
    });

    it("a different Jev family answering is a failure", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      answerWith("jev-1.14.0");
      const r = await runJevCommand(["test"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("model-mismatch");
    });

    it("scrubs a key the provider echoes in its error", async () => {
      await runJevCommand(["setup", "--provider", "openrouter", "--key-stdin"], withKey(KEY));
      answerWith(null, { status: 401, body: { error: { message: `No auth for ${KEY}` } } });
      const r = await runJevCommand(["test"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).not.toContain(KEY);
    });

    it("does nothing, and says why, without a usable config", async () => {
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch;
      const r = await runJevCommand(["test"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("nothing to test");
      expect(called).toBe(false);
    });
  });

  describe("remove", () => {
    it("deletes the config; Jev is off from the next load", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      expect(loadJevConfig()).not.toBeNull();
      const r = await runJevCommand(["remove"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(existsSync(jevConfigPath())).toBe(false);
      expect(loadJevConfig()).toBeNull();
      expect(text(r)).toContain("regex policies exactly as before");
    });

    it("is a no-op, not an error, when there is nothing to remove", async () => {
      const r = await runJevCommand(["remove"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain("already off");
    });
  });

  it("rejects an unknown or missing subcommand with the usage", async () => {
    for (const argv of [[], ["enable"], ["status", "extra"], ["remove", "--force"]]) {
      const r = await runJevCommand(argv, RENDER);
      expect(r.exitCode).toBe(1);
    }
    expect(text(await runJevCommand(["enable"], RENDER))).toContain("failproofai jev setup");
  });
});
