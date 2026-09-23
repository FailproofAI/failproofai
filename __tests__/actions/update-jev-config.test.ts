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

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { jevConfigFile } from "../../src/hooks/fp-home";
import { loadJevConfig } from "../../src/hooks/semantic/jev-config";
import { getJevSettingsAction } from "../../app/actions/get-jev-config";
import {
  removeJevConfigAction,
  saveJevConfigAction,
  type JevConfigInput,
} from "../../app/actions/update-jev-config";

/** A token no provider issued, long enough that the panel shows a four-character hint. */
const TOKEN = "jevtoken-0123456789-3f2a";
/** A second one, for the "it was replaced" case. */
const OTHER_TOKEN = "jevtoken-9876543210-c41b";

let home: string;
let prevHome: string | undefined;
let prevBind: string | undefined;

/** The headers a same-origin POST from the dashboard's own page carries. */
function sameOrigin(): Headers {
  return new Headers({ host: "localhost:8020", origin: "http://localhost:8020" });
}

function input(over: Partial<JevConfigInput> = {}): JevConfigInput {
  return { provider: "typesafe", baseUrl: "", accountId: "", model: "", mode: "enforce", token: TOKEN, ...over };
}

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
  it("is absent from the save result, which carries presence and four characters", async () => {
    const res = await saveJevConfigAction(input());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(whole(res)).not.toContain(TOKEN);
    expect(res.view.token).toEqual({ source: "file", hint: "3f2a" });
  });

  it("is absent from the read action, which is what the page renders from", async () => {
    await saveJevConfigAction(input());
    const view = await getJevSettingsAction();
    expect(whole(view)).not.toContain(TOKEN);
    expect(view.token?.hint).toBe("3f2a");
    // The file itself of course holds it — that is the point of 0600.
    expect(readFileSync(configPath(), "utf8")).toContain(TOKEN);
  });

  it("is absent from the remove result too", async () => {
    await saveJevConfigAction(input());
    const res = await removeJevConfigAction();
    expect(whole(res)).not.toContain(TOKEN);
  });

  it("gives a short token no hint at all, rather than a large share of itself", async () => {
    const res = await saveJevConfigAction(input({ token: "abc123" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.token).toEqual({ source: "file", hint: null });
    expect(whole(res)).not.toContain("abc123");
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
