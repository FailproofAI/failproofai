// @vitest-environment node
/**
 * The /settings Jev panel's server actions.
 *
 * Four properties, in the order they would hurt:
 *
 *   1. **The token never comes back.** The dashboard has no authentication, so a
 *      response that carried the key would hand it to any page that can reach
 *      the origin. Every assertion here stringifies the WHOLE result and looks
 *      for the token in it, rather than checking one field — a field check
 *      passes the moment somebody adds a second one.
 *   2. **A cross-site write is refused.** A page on another site can POST to
 *      localhost from the victim's browser. Landing a write here would point the
 *      evaluator at the attacker's endpoint — which then sees an envelope for
 *      every command failproofai judges — or switch Jev on in enforce mode,
 *      where its answers can clear a deny. Both shapes are tested: the ordinary
 *      drive-by (a foreign `Origin`) and DNS rebinding (an attacker-controlled
 *      `Host` its own `Origin` matches, which every framework same-origin check
 *      waves through).
 *   3. **The file the CLI reads is the file this writes**, at 0600, through the
 *      same validator — so the dashboard cannot save a config the hooks then
 *      refuse.
 *   4. **Removing it turns Jev off**, which is what puts the hook path back to
 *      byte-for-byte what it was before the two-tier evaluator existed.
 *
 * These exercise the shipped actions, not a reimplementation, and they read the
 * result back through `loadJevConfig()` — the loader the hooks themselves use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { headersMock } = vi.hoisted(() => ({ headersMock: vi.fn() }));
vi.mock("next/headers", () => ({ headers: headersMock }));

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { jevConfigFile } from "../../src/hooks/fp-home";
import { loadJevConfig } from "../../src/hooks/semantic/jev-config";
import { getJevSettingsAction } from "../../app/actions/get-jev-config";
import {
  removeJevConfigAction,
  saveJevConfigAction,
  type JevConfigInput,
} from "../../app/actions/update-jev-config";

/** A token no provider issued, and long enough that a four-character tail of it would
 *  be a negligible share — which is no longer sent for any length. */
const TOKEN = "jevtoken-0123456789-3f2a";
/** A second one, for the "it was replaced" case. */
const OTHER_TOKEN = "jevtoken-9876543210-c41b";

let home: string;
let prevHome: string | undefined;
let prevBind: string | undefined;
let prevEnvKey: string | undefined;

/** The headers a same-origin POST from the dashboard's own page carries. */
function sameOrigin(): Headers {
  return new Headers({ host: "localhost:8020", origin: "http://localhost:8020" });
}

// `model` is deliberately absent: the panel has no such field, and the type no
// longer carries one — which is what stops a save clearing a stored model.
function input(over: Partial<JevConfigInput> = {}): JevConfigInput {
  return { provider: "typesafe", baseUrl: "", accountId: "", mode: "enforce", token: TOKEN, ...over };
}

/**
 * A `jev.json` as some other writer left it — `jev setup` with flags this panel
 * does not offer, or a newer failproofai — at the permissions the loader
 * requires. Written directly rather than through either writer, so the tests
 * that compare the two are not seeded by one of them.
 */
function seedConfig(cfg: Record<string, unknown>): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The file as it is on disk, for the fields no view is allowed to carry. */
function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
}

const CLOUDFLARE_ACCOUNT = "0123456789abcdef0123456789abcdef";

function configPath(): string {
  return jevConfigFile();
}

