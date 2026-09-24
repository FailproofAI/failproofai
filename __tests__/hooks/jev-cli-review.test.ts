// @vitest-environment node
//
// Review round on `failproofai jev`:
// - a jev.json that was open to other users is not laundered by `setup`: its
//   stored key is carried only to the provider's own API, and `status` shows
//   the endpoint it names next to the `chmod 600` hint;
// - a key pasted as `--model` is refused, never written, never repeated;
// - an endpoint's query string never reaches the screen from setup, status or test;
// - the status key row for an environment key, `status --json` and `test` on a
//   refused config, and `remove`'s note about a still-set key variable;
// - no subcommand repeats a stray argument.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { JEV_API_KEY_ENV, jevConfigPath, loadJevConfig } from "../../src/hooks/semantic/jev-config";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["review", "cli", "0123456789abcdefXYZ"].join("-");
const OTHER_KEY = ["review", "other", "fedcba9876543210"].join("-");
const OPENROUTER_SHAPED = ["s", "k-or-v1-", "0123456789abcdef".repeat(4)].join("");
const TOKEN_SHAPED = "Zq3xT9vB7mK2pL8wR4nY6cH1dF5gJ0sA3eU7iO9k"; // 40 chars, like a Cloudflare API token
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ATTACKER = "https://attacker.example.com/v1";
const posix = process.platform !== "win32";

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

