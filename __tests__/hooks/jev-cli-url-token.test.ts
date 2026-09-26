// @vitest-environment node
//
// The one-shot form: `failproofai jev --url <url> --token <token>`.
//
// Two things are being checked throughout. One, that the URL alone is enough —
// its host says which provider it is, and a provider given by hand that
// disagrees with the host is refused rather than guessed at. Two, that the
// token stays off the screen: it is accepted on the command line because one
// command that configures Jev is worth having, but nothing this module prints
// — a success, a refusal, a usage string, an unknown-option message — may
// contain it.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runJevCommand, type JevCliDeps, type JevCliResult } from "../../src/hooks/jev-cli";
import { JEV_API_KEY_ENV, jevConfigPath, loadJevConfig } from "../../src/hooks/semantic/jev-config";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const TOKEN = ["url", "token", "0123456789abcdef"].join("-");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const posix = process.platform !== "win32";

// `setup` reads `<base>/models` before it writes, and a unit test must not reach a
// provider to do it — so every deps object in this file reads no list. The read
// itself is exercised in `jev-cli-contracts.test.ts`.
const noModelList = async () => ({ ok: false as const, reason: "no list read in tests" });

const RENDER = { render: { cols: 100, color: false }, stdinIsTTY: false, readModelList: noModelList } satisfies JevCliDeps;
// A stdin that would hand over a second key if anything ever read it: the
// mutual-exclusion cases must fail before this is touched.
const withStdin = (key: string): JevCliDeps => ({ ...RENDER, readStdin: async () => `${key}\n` });

const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");
const readFile = () => JSON.parse(readFileSync(jevConfigPath(), "utf8")) as Record<string, unknown>;