/** Everything the action answered, as one string, for "is the token anywhere in here". */
function whole(value: unknown): string {
  return JSON.stringify(value);
}

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  prevBind = process.env.FAILPROOFAI_DASHBOARD_HOST;
  prevEnvKey = process.env.FAILPROOFAI_JEV_API_KEY;
  // A key in the environment changes what the loader says about a keyless file,
  // so the default here is "not set" and the tests that want one set it.
  delete process.env.FAILPROOFAI_JEV_API_KEY;
  home = mkdtempSync(resolve(tmpdir(), "fpai-jev-settings-"));
  process.env.FAILPROOFAI_HOME = home;
  // The launcher exports this; default the tests to the shipped posture.
  process.env.FAILPROOFAI_DASHBOARD_HOST = "127.0.0.1";
  headersMock.mockReset().mockResolvedValue(sameOrigin());
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  if (prevBind === undefined) delete process.env.FAILPROOFAI_DASHBOARD_HOST;
  else process.env.FAILPROOFAI_DASHBOARD_HOST = prevBind;
  if (prevEnvKey === undefined) delete process.env.FAILPROOFAI_JEV_API_KEY;
  else process.env.FAILPROOFAI_JEV_API_KEY = prevEnvKey;
  rmSync(home, { recursive: true, force: true });
});

describe("saving writes the file the hooks read", () => {
  it("writes jev.json at 0600 and the loader accepts it", async () => {
    const res = await saveJevConfigAction(input());
    expect(res.ok).toBe(true);

    const path = configPath();
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // Read back through the loader the HOOKS use, not through our own parse:
    // "the dashboard wrote a file" and "a hook will use it" are different
    // claims, and only the second one matters.
    const loaded = loadJevConfig();
    expect(loaded).not.toBeNull();
    expect(loaded?.provider).toBe("typesafe");
    expect(loaded?.mode).toBe("enforce");
    expect(loaded?.apiKey).toBe(TOKEN);
  });

  it("stores a custom endpoint and reports where requests go", async () => {
    const res = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "https://jev.internal.example/v1" }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.on).toBe(true);
    expect(res.view.provider).toBe("custom");
    expect(res.view.endpoint).toBe("https://jev.internal.example/v1/systemone");
    expect(loadJevConfig()?.baseUrl).toContain("jev.internal.example");
  });

  it("carries the stored token across a mode change, without it being re-typed", async () => {
    await saveJevConfigAction(input());
    const res = await saveJevConfigAction(input({ mode: "shadow", token: "" }));
    expect(res.ok).toBe(true);
    expect(loadJevConfig()?.mode).toBe("shadow");
    expect(loadJevConfig()?.apiKey).toBe(TOKEN);
  });

  it("replaces the stored token when a new one is typed", async () => {
    await saveJevConfigAction(input());
    const res = await saveJevConfigAction(input({ token: OTHER_TOKEN }));
    expect(res.ok).toBe(true);
    expect(loadJevConfig()?.apiKey).toBe(OTHER_TOKEN);
  });

  it("will not carry a stored token to a different endpoint, and writes nothing when it cannot", async () => {
    await saveJevConfigAction(input({ provider: "custom", baseUrl: "https://mine.example" }));
    const res = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "https://someone-elses.example", token: "" }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.needsToken).toBe(true);
    // The old config is untouched: a refusal must not leave the machine pointing
    // somewhere new with a key it was not given for.
    expect(loadJevConfig()?.baseUrl).toContain("mine.example");
  });
});

