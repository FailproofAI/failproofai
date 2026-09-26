// @vitest-environment node
//
// Review round 1 on `failproofai jev`: the key stays off the screen even when
// Cloudflare reports a failure inside a 200 or the key is pasted in the wrong
// place on the command line; a stored key is not carried to a new host; and
// `jev test` says so when an answer came back slower than the hook budget.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { JEV_API_KEY_ENV, jevConfigPath } from "../../src/hooks/semantic/jev-config";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["hard", "cli", "0123456789abcdefXYZ"].join("-");
const OTHER_KEY = ["hard", "other", "fedcba9876543210"].join("-");
const ACCOUNT = "0123456789abcdef0123456789abcdef";

// `setup` reads `<base>/models` before it writes, and a unit test must not reach a
// provider to do it — so every deps object in this file reads no list. The read
// itself is exercised in `jev-cli-contracts.test.ts`.
const noModelList = async () => ({ ok: false as const, reason: "no list read in tests" });

const RENDER = { render: { cols: 100, color: false }, readModelList: noModelList } satisfies JevCliDeps;
const withKey = (key: string): JevCliDeps => ({ ...RENDER, stdinIsTTY: false, readStdin: async () => `${key}\n` });
const noTty: JevCliDeps = { ...RENDER, stdinIsTTY: false, readStdin: async () => "" };

const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");
const readFile = () => JSON.parse(readFileSync(jevConfigPath(), "utf8")) as Record<string, unknown>;

const realFetch = globalThis.fetch;