describe("failproofai jev --url <url> --token <token>", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV, "FAILPROOFAI_EVALUATOR"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-url-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  describe("one command configures Jev", () => {
    it("writes a loadable config at 0600, reports what it wrote, and never the token", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(0);
      expect(text(r)).not.toContain(TOKEN);
      expect(readFile()).toEqual({ provider: "typesafe", apiKey: TOKEN });
      if (posix) expect(statSync(jevConfigPath()).mode & 0o777).toBe(0o600);
      // What it wrote, as the person needs to read it back.
      expect(text(r)).toContain("typesafe");
      expect(text(r)).toContain("https://api.typesafe.ai/v1/systemone");
      expect(text(r)).toContain("enforce");
      expect(loadJevConfig()).toMatchObject({ provider: "typesafe", apiKey: TOKEN, mode: "enforce" });
    });

    it("takes the flags in either order, and `jev setup` spells the same thing", async () => {
      const reversed = await runJevCommand(["--token", TOKEN, "--url", "https://api.typesafe.ai/v1"], RENDER);
      expect(reversed.exitCode).toBe(0);
      const first = readFile();

      rmSync(jevConfigPath());
      const viaSetup = await runJevCommand(["setup", "--url", "https://api.typesafe.ai/v1", "--token", TOKEN], RENDER);
      expect(viaSetup.exitCode).toBe(0);
      expect(readFile()).toEqual(first);
      expect(text(reversed) + text(viaSetup)).not.toContain(TOKEN);
    });

    it("says the token was on the command line, where history and `ps` can see it", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain("shell history");
      expect(text(r)).toContain("--key-stdin");
      expect(text(r)).not.toContain(TOKEN);
    });

    it.each([
      ["an endpoint given as the base", ["--url", "https://proxy.example/typesafe/v1/models", "--token", TOKEN]],
      ["two key sources", ["--url", "https://api.typesafe.ai/v1", "--token", TOKEN, "--key-stdin"]],
      ["the Cloud provider", ["setup", "--provider", "failproofai", "--token", TOKEN]],
    ])("says so on a refusal too, since the key is in history either way (%s)", async (_label, argv) => {
      const r = await runJevCommand(argv, RENDER);
      expect(r.exitCode).not.toBe(0);
      expect(text(r)).toContain("shell history");
      expect(text(r)).not.toContain(TOKEN);
    });

    it("says it once on success", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--token", TOKEN], RENDER);
      expect(text(r).split("shell history").length - 1).toBe(1);
    });

    it("takes the key on stdin with the same --url, which is the documented spelling", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--key-stdin"], withStdin(TOKEN));
      expect(r.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "typesafe", apiKey: TOKEN });
      expect(text(r)).toContain("set from stdin");
      // No history warning: this spelling did not put it anywhere.
      expect(text(r)).not.toContain("shell history");
    });
  });

  describe("the provider comes from the URL's host", () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["typesafe", "https://api.typesafe.ai/v1", { provider: "typesafe", apiKey: TOKEN }],
      ["openrouter", "https://openrouter.ai/api/v1", { provider: "openrouter", apiKey: TOKEN }],
      ["vercel", "https://ai-gateway.vercel.sh/typesafe/v1", { provider: "vercel", apiKey: TOKEN }],
      [
        "custom",
        "https://jev.internal.example.com/v1",
        { provider: "custom", apiKey: TOKEN, baseUrl: "https://jev.internal.example.com/v1" },
      ],
    ];
    for (const [provider, url, expected] of cases) {
      it(`${url} is ${provider}`, async () => {
        const r = await runJevCommand(["--url", url, "--token", TOKEN], RENDER);
        expect(r.exitCode).toBe(0);
        expect(text(r)).not.toContain(TOKEN);
        expect(readFile()).toEqual(expected);
        expect(loadJevConfig()?.provider).toBe(provider);
      });
    }

    it("api.cloudflare.com is cloudflare, whose endpoint is per-account", async () => {
      const r = await runJevCommand(["--url", "https://api.cloudflare.com/client/v4", "--account-id", ACCOUNT, "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "cloudflare", apiKey: TOKEN, accountId: ACCOUNT });
      expect(text(r)).toContain(`accounts/${ACCOUNT}/ai/run`);
    });

    it("refuses a cloudflare URL with no account id, naming the flag, and writes nothing", async () => {
      const r = await runJevCommand(["--url", "https://api.cloudflare.com/client/v4", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("--account-id");
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("takes the account id out of the run URL, which already names it", async () => {
      // Cloudflare's endpoint IS per-account, so the URL copied out of the
      // dashboard carries the id. The refusal above asked for it a second time,
      // and the first person to configure Cloudflare hit exactly that: the id
      // was visible in the string being rejected.
      const r = await runJevCommand(
        ["--url", `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`, "--token", TOKEN],
        RENDER,
      );
      expect(r.exitCode, text(r)).toBe(0);
      expect(readFile().accountId).toBe(ACCOUNT);
      expect(readFile().provider).toBe("cloudflare");
      expect(text(r)).not.toContain(TOKEN);
    });

    it("refuses an account id given twice and differently, rather than picking one", async () => {
      // Silently preferring either one would send every request to an account
      // the person did not name on the line they are looking at.
      const other = "ffffffffffffffffffffffffffffffff";
      const r = await runJevCommand(
        [
          "--url", `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`,
          "--account-id", other,
          "--token", TOKEN,
        ],
        RENDER,
      );
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain(ACCOUNT);
      expect(text(r)).toContain(other);
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("accepts the same account id given both ways", async () => {
      const r = await runJevCommand(
        [
          "--url", `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run`,
          "--account-id", ACCOUNT,
          "--token", TOKEN,
        ],
        RENDER,
      );
      expect(r.exitCode, text(r)).toBe(0);
      expect(readFile().accountId).toBe(ACCOUNT);
    });

    it("a URL that is the provider's own API writes no baseUrl override; any other path does", async () => {
      await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--token", TOKEN], RENDER);
      expect(readFile().baseUrl).toBeUndefined();

      const moved = await runJevCommand(["--url", "https://api.typesafe.ai/v2", "--token", TOKEN], RENDER);
      expect(moved.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ provider: "typesafe", baseUrl: "https://api.typesafe.ai/v2" });
    });

    it("--provider overrides the inference for a host that is nobody's", async () => {
      const r = await runJevCommand(["--url", "https://jev-proxy.example.com/v1", "--provider", "typesafe", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "typesafe", apiKey: TOKEN, baseUrl: "https://jev-proxy.example.com/v1" });
    });

    it("--provider custom takes a known host at its word: the URL is the whole address", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--provider", "custom", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "custom", apiKey: TOKEN, baseUrl: "https://api.typesafe.ai/v1" });
    });

    it("refuses a --provider that contradicts the host rather than guessing, and writes nothing", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--provider", "openrouter", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("api.typesafe.ai");
      expect(text(r)).toContain("openrouter");
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });
  });

  describe("the URL is validated by the loader's own rule", () => {
    it("refuses one that is not a URL, without repeating it", async () => {
      const r = await runJevCommand(["--url", `not a url ${TOKEN}`, "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("baseUrl is not a valid URL");
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("refuses plain http to a real host, in the words the loader uses", async () => {
      const r = await runJevCommand(["--url", "http://jev.example.com/v1", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("baseUrl must use https (plain http is accepted only for localhost)");
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("refuses plain http to localhost in enforce mode, and takes it in shadow", async () => {
      const enforced = await runJevCommand(["--url", "http://127.0.0.1:8088/v1", "--token", TOKEN], RENDER);
      expect(enforced.exitCode).toBe(1);
      expect(text(enforced)).toContain("accepted only with mode shadow");
      expect(existsSync(jevConfigPath())).toBe(false);

      const shadow = await runJevCommand(["--url", "http://127.0.0.1:8088/v1", "--mode", "shadow", "--token", TOKEN], RENDER);
      expect(shadow.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ provider: "custom", baseUrl: "http://127.0.0.1:8088/v1", mode: "shadow" });
    });

    it("refuses a URL carrying credentials, in the loader's words", async () => {
      const r = await runJevCommand(["--url", `https://user:${TOKEN}@api.typesafe.ai/v1`, "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("must not carry credentials");
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });
  });

  describe("one source for the key, and no way to print it", () => {
    it("refuses --token together with --key-stdin, writing nothing", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--token", TOKEN, "--key-stdin"], withStdin("stdin-key-0123456789"));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("--key-stdin");
      expect(text(r)).toContain("--token");
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("refuses --token together with --key-from-env, writing nothing", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--token", TOKEN, "--key-from-env"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("refuses --url together with --base-url: they are the same field", async () => {
      const r = await runJevCommand(
        ["--url", "https://api.typesafe.ai/v1", "--base-url", "https://openrouter.ai/api/v1", "--token", TOKEN],
        RENDER,
      );
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("--url and --base-url");
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("refuses a token that is not one clean line, without echoing it", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--token", `${TOKEN} and more`], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("does not echo a mistyped option that carries the token as its value", async () => {
      for (const argv of [[`-token=${TOKEN}`], [`--tokn=${TOKEN}`], ["--tokn", TOKEN], ["--url", "https://api.typesafe.ai/v1", `--tokenn=${TOKEN}`]]) {
        const r = await runJevCommand(argv, RENDER);
        expect(r.exitCode).toBe(1);
        expect(text(r)).not.toContain(TOKEN);
        expect(text(r)).toContain("Unknown option");
      }
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("does not echo a value left in the subcommand slot, and still says how to pass a key", async () => {
      const r = await runJevCommand([TOKEN], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).not.toContain(TOKEN);
      expect(text(r)).toContain("--key-stdin");
    });

    it("keeps --token out of the usage a bad option prints", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--token", TOKEN, "--nope"], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });
  });

  // What the command line asks for is what is saved — or nothing is. A URL that
  // can name the provider by itself must not turn a flag it cannot use into a
  // silent success: `--provider` spelled wrongly, a provider that cannot reach
  // that host, an `--account-id` no route would read.
  describe("a flag that could not be used is refused, not absorbed", () => {
    it("refuses a --provider that is not one, whatever the URL could have inferred", async () => {
      for (const named of ["anthropic", "TypeSafe", "OpenRouter", "Custom", "typesafe "]) {
        const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--provider", named, "--token", TOKEN], RENDER);
        expect(r.exitCode).toBe(1);
        expect(text(r)).toContain("Unknown provider");
        expect(text(r)).toContain("typesafe, openrouter, vercel, cloudflare, custom");
        expect(text(r)).not.toContain(TOKEN);
        expect(existsSync(jevConfigPath())).toBe(false);
      }
    });

    it("does not echo a key pasted after --provider, with a URL present to infer from", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--provider", TOKEN, "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("Unknown provider");
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("refuses --provider custom against Cloudflare's host, which custom cannot speak", async () => {
      // With the account id and without it: the combination is what is refused,
      // never "give me a flag I will then not store".
      for (const argv of [
        ["--url", "https://api.cloudflare.com/client/v4", "--provider", "custom", "--account-id", ACCOUNT, "--token", TOKEN],
        ["--url", "https://api.cloudflare.com/client/v4", "--provider", "custom", "--token", TOKEN],
      ]) {
        const r = await runJevCommand(argv, RENDER);
        expect(r.exitCode).toBe(1);
        expect(text(r)).toContain("--provider cloudflare");
        expect(text(r)).not.toContain(TOKEN);
        expect(existsSync(jevConfigPath())).toBe(false);
      }
    });

    it("refuses --account-id where no route would read it, rather than writing a dead field", async () => {
      for (const url of ["https://api.typesafe.ai/v1", "https://jev.internal.example.com/v1"]) {
        const r = await runJevCommand(["--url", url, "--account-id", ACCOUNT, "--token", TOKEN], RENDER);
        expect(r.exitCode).toBe(1);
        expect(text(r)).toContain("--account-id");
        expect(text(r)).not.toContain(TOKEN);
        expect(existsSync(jevConfigPath())).toBe(false);
      }
      // Cloudflare, whose route is the one that reads it, is unaffected.
      const cf = await runJevCommand(["--url", "https://api.cloudflare.com/client/v4", "--account-id", ACCOUNT, "--token", TOKEN], RENDER);
      expect(cf.exitCode).toBe(0);
      expect(readFile()).toEqual({ provider: "cloudflare", apiKey: TOKEN, accountId: ACCOUNT });
    });
  });

  describe("a URL on the provider's host that is not its API base", () => {
    it("is saved, and the save says where requests will go instead", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v2", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ provider: "typesafe", baseUrl: "https://api.typesafe.ai/v2" });
      const out = text(r);
      expect(out).toContain("Saved as given");
      // Both endpoints, named: the one this config uses and the provider's own.
      expect(out).toContain("https://api.typesafe.ai/v2/systemone");
      expect(out).toContain("https://api.typesafe.ai/v1/systemone");
      // And what that means for a hook, in the words the rest of the CLI uses.
      expect(out).toContain("fall back to regex");
      expect(out).toContain("--base-url default");
      expect(out).not.toContain(TOKEN);
    });

    it("says nothing of the kind for the provider's own API", async () => {
      const api = await runJevCommand(["--url", "https://api.typesafe.ai/v1", "--token", TOKEN], RENDER);
      expect(api.exitCode).toBe(0);
      expect(text(api)).not.toContain("Saved as given");
    });

    // This used to be saved with no comment, because `<base>/systemone` is where a
    // native request goes anyway so the override happened to work. It is refused
    // now: the field is a BASE, `/systemone` is appended to it, and the one real
    // paste of an endpoint into it — `…/typesafe/v1/models` — was saved just as
    // silently and then failed with `http-404` on every call.
    it("refuses the endpoint path in full, naming the base it implies", async () => {
      const r = await runJevCommand(["--url", "https://api.typesafe.ai/v1/systemone", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("names an endpoint, not an API base");
      expect(text(r)).toContain("/systemone");
      expect(text(r)).toContain("https://api.typesafe.ai/v1");
      expect(text(r)).not.toContain(TOKEN);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("says nothing for another host, whose layout is the customer's own", async () => {
      const r = await runJevCommand(["--url", "https://jev-proxy.example.com/anything", "--provider", "typesafe", "--token", TOKEN], RENDER);
      expect(r.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ provider: "typesafe", baseUrl: "https://jev-proxy.example.com/anything" });
      expect(text(r)).not.toContain("Saved as given");
    });
  });
});

// The same one-shot command through the real entry point: the dispatch in
// bin/failproofai.mjs, and nothing the PROCESS writes — stdout or stderr —
// carrying the token.
describe("failproofai jev --url (real binary)", () => {
  const BINARY = resolve(__dirname, "..", "..", "bin", "failproofai.mjs");
  const HOME = mkdtempSync(join(tmpdir(), "fpai-jev-url-bin-"));
  const FP_HOME = join(HOME, ".failproofai");

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it(
    "configures Jev in one command and prints neither the token nor a stack trace",
    () => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME, USERPROFILE: HOME, FAILPROOFAI_HOME: FP_HOME, FAILPROOFAI_TELEMETRY_DISABLED: "1" };
      delete env.FAILPROOFAI_JEV_API_KEY;
      delete env.FAILPROOFAI_EVALUATOR;
      const r = spawnSync("bun", [BINARY, "jev", "--url", "https://openrouter.ai/api/v1", "--token", TOKEN], {
        env,
        input: "",
        encoding: "utf8",
        timeout: 30_000,
      });
      if (r.error) throw r.error;
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(r.status).toBe(0);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain("node:internal");
      expect(out).toContain("openrouter");
      const config = join(FP_HOME, "jev.json");
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ provider: "openrouter", apiKey: TOKEN });
      if (posix) expect(statSync(config).mode & 0o777).toBe(0o600);
    },
    40_000,
  );
});