describe("the token never reaches the browser", () => {
  it("is absent from the save result, which carries presence and nothing else", async () => {
    const res = await saveJevConfigAction(input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(whole(res)).not.toContain(TOKEN);
    // Presence and source, with no piece of the key: `{ source }` exactly, so a
    // field carrying a mask or a length cannot be added back unnoticed.
    expect(res.view.token).toEqual({ source: "file" });
  });

  it("is absent from the read action, which is what the page renders from", async () => {
    await saveJevConfigAction(input());
    const view = await getJevSettingsAction();
    expect(whole(view)).not.toContain(TOKEN);
    expect(view.token).toEqual({ source: "file" });
    // The file itself of course holds it — that is the point of 0600.
    expect(readFileSync(configPath(), "utf8")).toContain(TOKEN);
  });

  it("is absent from the remove result too", async () => {
    await saveJevConfigAction(input());
    const res = await removeJevConfigAction();
    expect(whole(res)).not.toContain(TOKEN);
  });

  /**
   * A base URL is the OTHER place a credential fits, and it used to cross the
   * wire whole: only the derived `endpoint` was query-elided, while `baseUrl`
   * was handed back raw as the form's value. The loader now refuses such a URL
   * (`validateBaseUrl`), so this file is one an older build wrote — which is
   * exactly the file this action describes field by field so its owner can
   * repair it.
   */
  it("carries no query string off a base URL an older build stored, credential or not", async () => {
    const secret = ["qk", "live", "0123456789abcdef"].join("-");
    seedConfig({ provider: "custom", apiKey: TOKEN, baseUrl: `https://gw.example.com/v1?api_key=${secret}` });
    const view = await getJevSettingsAction();
    expect(whole(view)).not.toContain(secret);
    expect(view.baseUrl).toBe("https://gw.example.com/v1");
    expect(view.baseUrlQueryWithheld).toBe(true);
    // Refused, because the credential is in the file and not just in the
    // response — eliding it here would leave it in the file, the logs and
    // `jev status`.
    expect(view.status).toBe("refused");
  });

  it("withholds a routing query string too, and keeps it when the field comes back untouched", async () => {
    seedConfig({ provider: "custom", apiKey: TOKEN, baseUrl: "https://gw.example.com/v1?api-version=2026-01-01" });
    const view = await getJevSettingsAction();
    // A query the loader accepts: the config is fine, and the browser still
    // does not get the query.
    expect(view.status).toBe("ok");
    expect(view.baseUrl).toBe("https://gw.example.com/v1");
    expect(view.baseUrlQueryWithheld).toBe(true);
    expect(whole(view)).not.toContain("api-version");

    // The panel posts back what it was given. Writing that verbatim would delete
    // a routing parameter the person never saw, so an unchanged field keeps it.
    const res = await saveJevConfigAction(input({ provider: "custom", baseUrl: view.baseUrl, token: "" }));
    expect(res.ok).toBe(true);
    expect(onDisk().baseUrl).toBe("https://gw.example.com/v1?api-version=2026-01-01");

    // A URL they actually typed replaces it, query and all.
    const typed = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "https://other.example.com/v1", token: TOKEN }),
    );
    expect(typed.ok).toBe(true);
    expect(onDisk().baseUrl).toBe("https://other.example.com/v1");
  });

  it("does not carry back a credential query the loader refuses, because dropping it is the repair", async () => {
    const secret = ["qk", "live", "0123456789abcdef"].join("-");
    seedConfig({ provider: "custom", apiKey: TOKEN, baseUrl: `https://gw.example.com/v1?token=${secret}` });
    const view = await getJevSettingsAction();
    const res = await saveJevConfigAction(input({ provider: "custom", baseUrl: view.baseUrl, token: TOKEN }));
    expect(res.ok).toBe(true);
    expect(onDisk().baseUrl).toBe("https://gw.example.com/v1");
    expect(readFileSync(configPath(), "utf8")).not.toContain(secret);
  });

  it("sends no fragment of the key either, whatever its length", async () => {
    // It used to send the last four characters for a key long enough to spare
    // them, so the panel could say "configured, ending 3f2a". That is a
    // recognisable piece of a live credential rendered into a page on an origin
    // with no authentication, and it told the reader nothing they could not get
    // by re-pasting the key.
    for (const token of [TOKEN, "abc123"]) {
      const res = await saveJevConfigAction(input({ token }));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.view.token).toEqual({ source: "file" });
      expect(whole(res)).not.toContain(token);
      expect(whole(res)).not.toContain(token.slice(-4));
    }
  });
});