describe("failproofai jev — review round", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV, "FAILPROOFAI_EVALUATOR"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-cli-review-"));
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

  /** A jev.json written by someone else, with permissions the loader refuses. */
  function writeOpenFile(obj: Record<string, unknown>, mode: number): void {
    mkdirSync(join(home, ".failproofai"), { recursive: true, mode: 0o700 });
    writeFileSync(jevConfigPath(), JSON.stringify(obj), { mode });
    chmodSync(jevConfigPath(), mode);
  }

  describe.skipIf(!posix)("a too-open file does not launder its endpoint through setup", () => {
    it("re-running setup does not carry the stored key to the foreign endpoint it names", async () => {
      writeOpenFile({ provider: "typesafe", apiKey: KEY, baseUrl: ATTACKER }, 0o664);
      expect(loadJevConfig()).toBeNull();
      const before = readFileSync(jevConfigPath(), "utf8");

      const r = await runJevCommand(["setup", "--mode", "shadow"], noTty);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("open to other users (0664)");
      expect(text(r)).toContain("https://attacker.example.com");
      expect(text(r)).toContain("--key-stdin");
      expect(text(r)).toContain("--base-url default");
      expect(text(r)).not.toContain(KEY);
      // Nothing was written: still refused, still the same bytes.
      expect(readFileSync(jevConfigPath(), "utf8")).toBe(before);
      expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o664);
      expect(loadJevConfig()).toBeNull();
    });

    it("not at a terminal prompt either: a bare key prompt would not say where the key goes", async () => {
      writeOpenFile({ provider: "typesafe", apiKey: KEY, baseUrl: ATTACKER }, 0o644);
      let prompted = false;
      const r = await runJevCommand(["setup"], {
        ...RENDER,
        stdinIsTTY: true,
        promptKey: async () => {
          prompted = true;
          return OTHER_KEY;
        },
      });
      expect(r.exitCode).toBe(1);
      expect(prompted).toBe(false);
      expect(loadJevConfig()).toBeNull();
    });

    it("passing the same foreign URL again with --base-url does not carry the key either", async () => {
      writeOpenFile({ provider: "typesafe", apiKey: KEY, baseUrl: ATTACKER }, 0o664);
      const r = await runJevCommand(["setup", "--base-url", ATTACKER], noTty);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("not carried to https://attacker.example.com");
      expect(loadJevConfig()).toBeNull();
    });

    it("given the key explicitly, the endpoint is saved with that key, owner-only", async () => {
      writeOpenFile({ provider: "typesafe", apiKey: KEY, baseUrl: ATTACKER }, 0o664);
      const r = await runJevCommand(["setup", "--key-stdin"], withKey(OTHER_KEY));
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain("https://attacker.example.com/v1/systemone");
      expect(readFile()).toEqual({ provider: "typesafe", apiKey: OTHER_KEY, baseUrl: ATTACKER });
      expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
    });

    it("--base-url default sends it back to the provider's own API, which keeps the stored key", async () => {
      writeOpenFile({ provider: "typesafe", apiKey: KEY, baseUrl: ATTACKER }, 0o664);
      const r = await runJevCommand(["setup", "--base-url", "default"], noTty);
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain("kept from the existing config");
      expect(text(r)).toContain("https://api.typesafe.ai/v1/systemone");
      expect(readFile()).toEqual({ provider: "typesafe", apiKey: KEY });
      expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
    });

    it("custom has no own API: any endpoint in an open file needs the key again", async () => {
      writeOpenFile({ provider: "custom", apiKey: KEY, baseUrl: "https://gateway.example.com/v1" }, 0o660);
      const r = await runJevCommand(["setup"], noTty);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("https://gateway.example.com");
      expect(text(r)).toContain("give your own --base-url");
      expect(text(r)).not.toContain(KEY);
    });

    it("an environment-key config in an open file must choose again too", async () => {
      process.env[JEV_API_KEY_ENV] = KEY;
      writeOpenFile({ provider: "custom", baseUrl: "https://gateway.example.com/v1" }, 0o664);
      const r = await runJevCommand(["setup"], noTty);
      expect(r.exitCode).toBe(1);
      const again = await runJevCommand(["setup", "--key-from-env"], noTty);
      expect(again.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "custom", baseUrl: "https://gateway.example.com/v1" });
      expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
    });

    it("an owner-only file with a foreign endpoint keeps its key on a re-run, as before", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--base-url", ATTACKER, "--key-stdin"], withKey(KEY));
      const r = await runJevCommand(["setup", "--mode", "shadow"], noTty);
      expect(r.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "typesafe", apiKey: KEY, baseUrl: ATTACKER, mode: "shadow" });
    });

    it("status shows the endpoint a too-open file names, next to the chmod hint (human and --json)", async () => {
      // A routing parameter: `?sig=` would now be refused by the loader as a
      // credential, which is a different state than the one under test here.
      writeOpenFile({ provider: "typesafe", apiKey: KEY, baseUrl: `${ATTACKER}?api-version=2` }, 0o664);
      const r = await runJevCommand(["status"], RENDER);
      expect(r.exitCode).toBe(1);
      const out = text(r);
      expect(out).toContain("endpoint it names https://attacker.example.com/v1/systemone?…");
      expect(out).toContain("check that endpoint is one you chose");
      expect(out).toContain(`chmod 600 ${jevConfigPath()}`);
      expect(out).not.toContain("api-version=2");
      expect(out).not.toContain(KEY);

      const j = await runJevCommand(["status", "--json"], RENDER);
      expect(j.exitCode).toBe(1);
      expect(JSON.parse(j.json as string)).toMatchObject({
        status: "refused",
        reason: "too-open",
        permissions: "0664",
        endpoint: "https://attacker.example.com/v1/systemone?…",
      });
      expect(j.json).not.toContain(KEY);
    });

    it("status names the provider's own API for a too-open file without a base URL", async () => {
      writeOpenFile({ provider: "cloudflare", apiKey: KEY, accountId: ACCOUNT }, 0o640);
      const r = await runJevCommand(["status"], RENDER);
      expect(text(r)).toContain(`endpoint it names https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`);
    });
  });

  describe("a key pasted as --model", () => {
    it("is refused by shape, never written and never repeated", async () => {
      for (const [argv, model] of [
        [["setup", "--provider", "openrouter", "--model", OPENROUTER_SHAPED, "--key-stdin"], OPENROUTER_SHAPED],
        [["setup", "--provider", "cloudflare", "--account-id", ACCOUNT, "--model", TOKEN_SHAPED, "--key-stdin"], TOKEN_SHAPED],
        [["setup", "--provider", "custom", "--base-url", "https://gw.example.com/v1", `--model=${TOKEN_SHAPED}`, "--key-stdin"], TOKEN_SHAPED],
      ] as Array<[string[], string]>) {
        const r = await runJevCommand(argv, withKey(OTHER_KEY));
        expect(r.exitCode).toBe(1);
        expect(text(r)).toContain("looks like an API key");
        expect(text(r)).not.toContain(model);
        expect(text(r)).not.toContain(OTHER_KEY);
        expect(existsSync(jevConfigPath())).toBe(false);
      }
    });

    it("is refused when it is the key itself, whatever its shape", async () => {
      const r = await runJevCommand(["setup", "--provider", "custom", "--base-url", "https://gw.example.com/v1", "--model", KEY, "--key-stdin"], withKey(KEY));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("model is the API key");
      expect(text(r)).not.toContain(KEY);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("is refused on a re-run too, keeping the stored config", async () => {
      await runJevCommand(["setup", "--provider", "openrouter", "--key-stdin"], withKey(KEY));
      const r = await runJevCommand(["setup", "--model", OPENROUTER_SHAPED], noTty);
      expect(r.exitCode).toBe(1);
      expect(text(r)).not.toContain(OPENROUTER_SHAPED);
      expect(readFile()).toEqual({ provider: "openrouter", apiKey: KEY });
    });

    it("real model ids are still accepted", async () => {
      for (const argv of [
        ["setup", "--provider", "openrouter", "--model", "typesafe/jev-1.13-20260917", "--key-stdin"],
        ["setup", "--provider", "openrouter", "--model", "~typesafe/jev-latest", "--key-stdin"],
        ["setup", "--provider", "vercel", "--model", "typesafe-ai/jev", "--key-stdin"],
        ["setup", "--provider", "custom", "--base-url", "https://gw.example.com/v1", "--model", "house-jev", "--key-stdin"],
        ["setup", "--provider", "custom", "--base-url", "https://gw.example.com/v1", "--model", "guardrail-model-2026", "--key-stdin"],
      ]) {
        const r = await runJevCommand(argv, withKey(KEY));
        expect(r.exitCode).toBe(0);
      }
    });
  });

  describe("an endpoint's query string is never shown", () => {
    // A ROUTING parameter, which is the only kind a base URL may still carry: a
    // credential-shaped one is refused outright now (the case below), because
    // eliding it on screen left it in the file, the logs and the dashboard.
    const QUERY_URL = "https://proxy.example.com/v1?api-version=2";
    const SHOWN = "https://proxy.example.com/v1/systemone?…";

    it("refuses a credential in the query string instead of eliding it", async () => {
      const r = await runJevCommand(
        ["setup", "--provider", "typesafe", "--base-url", "https://proxy.example.com/v1?token=x", "--key-stdin"],
        withKey(KEY),
      );
      expect(r.exitCode).toBe(1);
      // Named, so the owner knows which parameter to take out; the value is not.
      expect(text(r)).toContain("?token=");
      // Refused before anything was written: the URL never reaches the file, so
      // it never reaches the log, `jev status` or the dashboard either.
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("by setup, status (human and --json) or test (success and failure) — but is still sent", async () => {
      const setup = await runJevCommand(["setup", "--provider", "typesafe", "--base-url", QUERY_URL, "--key-stdin"], withKey(KEY));
      expect(setup.exitCode).toBe(0);
      expect(text(setup)).toContain(SHOWN);
      expect(text(setup)).not.toContain("api-version=2");

      const status = await runJevCommand(["status"], RENDER);
      expect(text(status)).toContain(SHOWN);
      expect(text(status)).not.toContain("api-version=2");
      const statusJson = await runJevCommand(["status", "--json"], RENDER);
      expect(JSON.parse(statusJson.json as string).endpoint).toBe(SHOWN);
      expect(statusJson.json).not.toContain("api-version=2");

      const urls: string[] = [];
      let status200 = true;
      globalThis.fetch = (async (url: string) => {
        urls.push(String(url));
        return status200
          ? new Response(JSON.stringify({ model: "jev-1.13.0", answers: { jev_test: { type: "noul", noul: 0.9 } } }), { status: 200 })
          : new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
      }) as unknown as typeof fetch;

      const test = await runJevCommand(["test"], RENDER);
      expect(test.exitCode).toBe(0);
      expect(text(test)).toContain(SHOWN);
      expect(text(test)).not.toContain("api-version=2");
      const testJson = await runJevCommand(["test", "--json"], RENDER);
      expect(JSON.parse(testJson.json as string).endpoint).toBe(SHOWN);
      expect(testJson.json).not.toContain("api-version=2");

      status200 = false;
      const failed = await runJevCommand(["test"], RENDER);
      expect(failed.exitCode).toBe(1);
      expect(text(failed)).toContain(SHOWN);
      expect(text(failed)).not.toContain("api-version=2");

      // Hidden on screen, not dropped from the request.
      expect(urls[0]).toBe("https://proxy.example.com/v1/systemone?api-version=2");
    });
  });

  describe("status and test on other config states", () => {
    it(`status names ${JEV_API_KEY_ENV} as the key's source for an environment-key config`, async () => {
      process.env[JEV_API_KEY_ENV] = KEY;
      await runJevCommand(["setup", "--provider", "typesafe", "--key-from-env"], noTty);
      const r = await runJevCommand(["status"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain(`key from ${JEV_API_KEY_ENV} (this shell only; the daemon does not see it)`);
      expect(text(r)).not.toContain("set in the config file");
      expect(text(r)).not.toContain(KEY);
      const j = await runJevCommand(["status", "--json"], RENDER);
      expect(JSON.parse(j.json as string).keySource).toBe("env");
      expect(j.json).not.toContain(KEY);
    });

    it.skipIf(!posix)("status --json on a too-open file exits 1 with the reason and permissions", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      chmodSync(jevConfigPath(), 0o644);
      const r = await runJevCommand(["status", "--json"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.json as string)).toMatchObject({ status: "refused", reason: "too-open", permissions: "0644" });
      expect(r.json).not.toContain(KEY);
    });

    it("status --json on an absent config exits 0", async () => {
      const r = await runJevCommand(["status", "--json"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.json as string).status).toBe("absent");
    });

    it.skipIf(!posix)("test on a refused config says it was refused, and sends nothing", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      chmodSync(jevConfigPath(), 0o644);
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch;
      const r = await runJevCommand(["test"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("was refused");
      expect(text(r)).not.toContain("nothing to test");
      const j = await runJevCommand(["test", "--json"], RENDER);
      expect(j.exitCode).toBe(1);
      expect(JSON.parse(j.json as string)).toMatchObject({ ok: false, error: { code: "config" } });
      expect(called).toBe(false);
    });

    it("test explains a redirect, which is never followed", async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      globalThis.fetch = (async () =>
        new Response(null, { status: 307, headers: { location: "http://elsewhere.example.com/systemone" } })) as unknown as typeof fetch;
      const r = await runJevCommand(["test"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("http-307");
      expect(text(r)).toContain("never follow");
      expect(text(r)).toContain("--base-url");
    });
  });

  describe("remove", () => {
    it(`notes that ${JEV_API_KEY_ENV} is still set, and only when it is`, async () => {
      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      const quiet = await runJevCommand(["remove"], RENDER);
      expect(quiet.exitCode).toBe(0);
      expect(text(quiet)).not.toContain(JEV_API_KEY_ENV);

      await runJevCommand(["setup", "--provider", "typesafe", "--key-stdin"], withKey(KEY));
      process.env[JEV_API_KEY_ENV] = OTHER_KEY;
      const r = await runJevCommand(["remove"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain(`${JEV_API_KEY_ENV} is still set in this shell`);
      expect(text(r)).not.toContain(OTHER_KEY);
      expect(existsSync(jevConfigPath())).toBe(false);
    });
  });

  describe("no subcommand repeats a stray argument", () => {
    it.each(["setup", "status", "test", "models", "remove"])("%s", async (sub) => {
      const r = await runJevCommand([sub, KEY], noTty);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("Unexpected argument");
      expect(text(r)).not.toContain(KEY);
    });
  });
});
