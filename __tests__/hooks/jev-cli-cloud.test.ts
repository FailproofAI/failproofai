// @vitest-environment node
/**
 * `failproofai jev` for the FailproofAI Cloud route.
 *
 *   - `status` names the provider "FailproofAI Cloud", shows the endpoint's
 *     HOST only, the key source as "FailproofAI Cloud connection", the mode —
 *     off included — and says "off — this machine is not connected to
 *     FailproofAI Cloud" when there is no Cloud key; `--json` carries all of it.
 *   - `setup --provider failproofai` builds the file from the connection and
 *     refuses every flag that would choose an endpoint, key or model.
 *   - no `--url` ever turns into this provider.
 *   - no output carries the key.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { JEV_USAGE } from "../../src/hooks/jev-cli";
import { jevConfigPath, loadJevConfig } from "../../src/hooks/semantic/jev-config";
import { readCredentials, writeCredentials, writeJevCloudCredential } from "../../src/hooks/fp-config";
import { resetJevCloudCooldown } from "../../src/hooks/semantic/jev-client";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["fp", "machine", "c1a0d0123456789ab"].join("-");
const BYOK_KEY = ["ts", "byok", "0123456789abcdef"].join("-");
const ORIGIN = "https://app.befailproof.ai";
const BASE = `${ORIGIN}/enforcement/v1/jev`;

const noModelList = async () => ({ ok: false as const, reason: "no list read in tests" });
const RENDER = { render: { cols: 120, color: false }, readModelList: noModelList, stdinIsTTY: false, readStdin: async () => "" } satisfies JevCliDeps;
const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");
const json = (r: JevCliResult) => JSON.parse(r.json as string) as Record<string, unknown>;

describe("jev CLI: FailproofAI Cloud", () => {
  let home: string;
  let fpHome: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", "FAILPROOFAI_JEV_API_KEY", "FAILPROOFAI_EVALUATOR", "FAILPROOFAI_CLOUD_CREDENTIALS"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-cli-cloud-"));
    fpHome = join(home, ".failproofai");
    mkdirSync(fpHome, { recursive: true, mode: 0o700 });
    chmodSync(fpHome, 0o700);
    process.env.FAILPROOFAI_HOME = fpHome;
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  const writeJev = (obj: Record<string, unknown>) => {
    writeFileSync(jevConfigPath(), JSON.stringify(obj), { mode: 0o600 });
    chmodSync(jevConfigPath(), 0o600);
  };
  const onDisk = () => JSON.parse(readFileSync(jevConfigPath(), "utf8")) as Record<string, unknown>;
  // What `config --token` leaves: the Jev slot AND the reporting credential it
  // came with. A slot counts only while a connection on its origin is there.
  const connect = (url = ORIGIN) => {
    writeCredentials({ ...readCredentials(), ingest: { url: `${url}/v1/events`, key: KEY } });
    return writeJevCloudCredential({ url, key: KEY });
  };
  const noKey = (r: JevCliResult) => expect(text(r)).not.toContain(KEY);

  describe("status", () => {
    it("on: FailproofAI Cloud, host only, key from the connection", async () => {
      connect();
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "shadow" });
      const human = await runJevCommand(["status"], RENDER);
      expect(human.exitCode).toBe(0);
      const t = text(human);
      expect(t).toContain("on · shadow");
      expect(t).toContain("FailproofAI Cloud");
      expect(t).toContain("app.befailproof.ai");
      expect(t).not.toContain("/enforcement/v1/jev");
      expect(t).toContain("FailproofAI Cloud connection");
      noKey(human);

      const machine = await runJevCommand(["status", "--json"], RENDER);
      expect(json(machine)).toMatchObject({
        status: "ok",
        provider: "failproofai",
        providerLabel: "FailproofAI Cloud",
        endpoint: "app.befailproof.ai",
        model: "jev-1.13.0",
        mode: "shadow",
        keySource: "cloud",
        keySourceLabel: "FailproofAI Cloud connection",
        cloudConnected: true,
      });
      noKey(machine);
    });

    it("not connected: off, said as such, with the fix — and exit 0, since nothing is wrong with the file", async () => {
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "enforce" });
      const human = await runJevCommand(["status"], RENDER);
      expect(human.exitCode).toBe(0);
      expect(text(human)).toContain("off — this machine is not connected to FailproofAI Cloud");
      expect(text(human)).toContain("config --token <key>");
      const machine = await runJevCommand(["status", "--json"], RENDER);
      expect(json(machine)).toMatchObject({
        status: "not-connected",
        provider: "failproofai",
        providerLabel: "FailproofAI Cloud",
        endpoint: "app.befailproof.ai",
        mode: "enforce",
        keySource: "cloud",
        cloudConnected: false,
        reason: "not-connected",
      });
    });

    it("connected with a key that has no Jev: says so, never \"not connected\"", async () => {
      writeCredentials({ ingest: { url: `${ORIGIN}/v1/events`, key: KEY } });
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "shadow" });
      const human = await runJevCommand(["status"], RENDER);
      expect(human.exitCode).toBe(0);
      expect(text(human)).toContain("off — this machine's FailproofAI Cloud key does not carry Jev");
      expect(text(human)).toContain("config --token <key>");
      expect(text(human)).not.toMatch(/not connected/);
      const machine = await runJevCommand(["status", "--json"], RENDER);
      expect(json(machine)).toMatchObject({
        status: "key-lacks-jev",
        provider: "failproofai",
        endpoint: "app.befailproof.ai",
        mode: "shadow",
        keySource: "cloud",
        cloudConnected: true,
        keyCarriesJev: false,
        reason: "key-lacks-jev",
      });
      expect(String(json(machine).problem)).not.toMatch(/not connected/);
      noKey(human);
      noKey(machine);

      const t = await runJevCommand(["test", "--json"], RENDER);
      expect(t.exitCode).toBe(1);
      expect(json(t)).toMatchObject({ ok: false, error: { code: "key-lacks-jev" } });

      // Switched off on the same machine: the key row still does not call it
      // "not connected".
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "off" });
      const off = await runJevCommand(["status"], RENDER);
      expect(text(off)).toContain("connected, but its key does not carry jev:evaluate");
      expect(text(off)).not.toMatch(/not connected/);
      expect(json(await runJevCommand(["status", "--json"], RENDER))).toMatchObject({ status: "off", cloudConnected: true, keyCarriesJev: false });
    });

    it("off: switched off, with the mode, for the Cloud route and for BYOK", async () => {
      connect();
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "off" });
      const human = await runJevCommand(["status"], RENDER);
      expect(human.exitCode).toBe(0);
      expect(text(human)).toContain("off (switched off)");
      expect(text(human)).toContain("off — Jev is not asked at all");
      expect(json(await runJevCommand(["status", "--json"], RENDER))).toMatchObject({
        status: "off",
        mode: "off",
        reason: "switched-off",
        providerLabel: "FailproofAI Cloud",
        cloudConnected: true,
      });

      writeJev({ provider: "typesafe", apiKey: BYOK_KEY, mode: "off" });
      const byok = await runJevCommand(["status", "--json"], RENDER);
      expect(json(byok)).toMatchObject({ status: "off", provider: "typesafe", mode: "off" });
      expect(text(byok)).not.toContain(BYOK_KEY);
    });

    it("a loose credentials.json: refused, with the chmod that fixes it", async () => {
      connect();
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "shadow" });
      chmodSync(join(fpHome, "credentials.json"), 0o644);
      const human = await runJevCommand(["status"], RENDER);
      expect(human.exitCode).toBe(1);
      expect(text(human)).toContain(`chmod 600 ${join(fpHome, "credentials.json")}`);
      noKey(human);
    });

    it("absent: names the FailproofAI Cloud path too", async () => {
      const t = text(await runJevCommand(["status"], RENDER));
      expect(t).toContain("FailproofAI Cloud");
      expect(t).toContain("config --token <key>");
      connect();
      expect(text(await runJevCommand(["status"], RENDER))).toContain("jev setup --provider failproofai");
    });
  });

  describe("setup --provider failproofai", () => {
    it("builds the file from the connection: shadow, no key, 0600", async () => {
      connect();
      const r = await runJevCommand(["setup", "--provider", "failproofai"], RENDER);
      expect(r.exitCode, text(r)).toBe(0);
      expect(onDisk()).toEqual({ provider: "failproofai", mode: "shadow", baseUrl: BASE });
      if (process.platform !== "win32") expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
      expect(loadJevConfig()).toMatchObject({ provider: "failproofai", apiKey: KEY });
      expect(text(r)).toContain("saved · FailproofAI Cloud · shadow");
      noKey(r);
    });

    it("keeps a self-hosted Cloud's path prefix from the policy connection", async () => {
      writeCredentials({ cloud: { url: "https://fp.example.com/cloud", machineId: "m", token: "t".repeat(20) } });
      connect("https://fp.example.com");
      expect((await runJevCommand(["setup", "--provider", "failproofai"], RENDER)).exitCode).toBe(0);
      expect(onDisk().baseUrl).toBe("https://fp.example.com/cloud/enforcement/v1/jev");
    });

    it("refuses when this machine is not connected, and writes nothing", async () => {
      const r = await runJevCommand(["setup", "--provider", "failproofai"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("config --token <key>");
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it.each([
      [["--token", KEY]],
      [["--key-stdin"]],
      [["--key-from-env"]],
      [["--url", BASE]],
      [["--base-url", BASE]],
      [["--model", "jev-1.13.0"]],
      [["--account-id", "0".repeat(32)]],
    ])("refuses %s — the connection chooses it — without echoing a value", async (flag) => {
      connect();
      const r = await runJevCommand(["setup", "--provider", "failproofai", ...flag], RENDER);
      expect(r.exitCode).toBe(1);
      expect(existsSync(jevConfigPath())).toBe(false);
      noKey(r);
    });

    it("a mode switch over a Cloud file rewrites the mode and keeps the rest — connected or not", async () => {
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "shadow", timeoutMs: 2500 });
      const r = await runJevCommand(["setup", "--mode", "enforce"], RENDER);
      expect(r.exitCode, text(r)).toBe(0);
      expect(onDisk()).toEqual({ provider: "failproofai", baseUrl: BASE, mode: "enforce", timeoutMs: 2500 });
      expect((await runJevCommand(["setup", "--mode", "off"], RENDER)).exitCode).toBe(0);
      expect(onDisk().mode).toBe("off");
    });

    it("a mode switch says which key state the machine is in, and offers `jev test` only when there is a key to test", async () => {
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "off" });

      // Connected, with a key that has no Jev: said so — never "not connected".
      writeCredentials({ ingest: { url: `${ORIGIN}/v1/events`, key: KEY } });
      const lacks = await runJevCommand(["setup", "--mode", "shadow"], RENDER);
      expect(lacks.exitCode, text(lacks)).toBe(0);
      expect(text(lacks)).toContain("connected, but its key does not carry jev:evaluate");
      expect(text(lacks)).not.toContain("not connected");
      expect(text(lacks)).not.toContain("jev test");
      expect(text(lacks)).toContain("config --token <key>");
      noKey(lacks);

      // Not connected at all.
      rmSync(join(fpHome, "credentials.json"), { force: true });
      const none = await runJevCommand(["setup", "--mode", "enforce"], RENDER);
      expect(none.exitCode, text(none)).toBe(0);
      expect(text(none)).toContain("this machine is not connected");
      expect(text(none)).not.toContain("jev test");
      expect(text(none)).toContain("config --token <key>");

      // Connected with a Jev key: the live check is the next step.
      connect();
      const on = await runJevCommand(["setup", "--mode", "shadow"], RENDER);
      expect(on.exitCode, text(on)).toBe(0);
      expect(text(on)).toContain("failproofai jev test");
      expect(text(on)).not.toContain("config --token <key>");
    });

    it("drops a key someone put in a Cloud file, which is what makes it valid again", async () => {
      connect();
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "shadow", apiKey: BYOK_KEY });
      expect(loadJevConfig()).toBeNull();
      const r = await runJevCommand(["setup", "--provider", "failproofai"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(onDisk()).not.toHaveProperty("apiKey");
      expect(loadJevConfig()?.apiKey).toBe(KEY);
      expect(text(r)).not.toContain(BYOK_KEY);
    });

    it("re-points a Cloud file left on another origin at the one this machine connected to", async () => {
      connect();
      writeJev({ provider: "failproofai", baseUrl: "https://staging.befailproof.ai/enforcement/v1/jev", mode: "enforce" });
      expect(loadJevConfig()).toBeNull();
      expect((await runJevCommand(["setup", "--provider", "failproofai"], RENDER)).exitCode).toBe(0);
      expect(onDisk()).toMatchObject({ baseUrl: BASE, mode: "enforce" });
      expect(loadJevConfig()?.baseUrl).toBe(BASE);
    });

    it("switching from BYOK is explicit, starts in shadow, and carries no BYOK key over", async () => {
      connect();
      writeJev({ provider: "typesafe", apiKey: BYOK_KEY, mode: "enforce" });
      const r = await runJevCommand(["setup", "--provider", "failproofai"], RENDER);
      expect(r.exitCode).toBe(0);
      expect(onDisk()).toEqual({ provider: "failproofai", mode: "shadow", baseUrl: BASE });
      expect(readFileSync(jevConfigPath(), "utf8")).not.toContain(BYOK_KEY);
    });
  });

  describe("no URL turns into the Cloud provider", () => {
    it("jev --url <Cloud route> is a custom endpoint, with its own key", async () => {
      connect();
      const r = await runJevCommand(["--url", BASE, "--token", BYOK_KEY], RENDER);
      expect(r.exitCode, text(r)).toBe(0);
      expect(onDisk()).toMatchObject({ provider: "custom", apiKey: BYOK_KEY, baseUrl: BASE });
    });

    it("jev models has nothing to read for it", async () => {
      connect();
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "shadow" });
      const r = await runJevCommand(["models"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("FailproofAI Cloud serves no model list");
      expect((await runJevCommand(["models", "--provider", "failproofai"], RENDER)).exitCode).toBe(1);
    });

    it("usage names the Cloud path", () => {
      expect(JEV_USAGE.join("\n")).toContain("--provider failproofai");
    });
  });

  describe("jev test", () => {
    it("not connected / switched off: not run, with a code for each", async () => {
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "shadow" });
      const nc = await runJevCommand(["test", "--json"], RENDER);
      expect(nc.exitCode).toBe(1);
      expect(json(nc)).toMatchObject({ ok: false, error: { code: "not-connected" } });
      writeJev({ provider: "failproofai", baseUrl: BASE, mode: "off" });
      expect(json(await runJevCommand(["test", "--json"], RENDER))).toMatchObject({ ok: false, error: { code: "switched-off" } });
    });

    describe("against a Cloud that refuses", () => {
      let status = 403;
      let body: unknown = { error: "forbidden", message: "this key does not carry jev:evaluate" };
      const server: Server = createServer((req, res) => {
        req.resume();
        res.writeHead(status, {
          "content-type": "application/json",
          ...(status >= 300 && status < 400 ? { location: "https://login.example.com/" } : {}),
        });
        res.end(JSON.stringify(body));
      });
      let port = 0;
      beforeAll(async () => {
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.address() as AddressInfo).port;
      });
      afterAll(() => server.close());
      // A 429 quiets the Cloud route for its Retry-After, module-wide: no test inherits another's.
      beforeEach(() => resetJevCloudCooldown());

      it("says what to do in FailproofAI Cloud's terms", async () => {
        const origin = `http://127.0.0.1:${port}`;
        connect(origin);
        writeJev({ provider: "failproofai", baseUrl: `${origin}/enforcement/v1/jev`, mode: "shadow" });
        status = 403;
        body = { error: "forbidden", message: "this key does not carry jev:evaluate" };
        const refused = await runJevCommand(["test"], { ...RENDER, testTimeoutMs: 5_000 });
        expect(refused.exitCode).toBe(1);
        expect(text(refused)).toContain("http-403");
        expect(text(refused)).toContain("jev:evaluate");
        expect(text(refused)).toContain("config --token <key>");
        noKey(refused);

        status = 402;
        body = { error: "out_of_credits" };
        const broke = await runJevCommand(["test"], { ...RENDER, testTimeoutMs: 5_000 });
        expect(text(broke)).toContain("out-of-credits");
        expect(text(broke)).toContain("plan allowance");
      });

      it("a 429 names the daily limit when the body says so, and the per-minute one otherwise", async () => {
        const origin = `http://127.0.0.1:${port}`;
        connect(origin);
        writeJev({ provider: "failproofai", baseUrl: `${origin}/enforcement/v1/jev`, mode: "shadow" });
        status = 429;

        body = { error: "daily_limit_reached" };
        const daily = await runJevCommand(["test"], { ...RENDER, testTimeoutMs: 5_000 });
        expect(daily.exitCode).toBe(1);
        expect(text(daily)).toContain("http-429");
        expect(text(daily)).toContain("Daily Jev limit for this org reached; resets at 00:00 UTC.");
        expect(text(daily)).not.toContain("rate-limiting Jev for this org right now");
        noKey(daily);

        resetJevCloudCooldown();
        body = { error: "rate_limited" };
        const perMinute = await runJevCommand(["test"], { ...RENDER, testTimeoutMs: 5_000 });
        expect(text(perMinute)).toContain("rate-limiting Jev for this org right now");
        expect(text(perMinute)).not.toContain("Daily Jev limit");
      });

      it("a 503 names who fixes it, not a wait", async () => {
        const origin = `http://127.0.0.1:${port}`;
        connect(origin);
        writeJev({ provider: "failproofai", baseUrl: `${origin}/enforcement/v1/jev`, mode: "shadow" });
        status = 503;
        body = { error: "jev_unavailable" };
        const r = await runJevCommand(["test"], { ...RENDER, testTimeoutMs: 5_000 });
        expect(text(r)).toContain("http-503");
        expect(text(r)).toContain("admin");
        expect(text(r)).not.toContain("try again shortly");
        noKey(r);
      });

      it("a 422 request_rejected is that call's own, never an outage to wait out", async () => {
        const origin = `http://127.0.0.1:${port}`;
        connect(origin);
        writeJev({ provider: "failproofai", baseUrl: `${origin}/enforcement/v1/jev`, mode: "shadow" });
        status = 422;
        body = { error: "request_rejected" };
        const rejected = await runJevCommand(["test"], { ...RENDER, testTimeoutMs: 5_000 });
        expect(rejected.exitCode).toBe(1);
        expect(text(rejected)).toContain("http-422");
        expect(text(rejected)).toContain("not an outage");
        expect(text(rejected)).not.toContain("server error");
        expect(text(rejected)).not.toContain("try again shortly");
        noKey(rejected);
      });

      it("a redirect is advice about the connection, never a --base-url this route refuses", async () => {
        const origin = `http://127.0.0.1:${port}`;
        connect(origin);
        writeJev({ provider: "failproofai", baseUrl: `${origin}/enforcement/v1/jev`, mode: "shadow" });
        status = 302;
        body = {};
        const redirected = await runJevCommand(["test"], { ...RENDER, testTimeoutMs: 5_000 });
        expect(redirected.exitCode).toBe(1);
        expect(text(redirected)).toContain("http-302");
        expect(text(redirected)).toContain("config --token <key> --url <url>");
        expect(text(redirected)).not.toContain("--base-url");
        noKey(redirected);
        // And the advice it gave is advice this route takes: --base-url is refused.
        const refused = await runJevCommand(["setup", "--provider", "failproofai", "--base-url", origin], RENDER);
        expect(refused.exitCode).toBe(1);
      });
    });
  });
});