describe("cross-origin writes are refused", () => {
  it("REFUSES an ordinary drive-by POST from another site, and writes nothing", async () => {
    // The whole attack: a page on evil.example does
    // `fetch("http://localhost:8020/settings", {method:"POST", body})`. No
    // preflight is needed, the request is delivered, and the attacker never has
    // to read the response — the side effect is the point. Landing it here
    // would send a redacted envelope for every judged command to their endpoint.
    headersMock.mockResolvedValue(
      new Headers({ host: "localhost:8020", origin: "https://evil.example" }),
    );
    const res = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "https://evil.example/jev" }),
    );
    expect(res.ok).toBe(false);
    expect(loadJevConfig()).toBeNull();
  });

  it("REFUSES a rebound request whose Host is the attacker's domain", async () => {
    // DNS rebinding: attacker.tld resolves to 127.0.0.1 on the second lookup, so
    // the request lands on the loopback socket with Origin === Host. Every
    // framework same-origin comparison passes; only pinning Host to loopback
    // catches it.
    headersMock.mockResolvedValue(
      new Headers({ host: "attacker.tld:8020", origin: "http://attacker.tld:8020" }),
    );
    const res = await saveJevConfigAction(input());
    expect(res.ok).toBe(false);
    expect(loadJevConfig()).toBeNull();
  });

  it("REFUSES another app on a different port of this machine", async () => {
    headersMock.mockResolvedValue(
      new Headers({ host: "localhost:8020", origin: "http://localhost:3000" }),
    );
    const res = await saveJevConfigAction(input());
    expect(res.ok).toBe(false);
    expect(loadJevConfig()).toBeNull();
  });

  it("REFUSES a cross-origin REMOVE — turning Jev off is a write too", async () => {
    await saveJevConfigAction(input());
    headersMock.mockResolvedValue(
      new Headers({ host: "localhost:8020", origin: "https://evil.example" }),
    );
    const res = await removeJevConfigAction();
    expect(res.ok).toBe(false);
    expect(loadJevConfig()).not.toBeNull();
  });

  it("allows an Origin-less local caller on a loopback bind, and refuses one off it", async () => {
    // A non-browser caller on loopback is necessarily a local process, which can
    // rewrite jev.json directly anyway — refusing it buys nothing. On a
    // deliberately non-loopback bind the same shape describes every curl on the
    // network segment, and Host pinning cannot apply, so it is the only layer
    // left.
    headersMock.mockResolvedValue(new Headers({ host: "localhost:8020" }));
    expect((await saveJevConfigAction(input())).ok).toBe(true);

    await removeJevConfigAction();
    process.env.FAILPROOFAI_DASHBOARD_HOST = "0.0.0.0";
    headersMock.mockResolvedValue(new Headers({ host: "box.internal:8020" }));
    expect((await saveJevConfigAction(input())).ok).toBe(false);
    expect(loadJevConfig()).toBeNull();
  });
});

describe("validation is the loader's, not a second copy of it", () => {
  it("refuses a URL that does not parse", async () => {
    const res = await saveJevConfigAction(input({ provider: "custom", baseUrl: "not a url" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.problem).toMatch(/not a valid URL/);
    expect(loadJevConfig()).toBeNull();
  });

  it("refuses plain http in enforce mode, and accepts loopback http in shadow", async () => {
    const enforced = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "http://localhost:9999", mode: "enforce" }),
    );
    expect(enforced.ok).toBe(false);
    expect(loadJevConfig()).toBeNull();

    const shadowed = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "http://localhost:9999", mode: "shadow" }),
    );
    expect(shadowed.ok).toBe(true);
    expect(loadJevConfig()?.mode).toBe("shadow");
  });

  it("refuses plain http to anywhere but loopback, in either mode", async () => {
    const res = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "http://jev.example", mode: "shadow" }),
    );
    expect(res.ok).toBe(false);
    expect(loadJevConfig()).toBeNull();
  });

  it("refuses cloudflare without an account id, and takes one that is 32 hex", async () => {
    const missing = await saveJevConfigAction(input({ provider: "cloudflare" }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.problem).toMatch(/accountId/);
    expect(loadJevConfig()).toBeNull();

    const ok = await saveJevConfigAction(
      input({ provider: "cloudflare", accountId: "0123456789abcdef0123456789abcdef" }),
    );
    expect(ok.ok).toBe(true);
    expect(loadJevConfig()?.accountId).toBe("0123456789abcdef0123456789abcdef");
  });

  it("refuses an unknown provider", async () => {
    const res = await saveJevConfigAction(input({ provider: "definitely-not-a-provider" }));
    expect(res.ok).toBe(false);
    expect(loadJevConfig()).toBeNull();
  });

  it("refuses a token with whitespace in it rather than trimming it into shape", async () => {
    const res = await saveJevConfigAction(input({ token: "two words" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.needsToken).toBe(true);
    expect(loadJevConfig()).toBeNull();
  });
});

describe("removing the config turns Jev off", () => {
  it("deletes the file, so the loader answers null and the hooks run the regex engine", async () => {
    await saveJevConfigAction(input());
    expect(loadJevConfig()).not.toBeNull();

    const res = await removeJevConfigAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.status).toBe("absent");
    expect(res.view.on).toBe(false);
    expect(loadJevConfig()).toBeNull();
  });

  it("is not an error when there was nothing configured", async () => {
    const res = await removeJevConfigAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.on).toBe(false);
  });
});

