// @vitest-environment node
//
// `failproofai jev` against each provider's real contract: a URL that is an
// endpoint where a base belongs, a model the endpoint does not serve, and
// `jev models`.
//
// The case throughout is the one that happened. Someone hosting Jev behind a
// LiteLLM proxy ran `--url https://models.aikin.club/typesafe/v1/models`; it
// saved, and `jev test` said `failed · http-404 … Not Found`. With the URL
// fixed, the model was still wrong: `custom`'s default is `jev-1.13.0` and that
// proxy serves `jev-latest` and `jev-preview`. Both facts were readable before
// anything was written.
//
// No test here reaches the network: the list reader is injected.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJevCommand, type JevCliDeps, type JevCliResult, type JevModelListReader } from "../../src/hooks/jev-cli";
import { JEV_API_KEY_ENV, jevConfigPath } from "../../src/hooks/semantic/jev-config";
import type { JevModelListResult } from "../../src/hooks/semantic/jev-client";

const KEY = ["cli", "contract", "0123456789abcdef"].join("-");
const PROXY = "https://models.aikin.club/typesafe/v1";

const text = (r: JevCliResult) => `${r.lines.join("\n")}\n${r.json ?? ""}`.replace(/\s+/g, " ");
const readFile = () => JSON.parse(readFileSync(jevConfigPath(), "utf8")) as Record<string, unknown>;