describe("failproofai jev — review hardening", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV, "FAILPROOFAI_EVALUATOR"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-cli-hard-"));
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

  describe("jev test never prints the key", () => {
    it("when Cloudflare reports a failure inside a 200 that echoes the token (human and --json)", async () => {
      await runJevCommand(["setup", "--provider", "cloudflare", "--account-id", ACCOUNT, "--key-stdin"], withKey(KEY));
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: `Invalid token ${KEY}` }], result: null }), {
          status: 200,
        })) as typeof fetch;
      const human = await runJevCommand(["test"], RENDER);
      expect(human.exitCode).toBe(1);
      expect(text(human)).toContain("cloudflare-error");
      expect(text(human)).not.toContain(KEY);
      const json = await runJevCommand(["test", "--json"], RENDER);
      expect(json.exitCode).toBe(1);
      expect(json.json).not.toContain(KEY);
      expect(JSON.parse(json.json as string)).toMatchObject({ ok: false, error: { code: "cloudflare-error" } });
    });

    it("when a network error carries the key", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      globalThis.fetch = (async () => {
        throw new TypeError(`fetch failed: ${KEY}`);
      }) as unknown as typeof fetch;
      const human = await runJevCommand(["test"], RENDER);
      expect(human.exitCode).toBe(1);
      expect(text(human)).toContain("network");
      expect(text(human)).not.toContain(KEY);
      const json = await runJevCommand(["test", "--json"], RENDER);
      expect(json.json).not.toContain(KEY);
    });

    it("when the provider reports the key as its model id", async () => {
      await runJevCommand(["setup", "--provider", "openrouter", "--key-stdin"], withKey(KEY));
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ model: KEY, answers: { jev_test: { type: "noul", noul: 0.9 } } }), { status: 200 })) as typeof fetch;
      const human = await runJevCommand(["test"], RENDER);
      expect(human.exitCode).toBe(1);
      expect(text(human)).toContain("model-mismatch");
      expect(text(human)).not.toContain(KEY);
      expect((await runJevCommand(["test", "--json"], RENDER)).json).not.toContain(KEY);
    });
  });

  describe("setup never repeats a value it could not use", () => {
    it("a key pasted as a stray argument", async () => {
      const r = await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin", KEY], noTty);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("Unexpected argument");
      expect(text(r)).not.toContain(KEY);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("a key pasted as the provider", async () => {
      const r = await runJevCommand(["setup", "--provider", KEY], noTty);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("Unknown provider");
      expect(text(r)).toContain("typesafe, openrouter, vercel, cloudflare, custom");
      expect(text(r)).not.toContain(KEY);
    });

    it("a key pasted as the timeout", async () => {
      const r = await runJevCommand(["setup", "--provider", "typesafe", "--timeout-ms", KEY, "--key-stdin"], withKey(OTHER_KEY));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("--timeout-ms");
      expect(text(r)).not.toContain(KEY);
      expect(text(r)).not.toContain(OTHER_KEY);
    });

    it("a key pasted as the account id, mode or base URL", async () => {
      for (const argv of [
        ["setup", "--provider", "cloudflare", "--account-id", KEY, "--key-stdin"],
        ["setup", "--provider", "typesafe", "--mode", KEY, "--key-stdin"],
        ["setup", "--provider", "custom", "--base-url", KEY, "--key-stdin"],
      ]) {
        const r = await runJevCommand(argv, withKey(OTHER_KEY));
        expect(r.exitCode).toBe(1);
        expect(text(r)).not.toContain(KEY);
      }
    });
  });

  describe("a stored key is not carried to a new host", () => {
    const A = "https://gateway-a.example.com/v1";
    const B = "https://gateway-b.example.net/v1";

    it("custom: a new --base-url on another origin needs the key again, and writes nothing without it", async () => {
      await runJevCommand(["setup", "--provider", "custom", "--base-url", A, "--key-stdin"], withKey(KEY));
      const r = await runJevCommand(["setup", "--base-url", B], noTty);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("https://gateway-b.example.net");
      expect(text(r)).toContain("--key-stdin");
      expect(text(r)).not.toContain(KEY);
      expect(readFile()).toEqual({ provider: "custom", baseUrl: A, apiKey: KEY });
    });

    it("custom: given the key again, the move is saved with it", async () => {
      await runJevCommand(["setup", "--provider", "custom", "--base-url", A, "--key-stdin"], withKey(KEY));
      const r = await runJevCommand(["setup", "--base-url", B, "--key-stdin"], withKey(OTHER_KEY));
      expect(r.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "custom", baseUrl: B, apiKey: OTHER_KEY });
    });

    it("on a terminal, the move asks for the key at the masked prompt", async () => {
      await runJevCommand(["setup", "--provider", "custom", "--base-url", A, "--key-stdin"], withKey(KEY));
      let prompted = false;
      const r = await runJevCommand(["setup", "--base-url", B], {
        ...RENDER,
        stdinIsTTY: true,
        promptKey: async () => {
          prompted = true;
          return OTHER_KEY;
        },
      });
      expect(r.exitCode).toBe(0);
      expect(prompted).toBe(true);
      expect(readFile().apiKey).toBe(OTHER_KEY);
      expect(text(r)).toContain("https://gateway-b.example.net");
    });

    it("the same origin on another path keeps the key", async () => {
      await runJevCommand(["setup", "--provider", "custom", "--base-url", A, "--key-stdin"], withKey(KEY));
      const r = await runJevCommand(["setup", "--base-url", "https://gateway-a.example.com/v2"], noTty);
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain("kept from the existing config");
      expect(readFile()).toEqual({ provider: "custom", baseUrl: "https://gateway-a.example.com/v2", apiKey: KEY });
    });

    it("typesafe: an override to a foreign host needs the key; back to the provider's own API keeps it", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      const away = await runJevCommand(["setup", "--base-url", "https://jev-proxy.example.com/v1"], noTty);
      expect(away.exitCode).toBe(1);
      expect(readFile()).toEqual({ provider: "typesafe", apiKey: KEY });

      await runJevCommand(["setup", "--base-url", "https://jev-proxy.example.com/v1", "--key-stdin"], withKey(OTHER_KEY));
      expect(readFile()).toEqual({ provider: "typesafe", baseUrl: "https://jev-proxy.example.com/v1", apiKey: OTHER_KEY });
      const back = await runJevCommand(["setup", "--base-url", "https://api.typesafe.ai/v1"], noTty);
      expect(back.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "typesafe", baseUrl: "https://api.typesafe.ai/v1", apiKey: OTHER_KEY });
    });

    it("cloudflare: a proxy base URL needs the token again", async () => {
      await runJevCommand(["setup", "--provider", "cloudflare", "--account-id", ACCOUNT, "--key-stdin"], withKey(KEY));
      const r = await runJevCommand(["setup", "--base-url", "https://cf-proxy.example.com/client/v4"], noTty);
      expect(r.exitCode).toBe(1);
      expect(readFile().baseUrl).toBeUndefined();
    });

    it("an environment-key config moving host is asked to choose again too", async () => {
      await runJevCommand(["setup", "--provider", "custom", "--base-url", A, "--key-from-env"], noTty);
      const r = await runJevCommand(["setup", "--base-url", B], noTty);
      expect(r.exitCode).toBe(1);
      expect(readFile()).toEqual({ provider: "custom", baseUrl: A });
      const again = await runJevCommand(["setup", "--base-url", B, "--key-from-env"], noTty);
      expect(again.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "custom", baseUrl: B });
    });
  });

  describe("setup refuses plain-http loopback outside shadow mode", () => {
    it("enforce (the default) is refused with the reason; shadow is saved", async () => {
      const enforce = await runJevCommand(["setup", "--provider", "custom", "--base-url", "http://localhost:8787/v1", "--key-stdin"], withKey(KEY));
      expect(enforce.exitCode).toBe(1);
      expect(text(enforce)).toContain("shadow");
      expect(existsSync(jevConfigPath())).toBe(false);

      const shadow = await runJevCommand(
        ["setup", "--provider", "custom", "--base-url", "http://localhost:8787/v1", "--mode", "shadow", "--key-stdin"],
        withKey(KEY),
      );
      expect(shadow.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ baseUrl: "http://localhost:8787/v1", mode: "shadow" });

      // And the mode cannot then be switched to enforce underneath it.
      const flip = await runJevCommand(["setup", "--mode", "enforce"], noTty);
      expect(flip.exitCode).toBe(1);
      expect(readFile().mode).toBe("shadow");
    });
  });

  describe("jev test and the hook budget", () => {
    it("an answer slower than timeoutMs is reported as over it (human and --json)", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--timeout-ms", "100", "--key-stdin"], withKey(KEY));
      globalThis.fetch = (async () => {
        await new Promise((r) => setTimeout(r, 250));
        return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { jev_test: { type: "noul", noul: 0.95 } } }), { status: 200 });
      }) as unknown as typeof fetch;

      // Every hook call on this route falls back as `timeout`: not "ok", and not exit 0.
      const json = await runJevCommand(["test", "--json"], RENDER);
      expect(json.exitCode).toBe(1);
      const j = JSON.parse(json.json as string);
      expect(j).toMatchObject({ ok: false, problem: "over-timeout", timeoutMs: 100, withinTimeout: false });
      expect(j.latencyMs).toBeGreaterThan(100);

      const human = await runJevCommand(["test"], RENDER);
      expect(human.exitCode).toBe(1);
      expect(text(human)).toContain("OVER the 100 ms timeout: hooks would fall back to regex");
      expect(text(human)).toContain("over timeout");
      expect(text(human)).not.toContain("ok ·");
      expect(text(human)).toContain("--timeout-ms");
    });

    it("a wrong answer to the calibration question is not ok", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--timeout-ms", "5000", "--key-stdin"], withKey(KEY));
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ model: "jev-1.13.0", answers: { jev_test: { type: "noul", noul: 0.01 } } }), { status: 200 })) as typeof fetch;
      const json = await runJevCommand(["test", "--json"], RENDER);
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.json as string)).toMatchObject({ ok: false, problem: "unexpected-answer" });
      const human = await runJevCommand(["test"], RENDER);
      expect(human.exitCode).toBe(1);
      expect(text(human)).toContain("wrong answer");
    });

    // A Cloud route maps its own upstream timeout to 502; after 3x the budget a
    // hook has long since recorded `timeout`, so "server error" is the wrong lead.
    it("a failure that arrived after timeoutMs names the hook budget, not a server error", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--timeout-ms", "100", "--key-stdin"], withKey(KEY));
      globalThis.fetch = (async () => {
        await new Promise((r) => setTimeout(r, 250));
        return new Response(JSON.stringify({ error: { message: "upstream_error" } }), { status: 502 });
      }) as unknown as typeof fetch;
      const human = await runJevCommand(["test"], RENDER);
      expect(human.exitCode).toBe(1);
      expect(text(human)).toContain("OVER the 100 ms timeout: hooks would fall back to regex (timeout)");
      expect(text(human)).not.toContain("The provider had a server error");
    });

    it("an answer inside timeoutMs is reported as within it", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--timeout-ms", "5000", "--key-stdin"], withKey(KEY));
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ model: "jev-1.13.0", answers: { jev_test: { type: "noul", noul: 0.95 } } }), { status: 200 })) as typeof fetch;
      const j = JSON.parse((await runJevCommand(["test", "--json"], RENDER)).json as string);
      expect(j).toMatchObject({ ok: true, timeoutMs: 5000, withinTimeout: true });
    });
  });
});