describe("the read action describes the machine, not the form", () => {
  it("reports an absent config as off, with the path it looked at", async () => {
    const view = await getJevSettingsAction();
    expect(view).toMatchObject({ status: "absent", on: false, token: null, stats: null });
    expect(view.path).toBe(configPath());
  });

  it("reports a file others can read as refused, with the chmod that fixes it", async () => {
    await saveJevConfigAction(input());
    // The exact state the loader refuses: owner-only is the whole point of the
    // file, and a dashboard that showed it as "on" would be lying about
    // enforcement.
    const { chmodSync } = await import("node:fs");
    chmodSync(configPath(), 0o644);
    const view = await getJevSettingsAction();
    expect(view.status).toBe("refused");
    expect(view.on).toBe(false);
    expect(view.fix).toMatch(/chmod 600/);
    // Still no token, even from a file the loader would not load.
    expect(whole(view)).not.toContain(TOKEN);
  });
});

describe("a file other users could have written", () => {
  it("does not reuse its stored token, and says why rather than failing generically", async () => {
    await saveJevConfigAction(input({ provider: "custom", baseUrl: "https://mine.example" }));
    const { chmodSync } = await import("node:fs");
    // 0644 is the loader's "someone else may have chosen this endpoint" case: a
    // group- or world-accessible file is refused, and re-saving it must not
    // quietly carry its key to whatever endpoint it now names.
    chmodSync(configPath(), 0o644);

    const res = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "https://mine.example", token: "" }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.needsToken).toBe(true);
    expect(res.problem).toMatch(/open to other users/);
  });

  it("is repaired to 0600 when the token is given again", async () => {
    await saveJevConfigAction(input({ provider: "custom", baseUrl: "https://mine.example" }));
    const { chmodSync } = await import("node:fs");
    chmodSync(configPath(), 0o644);

    const res = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "https://mine.example", token: OTHER_TOKEN }),
    );
    expect(res.ok).toBe(true);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(loadJevConfig()?.apiKey).toBe(OTHER_TOKEN);
  });
});

/**
 * The panel shows four fields. The file can hold more, and the ones it holds
 * decide whether Jev works at all: `model` names the model the request asks
 * for, so a self-hosted or gateway endpoint that must be told its model answers
 * nothing once it is dropped — while the save, having passed validation,
 * reports success and the panel says "jev is on".
 */