/** A reader that answers one canned list, and records every URL and key it was given. */
function reader(result: JevModelListResult): JevModelListReader & { calls: Array<{ url: string; apiKey: string | null }> } {
  const calls: Array<{ url: string; apiKey: string | null }> = [];
  const fn = (async (url: string, apiKey: string | null) => {
    calls.push({ url, apiKey });
    return result;
  }) as JevModelListReader & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

/** What the proxy answers once it has a key: TypeSafe's shape, with its own names. */
const PROXY_LIST: JevModelListResult = { ok: true, shape: "typesafe", models: ["jev-latest", "jev-preview"] };
const UNREAD: JevModelListResult = { ok: false, reason: "HTTP 401: Authentication Error, No api key passed in." };

const RENDER: RenderDeps = { render: { cols: 100, color: false }, stdinIsTTY: false };
type RenderDeps = Pick<JevCliDeps, "render" | "stdinIsTTY">;

const deps = (list: JevModelListResult | JevModelListReader, extra: JevCliDeps = {}): JevCliDeps => ({
  ...RENDER,
  readModelList: typeof list === "function" ? list : reader(list),
  ...extra,
});

describe("failproofai jev and each provider's contract", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV, "FAILPROOFAI_EVALUATOR"];

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-contract-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  // ── An endpoint given where a base belongs ─────────────────────────────────

  describe("a URL that is an endpoint, not a base", () => {
    it.each([
      ["/models", `${PROXY}/models`, PROXY],
      ["/systemone", `${PROXY}/systemone`, PROXY],
      ["/chat/completions", "https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1"],
      ["/completions", "https://proxy.example.com/v1/completions", "https://proxy.example.com/v1"],
      ["/embeddings", "https://proxy.example.com/v1/embeddings", "https://proxy.example.com/v1"],
    ])("--url ending in %s is refused, naming %s", async (suffix, given, base) => {
      const list = reader(PROXY_LIST);
      const r = await runJevCommand(["--url", given, "--token", KEY], deps(list));
      expect(r.exitCode).toBe(1);
      const out = text(r);
      expect(out).toContain("names an endpoint, not an API base");
      expect(out).toContain(suffix);
      expect(out).toContain(base);
      expect(out).toContain("Nothing was written.");
      expect(out).not.toContain(KEY);
      // Refused before anything is written, and before the endpoint is asked
      // anything: the fix is one segment of the URL the person is looking at.
      expect(existsSync(jevConfigPath())).toBe(false);
      expect(list.calls).toEqual([]);
    });

    it("says the same thing for --base-url, naming that flag", async () => {
      const r = await runJevCommand(["setup", "--provider", "custom", "--base-url", `${PROXY}/models`, "--token", KEY], deps(PROXY_LIST));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("--base-url names an endpoint");
      expect(text(r)).toContain(`failproofai jev --base-url ${PROXY}`);
      expect(existsSync(jevConfigPath())).toBe(false);
    });

    it("never asks for a key first — the refusal comes before the prompt", async () => {
      let prompted = false;
      const r = await runJevCommand(["--url", `${PROXY}/models`], {
        ...deps(PROXY_LIST),
        stdinIsTTY: true,
        promptKey: async () => {
          prompted = true;
          return KEY;
        },
      });
      expect(r.exitCode).toBe(1);
      expect(prompted).toBe(false);
    });

    it("hides a query string from the refusal, whatever it carries", async () => {
      const r = await runJevCommand(["--url", `${PROXY}/models?api-version=2`, "--token", KEY], deps(PROXY_LIST));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("?…");
      expect(text(r)).not.toContain("api-version=2");
      expect(text(r)).not.toContain(KEY);
    });

    it("refuses a credential in the query string before it gets that far", async () => {
      // Elided output was never enough on its own: the URL would still have been
      // written to the file, printed by `jev status` and sent to the dashboard.
      const r = await runJevCommand(["--url", `${PROXY}/models?token=${KEY}`, "--token", KEY], deps(PROXY_LIST));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("?token=");
      expect(text(r)).not.toContain(KEY);
    });

    it("saves the base it named, which is the whole point of naming it", async () => {
      const r = await runJevCommand(["--url", PROXY, "--token", KEY], deps(PROXY_LIST, {}));
      // The list refuses jev-1.13.0 (the next block); with a model it serves, the
      // same URL saves.
      expect(r.exitCode).toBe(1);
      const ok = await runJevCommand(["--url", PROXY, "--model", "jev-latest", "--token", KEY], deps(PROXY_LIST));
      expect(ok.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ provider: "custom", baseUrl: PROXY, model: "jev-latest" });
    });
  });

  // ── A model the endpoint does not serve ────────────────────────────────────

  describe("the model, against what the endpoint says it serves", () => {
    it("refuses a model a readable list does not carry, and names the ones it does", async () => {
      const list = reader(PROXY_LIST);
      const r = await runJevCommand(["--url", PROXY, "--token", KEY], deps(list));
      expect(r.exitCode).toBe(1);
      const out = text(r);
      expect(out).toContain("does not list jev-1.13.0");
      expect(out).toContain("it serves: jev-latest, jev-preview");
      expect(out).toContain("--model jev-latest");
      // And says why the default is not a get-out: this endpoint names Jev
      // differently, so --model is required here.
      expect(out).toContain("--model is not optional here");
      expect(out).toContain("Nothing was written.");
      expect(existsSync(jevConfigPath())).toBe(false);
      // Asked the base's own /models, with the key being configured.
      expect(list.calls).toEqual([{ url: `${PROXY}/models`, apiKey: KEY }]);
    });

    it("refuses an explicitly named model just as readily, and does not blame the default", async () => {
      const r = await runJevCommand(["--url", PROXY, "--model", "jev-1.13.0", "--token", KEY], deps(PROXY_LIST));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("Pick one of the names above");
      expect(text(r)).not.toContain("not optional here");
    });

    it("accepts a model the list carries", async () => {
      const r = await runJevCommand(["--url", PROXY, "--model", "jev-preview", "--token", KEY], deps(PROXY_LIST));
      expect(r.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ provider: "custom", baseUrl: PROXY, model: "jev-preview" });
    });

    it("proceeds exactly as before when the list cannot be read", async () => {
      // No key yet, a proxy that serves no list, an unreachable host, a shape
      // nobody knows: all of them are this case, and none of them may block a
      // setup that would have worked.
      for (const unread of [UNREAD, { ok: false, reason: "the list endpoint answered in a shape this build does not know" } as JevModelListResult]) {
        rmSync(jevConfigPath(), { force: true });
        const r = await runJevCommand(["--url", PROXY, "--token", KEY], deps(unread));
        expect(r.exitCode).toBe(0);
        expect(readFile()).toMatchObject({ provider: "custom", baseUrl: PROXY });
      }
    });

    it("proceeds when a reader throws — a reader that throws read nothing", async () => {
      const r = await runJevCommand(["--url", PROXY, "--token", KEY], {
        ...RENDER,
        readModelList: async () => {
          throw new Error("boom");
        },
      });
      expect(r.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ provider: "custom", baseUrl: PROXY });
    });

    it("does not refuse on an OpenAI-shaped catalog, which does not describe /systemone", async () => {
      // OpenRouter's catalog carries no Jev entry of any spelling, and its
      // /systemone works — so refusing on it would refuse a working route.
      const openai: JevModelListResult = { ok: true, shape: "openai", models: ["fireworks/ember-1", "z-ai/glm-5.3-prime"] };
      const r = await runJevCommand(["--url", "https://openrouter.ai/api/v1", "--token", KEY], deps(openai));
      expect(r.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ provider: "openrouter" });
    });

    it("accepts Vercel's default against a list that names the same model without its owner prefix", async () => {
      const vercel: JevModelListResult = { ok: true, shape: "typesafe", models: ["jev"] };
      const r = await runJevCommand(["--url", "https://ai-gateway.vercel.sh/typesafe/v1", "--token", KEY], deps(vercel));
      expect(r.exitCode).toBe(0);
      expect(readFile()).toMatchObject({ provider: "vercel" });
    });

    it("asks nothing for Cloudflare, which serves no <base>/models", async () => {
      const list = reader(PROXY_LIST);
      const account = "0123456789abcdef0123456789abcdef";
      const r = await runJevCommand(["--url", `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`, "--token", KEY], deps(list));
      expect(r.exitCode).toBe(0);
      expect(list.calls).toEqual([]);
    });

    it("sends no key when the config would take it from an unset environment variable", async () => {
      const list = reader(UNREAD);
      const r = await runJevCommand(["setup", "--provider", "vercel", "--key-from-env"], deps(list));
      expect(r.exitCode).toBe(0);
      expect(list.calls).toEqual([{ url: "https://ai-gateway.vercel.sh/typesafe/v1/models", apiKey: null }]);
    });
  });

  // ── jev models ─────────────────────────────────────────────────────────────

  describe("jev models", () => {
    const configure = async (model?: string) => {
      const argv = ["--url", PROXY, "--token", KEY, ...(model ? ["--model", model] : [])];
      const r = await runJevCommand(argv, deps(PROXY_LIST));
      expect(r.exitCode).toBe(0);
    };

    it("prints the configured endpoint's names, marking the one in use", async () => {
      await configure("jev-latest");
      const list = reader(PROXY_LIST);
      const r = await runJevCommand(["models"], deps(list));
      expect(r.exitCode).toBe(0);
      const out = text(r);
      expect(out).toContain(`${PROXY}/models`);
      expect(out).toContain("jev-latest configured");
      expect(out).toContain("jev-preview");
      expect(out).toContain("TypeSafe's own inventory");
      expect(out).not.toContain(KEY);
      expect(list.calls).toEqual([{ url: `${PROXY}/models`, apiKey: KEY }]);
    });

    it("--json carries the shape, the names and the configured one", async () => {
      await configure("jev-latest");
      const r = await runJevCommand(["models", "--json"], deps(PROXY_LIST));
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.json as string)).toEqual({
        ok: true,
        provider: "custom",
        endpoint: `${PROXY}/models`,
        shape: "typesafe",
        models: ["jev-latest", "jev-preview"],
        configuredModel: "jev-latest",
        keySent: true,
      });
    });

    it("says an OpenAI-shaped catalog is not the System One list", async () => {
      const openai: JevModelListResult = { ok: true, shape: "openai", models: ["fireworks/ember-1"] };
      const r = await runJevCommand(["models", "--provider", "openrouter"], deps(openai));
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain("OpenAI-shaped gateway catalog");
      expect(text(r)).toContain("never used to refuse a model");
    });

    it("exits 1 with the provider's own reason when the list cannot be read", async () => {
      await configure("jev-latest");
      const r = await runJevCommand(["models"], deps(UNREAD));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("Authentication Error, No api key passed in.");
      expect(text(r)).toContain("nothing depends on one");
      const j = await runJevCommand(["models", "--json"], deps(UNREAD));
      expect(j.exitCode).toBe(1);
      expect(JSON.parse(j.json as string)).toMatchObject({ ok: false, error: { code: "model-list-unread" } });
    });

    it("sends the stored key only to the origin it was stored for", async () => {
      await configure("jev-latest");
      const list = reader(PROXY_LIST);
      const elsewhere = await runJevCommand(["models", "--url", "https://someone-else.example.com/v1"], deps(list));
      expect(elsewhere.exitCode).toBe(0);
      expect(list.calls).toEqual([{ url: "https://someone-else.example.com/v1/models", apiKey: null }]);
      expect(text(elsewhere)).toContain("a stored key belongs to the endpoint it was stored for");
      // And nothing on that host is marked as configured, because nothing there is.
      expect(text(elsewhere)).not.toContain("configured\n");
    });

    it("asks a named provider's own API with no config at all", async () => {
      const list = reader({ ok: true, shape: "typesafe", models: ["jev"] });
      const r = await runJevCommand(["models", "--provider", "vercel"], deps(list));
      expect(r.exitCode).toBe(0);
      expect(list.calls).toEqual([{ url: "https://ai-gateway.vercel.sh/typesafe/v1/models", apiKey: null }]);
    });

    it("needs an endpoint when there is neither a config nor a flag", async () => {
      const r = await runJevCommand(["models"], deps(PROXY_LIST));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("Jev is not configured here");
      expect(text(r)).toContain("--provider");
      expect(text(r)).toContain("--url");
    });

    it("says provider custom has no API of its own", async () => {
      const r = await runJevCommand(["models", "--provider", "custom"], deps(PROXY_LIST));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("--url <base>");
    });

    it("says Cloudflare has no <base>/models rather than failing to read one", async () => {
      const list = reader(PROXY_LIST);
      const r = await runJevCommand(["models", "--provider", "cloudflare"], deps(list));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("serves no <base>/models");
      expect(list.calls).toEqual([]);
    });

    it("refuses an endpoint given to --url, the same way setup does", async () => {
      const r = await runJevCommand(["models", "--url", `${PROXY}/models`], deps(PROXY_LIST));
      expect(r.exitCode).toBe(1);
      expect(text(r)).toContain("names an endpoint, not an API base");
    });

    it("never repeats an unknown provider, in case it is a key", async () => {
      const r = await runJevCommand(["models", "--provider", KEY], deps(PROXY_LIST));
      expect(r.exitCode).toBe(1);
      expect(text(r)).not.toContain(KEY);
      expect(text(r)).toContain("Unknown provider");
    });

    it("warns when the configured model is not in the list it just printed", async () => {
      // Reachable on a config written before this check existed, or one whose
      // proxy has since renamed its models.
      await configure("jev-latest");
      const r = await runJevCommand(["models"], deps({ ok: true, shape: "typesafe", models: ["jev-2-preview"] }));
      expect(r.exitCode).toBe(0);
      expect(text(r)).toContain("jev-latest is not one of these");
      expect(text(r)).toContain("fall back to regex");
    });
  });
});