describe("a save keeps the fields the form does not show", () => {
  it("leaves model, accountId, timeoutMs and mode alone when the person changed none of them", async () => {
    seedConfig({
      provider: "cloudflare",
      apiKey: TOKEN,
      accountId: CLOUDFLARE_ACCOUNT,
      model: "typesafe/jev-1.13",
      timeoutMs: 4500,
      mode: "shadow",
    });

    // Exactly what the panel sends for that file with nothing touched: the form
    // holds the four values the view gave it, and a blank token.
    const res = await saveJevConfigAction(
      input({ provider: "cloudflare", accountId: CLOUDFLARE_ACCOUNT, mode: "shadow", token: "" }),
    );
    expect(res.ok).toBe(true);

    const loaded = loadJevConfig();
    expect(loaded?.model).toBe("typesafe/jev-1.13");
    expect(loaded?.accountId).toBe(CLOUDFLARE_ACCOUNT);
    expect(loaded?.timeoutMs).toBe(4500);
    expect(loaded?.mode).toBe("shadow");
    expect(loaded?.apiKey).toBe(TOKEN);
  });

  it("changes the one field that was changed and nothing else", async () => {
    seedConfig({
      provider: "typesafe",
      apiKey: TOKEN,
      model: "typesafe/jev-1.13",
      timeoutMs: 4500,
      mode: "shadow",
    });

    const res = await saveJevConfigAction(input({ mode: "enforce", token: "" }));
    expect(res.ok).toBe(true);

    const loaded = loadJevConfig();
    expect(loaded?.mode).toBe("enforce");
    expect(loaded?.model).toBe("typesafe/jev-1.13");
    expect(loaded?.timeoutMs).toBe(4500);
  });

  it("keeps a field a newer failproofai wrote, which this form has never heard of", async () => {
    seedConfig({ provider: "typesafe", apiKey: TOKEN, futureField: { weights: [1, 2] } });

    expect((await saveJevConfigAction(input({ mode: "shadow", token: "" }))).ok).toBe(true);
    expect(onDisk().futureField).toEqual({ weights: [1, 2] });
  });

  it("agrees with `jev setup` about what an update keeps, byte for byte", async () => {
    // The two writers are separate code — the CLI's merge is in
    // `src/hooks/jev-cli.ts`, the panel's in the action — so the property that
    // matters is that they produce the same file from the same starting point.
    // This is what fails if either one starts dropping a field.
    const seed = {
      provider: "typesafe",
      apiKey: TOKEN,
      model: "typesafe/jev-1.13",
      timeoutMs: 4500,
      mode: "enforce",
    };

    seedConfig(seed);
    expect((await saveJevConfigAction(input({ mode: "shadow", token: "" }))).ok).toBe(true);
    const viaPanel = onDisk();

    seedConfig(seed);
    const { runJevCommand } = await import("../../src/hooks/jev-cli");
    // `jev setup --mode shadow`: the same change, named the same way, with no
    // terminal to prompt on — the key is kept from the existing config.
    const cli = await runJevCommand(["setup", "--mode", "shadow"], {
      stdinIsTTY: false,
      // No provider is reached from a unit test; see jev-cli-contracts.test.ts.
      readModelList: async () => ({ ok: false, reason: "no list read in tests" }),
    });
    expect(cli.exitCode).toBe(0);

    expect(viaPanel).toEqual(onDisk());
    expect(viaPanel.model).toBe("typesafe/jev-1.13");
  });
});

/**
 * `jev setup --key-from-env` stores no key: a hook reads the environment when it
 * runs. Such a config was editable from the CLI and not from here — every save
 * was refused for a stored token that, by construction, did not exist.
 */
describe("a config whose key lives in the environment", () => {
  it("takes an endpoint change with the token field blank, and leaves the key out of the file", async () => {
    seedConfig({ provider: "custom", baseUrl: "https://mine.example" });

    const res = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "https://elsewhere.example", token: "" }),
    );
    expect(res.ok).toBe(true);

    const raw = onDisk();
    expect(raw.baseUrl).toContain("elsewhere.example");
    expect(raw.apiKey).toBeUndefined();
  });

  it("takes a provider change too, and stays keyless", async () => {
    seedConfig({ provider: "typesafe", mode: "shadow" });

    const res = await saveJevConfigAction(input({ provider: "openrouter", mode: "shadow", token: "" }));
    expect(res.ok).toBe(true);
    expect(onDisk()).toEqual({ provider: "openrouter", mode: "shadow" });
  });

  it("is still on after such a save, with the key read from the environment", async () => {
    process.env.FAILPROOFAI_JEV_API_KEY = TOKEN;
    seedConfig({ provider: "typesafe" });

    const res = await saveJevConfigAction(input({ mode: "shadow", token: "" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.on).toBe(true);
    expect(res.view.token).toEqual({ source: "env" });
    // The key was never in the file and this save did not put it there.
    expect(readFileSync(configPath(), "utf8")).not.toContain(TOKEN);
  });

  it("is repaired to 0600 by a save, because there is no token to re-type", async () => {
    // The stored-key case refuses this and asks for the token again. With no
    // stored key there is nothing to withhold, and re-saving is the only remedy
    // the panel has for the permissions the loader refuses.
    seedConfig({ provider: "typesafe" });
    chmodSync(configPath(), 0o644);

    const res = await saveJevConfigAction(input({ mode: "shadow", token: "" }));
    expect(res.ok).toBe(true);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(onDisk().apiKey).toBeUndefined();
  });

  it("names no stored token in any refusal, because there is none to name", async () => {
    seedConfig({ provider: "custom", baseUrl: "https://mine.example" });
    const moved = await saveJevConfigAction(
      input({ provider: "custom", baseUrl: "https://elsewhere.example", token: "" }),
    );
    expect(moved.ok).toBe(true);

    // A machine with no config at all is a different thing, and still asks —
    // saving a keyless file there would report success for a Jev that is off.
    rmSync(configPath());
    const fresh = await saveJevConfigAction(input({ token: "" }));
    expect(fresh.ok).toBe(false);
    if (fresh.ok) return;
    expect(fresh.needsToken).toBe(true);
    expect(fresh.problem).toBe("enter the token for this provider.");
    expect(loadJevConfig()).toBeNull();
  });
});

/**
 * `model` is the one routing field that holds a free string typed next to the
 * key, and `--model <key>` is one slip away from `--token <key>`. The loader
 * refuses such a file, and a refused file's routing is exactly what the view
 * hands back so the owner can repair it — so this is the path that would have
 * echoed a pasted key into the browser while the same response said the key
 * never comes back.
 */
describe("the stored model, which the panel shows but does not offer", () => {
  /** Shaped like a pasted token: 32 characters of mixed case and digits, no slash. */
  const PASTED = "Ab3kQ9zR7wT2yU8pL5nM1xC6vB0hJ4dF";

  it("comes back as itself when it is a model id", async () => {
    seedConfig({ provider: "typesafe", apiKey: TOKEN, model: "typesafe/jev-1.13" });
    const view = await getJevSettingsAction();
    expect(view.status).toBe("ok");
    expect(view.model).toEqual({ kind: "id", id: "typesafe/jev-1.13" });
  });

  it("reports the provider's default when nothing is stored", async () => {
    await saveJevConfigAction(input());
    expect((await getJevSettingsAction()).model).toEqual({ kind: "default" });
  });

  it("is withheld, not echoed, when the stored value looks like a key", async () => {
    seedConfig({ provider: "typesafe", apiKey: TOKEN, model: PASTED });
    const view = await getJevSettingsAction();

    // The loader refuses the file for this exact reason, and the panel shows
    // what it names so the owner can fix it — minus the thing that may be a key.
    expect(view.status).toBe("refused");
    expect(view.model).toEqual({ kind: "withheld" });
    expect(whole(view)).not.toContain(PASTED);
    expect(whole(view)).not.toContain(TOKEN);
  });

  it("is withheld when it is longer than any model id, since a key can contain a slash", async () => {
    const long = "typesafe-ai/jev-1.13-experimental-build-20260915-rc2";
    expect(long.length).toBeGreaterThan(40);
    seedConfig({ provider: "typesafe", apiKey: TOKEN, model: long });

    const view = await getJevSettingsAction();
    expect(view.status).toBe("ok");
    expect(view.model).toEqual({ kind: "withheld" });
    expect(whole(view)).not.toContain(long);
  });

  it("survives a save, which is the whole point of not offering the field", async () => {
    seedConfig({ provider: "typesafe", apiKey: TOKEN, model: "typesafe/jev-1.13" });
    const res = await saveJevConfigAction(input({ mode: "shadow", token: "" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.model).toEqual({ kind: "id", id: "typesafe/jev-1.13" });
  });
});
