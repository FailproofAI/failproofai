// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_JEV_MODE,
  JEV_API_KEY_ENV,
  JEV_CONFIG_DEFAULT_TIMEOUT_MS,
  baseUrlWithoutQuery,
  inspectJevConfig,
  isCalibratedJevModel,
  jevConfigPath,
  jevModelVersion,
  loadJevConfig,
  validateBaseUrl,
  validateJevConfig,
} from "../../../src/hooks/semantic/jev-config";

// Keys are built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["ts", "test", "0123456789abcdef"].join("-");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENV_KEYS = [
  "FAILPROOFAI_HOME",
  JEV_API_KEY_ENV,
  "FAILPROOFAI_JEV_PROVIDER",
  "FAILPROOFAI_JEV_BASE_URL",
  "FAILPROOFAI_JEV_MODEL",
  "FAILPROOFAI_JEV_ACCOUNT_ID",
  "TYPESAFE_API_KEY",
  "FAILPROOFAI_JEV_CONFIG_DIR",
] as const;

const posix = process.platform !== "win32";

describe("semantic/jev-config", () => {
  let home: string;
  const saved: Partial<Record<string, string | undefined>> = {};
  const savedCwd = process.cwd();

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-config-"));
    process.env.FAILPROOFAI_HOME = join(home, ".failproofai");
    // Never read the developer's real research credentials.
    process.env.FAILPROOFAI_JEV_CONFIG_DIR = join(home, "no-typesafe");
  });
  afterEach(() => {
    process.chdir(savedCwd);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  const write = (obj: unknown, mode = 0o600) => {
    mkdirSync(join(home, ".failproofai"), { recursive: true, mode: 0o700 });
    const file = jevConfigPath();
    writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj), { mode });
    chmodSync(file, mode);
    return file;
  };

  it("lives at <home>/jev.json", () => {
    expect(jevConfigPath()).toBe(join(home, ".failproofai", "jev.json"));
  });

  it("is off (null) when there is no file", () => {
    expect(loadJevConfig()).toBeNull();
    expect(inspectJevConfig()).toEqual({ status: "absent", path: jevConfigPath() });
  });

  it("loads a valid owner-only file and fills the defaults (mode enforce, 3000 ms)", () => {
    write({ provider: "typesafe", apiKey: KEY });
    expect(loadJevConfig()).toEqual({ provider: "typesafe", apiKey: KEY, mode: "enforce", timeoutMs: 3000 });
    expect(DEFAULT_JEV_MODE).toBe("enforce");
    // 3000 ms, not 1500: see DEFAULT_JEV_TIMEOUT_MS in evaluator.ts for the
    // measurements. jev-review.test.ts pins this equal to that copy.
    expect(JEV_CONFIG_DEFAULT_TIMEOUT_MS).toBe(3000);
    const r = inspectJevConfig();
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.keySource).toBe("file");
      if (posix) expect(r.mode).toBe(0o600);
    }
  });

  it.each([
    ["typesafe", { provider: "typesafe", apiKey: KEY, model: "jev-1.13.0", mode: "shadow", timeoutMs: 900 }],
    ["openrouter", { provider: "openrouter", apiKey: KEY, model: "typesafe/jev-1.13" }],
    ["vercel", { provider: "vercel", apiKey: KEY }],
    ["cloudflare", { provider: "cloudflare", apiKey: KEY, accountId: ACCOUNT }],
    ["custom", { provider: "custom", apiKey: KEY, baseUrl: "https://jev.example.com/v1" }],
  ])("accepts a %s config", (_name, obj) => {
    write(obj);
    const cfg = loadJevConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.provider).toBe(obj.provider);
  });

  describe.skipIf(!posix)("a config that is too open is refused", () => {
    it.each([0o644, 0o640, 0o604, 0o620, 0o602, 0o660, 0o666, 0o700 | 0o070])("mode %s", (mode) => {
      write({ provider: "typesafe", apiKey: KEY }, mode);
      expect(loadJevConfig()).toBeNull();
      const r = inspectJevConfig();
      expect(r.status).toBe("refused");
      if (r.status === "refused") {
        expect(r.reason).toBe("too-open");
        expect(r.mode).toBe(mode & 0o777);
        expect(r.problem).toContain("chmod 600");
        // The refusal never quotes the key.
        expect(r.problem).not.toContain(KEY);
      }
    });

    it("0400 (read-only owner) is fine", () => {
      write({ provider: "typesafe", apiKey: KEY }, 0o400);
      expect(loadJevConfig()?.provider).toBe("typesafe");
    });
  });

  it("ignores a project-scope .failproofai/jev.json in the working directory", () => {
    const project = join(home, "project");
    mkdirSync(join(project, ".failproofai"), { recursive: true });
    writeFileSync(join(project, ".failproofai", "jev.json"), JSON.stringify({ provider: "typesafe", apiKey: KEY }), { mode: 0o600 });
    // Also the other project-scope places a repo could put config.
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "jev.json"), JSON.stringify({ provider: "typesafe", apiKey: KEY }), { mode: 0o600 });
    process.chdir(project);
    expect(loadJevConfig()).toBeNull();
    expect(inspectJevConfig().status).toBe("absent");
  });

  it("never lets the environment set provider, endpoint, model or account", () => {
    write({ provider: "typesafe", apiKey: KEY });
    process.env.FAILPROOFAI_JEV_PROVIDER = "custom";
    process.env.FAILPROOFAI_JEV_BASE_URL = "https://evil.example.com";
    process.env.FAILPROOFAI_JEV_MODEL = "jev-1.13.9";
    process.env.FAILPROOFAI_JEV_ACCOUNT_ID = ACCOUNT;
    expect(loadJevConfig()).toEqual({ provider: "typesafe", apiKey: KEY, mode: "enforce", timeoutMs: 3000 });
  });

  it("never switches Jev on from the environment or the research credential dir", () => {
    process.env[JEV_API_KEY_ENV] = KEY;
    process.env.TYPESAFE_API_KEY = KEY;
    mkdirSync(join(home, "no-typesafe"), { recursive: true });
    writeFileSync(join(home, "no-typesafe", "api_key"), KEY, { mode: 0o600 });
    expect(loadJevConfig()).toBeNull();
  });

  describe(`${JEV_API_KEY_ENV}`, () => {
    it("supplies the key when the file has none", () => {
      write({ provider: "vercel" });
      expect(loadJevConfig()).toBeNull();
      process.env[JEV_API_KEY_ENV] = KEY;
      expect(loadJevConfig()).toMatchObject({ provider: "vercel", apiKey: KEY });
      const r = inspectJevConfig();
      expect(r.status === "ok" && r.keySource).toBe("env");
    });

    it("never replaces a key the file carries", () => {
      write({ provider: "typesafe", apiKey: KEY });
      process.env[JEV_API_KEY_ENV] = "other-key-value";
      expect(loadJevConfig()?.apiKey).toBe(KEY);
    });

    it("is refused, not trimmed into shape, when it is not a clean one-line key", () => {
      write({ provider: "typesafe" });
      process.env[JEV_API_KEY_ENV] = `${KEY}\r\nX-Injected: 1`;
      expect(loadJevConfig()).toBeNull();
      const r = inspectJevConfig();
      expect(r.status === "refused" && r.problem).toContain(JEV_API_KEY_ENV);
    });
  });

  describe("schema", () => {
    const problem = (obj: unknown) => {
      const r = validateJevConfig(obj);
      return r.ok ? null : r.problem;
    };

    it("rejects what is not a config", () => {
      expect(problem(null)).toMatch(/JSON object/);
      expect(problem([])).toMatch(/JSON object/);
      expect(problem({ provider: "anthropic", apiKey: KEY })).toMatch(/provider must be one of/);
      expect(problem({ provider: "typesafe" })).toMatch(/no API key/);
      expect(problem({ provider: "typesafe", apiKey: "" })).toMatch(/empty/);
      expect(problem({ provider: "typesafe", apiKey: "has space" })).toMatch(/visible ASCII/);
      expect(problem({ provider: "typesafe", apiKey: 42 })).toMatch(/empty/);
    });

    it("needs a baseUrl for custom and an account id for cloudflare", () => {
      expect(problem({ provider: "custom", apiKey: KEY })).toMatch(/custom needs a baseUrl/);
      expect(problem({ provider: "cloudflare", apiKey: KEY })).toMatch(/accountId/);
      expect(problem({ provider: "cloudflare", apiKey: KEY, accountId: "../../evil" })).toMatch(/accountId/);
      expect(problem({ provider: "cloudflare", apiKey: KEY, accountId: ACCOUNT.toUpperCase() })).toMatch(/accountId/);
    });

    it("drops an accountId on a provider that does not use it", () => {
      const r = validateJevConfig({ provider: "typesafe", apiKey: KEY, accountId: ACCOUNT });
      expect(r.ok && r.value.accountId).toBe(undefined);
    });

    it("bounds timeoutMs and mode", () => {
      expect(problem({ provider: "typesafe", apiKey: KEY, timeoutMs: 50 })).toMatch(/timeoutMs/);
      expect(problem({ provider: "typesafe", apiKey: KEY, timeoutMs: 60_000 })).toMatch(/timeoutMs/);
      expect(problem({ provider: "typesafe", apiKey: KEY, timeoutMs: 1500.5 })).toMatch(/timeoutMs/);
      expect(problem({ provider: "typesafe", apiKey: KEY, timeoutMs: "1500" })).toMatch(/timeoutMs/);
      expect(problem({ provider: "typesafe", apiKey: KEY, mode: "disabled" })).toMatch(/mode/);
      // `off` is a mode now: it keeps the file and runs no Jev (see jev-cloud-config.test.ts).
      expect(problem({ provider: "typesafe", apiKey: KEY, mode: "off" })).toBeNull();
      const r = validateJevConfig({ provider: "typesafe", apiKey: KEY, mode: "shadow", timeoutMs: 800 });
      expect(r.ok && [r.value.mode, r.value.timeoutMs]).toEqual(["shadow", 800]);
    });

    it("refuses a model naming a Jev family the thresholds were not calibrated for", () => {
      expect(problem({ provider: "typesafe", apiKey: KEY, model: "jev-1.14.0" })).toMatch(/calibrated for Jev 1\.13/);
      expect(problem({ provider: "openrouter", apiKey: KEY, model: "typesafe/jev-2.0" })).toMatch(/calibrated/);
      expect(problem({ provider: "typesafe", apiKey: KEY, model: "jev 1.13" })).toMatch(/model must be/);
      // Aliases carry no version and are allowed; the reported version is checked per call.
      expect(problem({ provider: "openrouter", apiKey: KEY, model: "~typesafe/jev-latest" })).toBeNull();
      expect(problem({ provider: "typesafe", apiKey: KEY, model: "jev-1.13.4" })).toBeNull();
    });

    it("ignores unknown keys so a newer file does not switch Jev off", () => {
      expect(problem({ provider: "typesafe", apiKey: KEY, someFutureField: { x: 1 } })).toBeNull();
    });

    it("refuses a file that is not JSON, without quoting it", () => {
      write(`{"provider":"typesafe","apiKey":"${KEY}"`);
      const r = inspectJevConfig();
      expect(r.status === "refused" && r.reason).toBe("not-json");
      expect(JSON.stringify(r)).not.toContain(KEY);
    });

    // A FIFO in the file's place is checked in jev-config-review.test.ts, in a
    // CHILD process with a spawn timeout. It cannot be checked here: a
    // regression to a blocking open() would hang this worker forever rather
    // than fail, because vitest's per-test timeout cannot interrupt a
    // synchronous syscall. See the rule pinned at the end of that file.

    it("refuses a directory in the file's place", () => {
      mkdirSync(jevConfigPath(), { recursive: true });
      expect(loadJevConfig()).toBeNull();
      expect(inspectJevConfig().status).toBe("refused");
    });
  });

  describe("baseUrl", () => {
    it("requires https, or http to loopback only", () => {
      expect(validateBaseUrl("https://jev.example.com/v1").ok).toBe(true);
      expect(validateBaseUrl("http://localhost:8787/v1").ok).toBe(true);
      expect(validateBaseUrl("http://127.0.0.1:8787").ok).toBe(true);
      expect(validateBaseUrl("http://[::1]:8787").ok).toBe(true);
      expect(validateBaseUrl("http://jev.example.com/v1").ok).toBe(false);
      expect(validateBaseUrl("ftp://jev.example.com").ok).toBe(false);
      expect(validateBaseUrl("not a url").ok).toBe(false);
    });

    it("refuses credentials and fragments in the URL", () => {
      expect(validateBaseUrl("https://user:pass@jev.example.com").ok).toBe(false);
      expect(validateBaseUrl("https://jev.example.com/#x").ok).toBe(false);
    });

    it("strips trailing slashes from the path only", () => {
      const a = validateBaseUrl("https://jev.example.com/v1///");
      expect(a.ok && a.value).toBe("https://jev.example.com/v1");
      const b = validateBaseUrl("https://jev.example.com/v1/?api-version=2");
      expect(b.ok && b.value).toBe("https://jev.example.com/v1?api-version=2");
    });

    /**
     * A key in the query string is a key in the endpoint: it is logged, printed
     * by `jev status`, put in error messages and returned to the dashboard,
     * while the field built to carry one is sent as a bearer and never printed.
     * So it is refused where it is written rather than elided where it is read
     * — eliding leaves the secret in the file and in everything the file feeds.
     */
    it.each([
      "https://gw.example.com/v1?token=s3cr3t-value",
      "https://gw.example.com/v1?api_key=s3cr3t-value",
      "https://gw.example.com/v1?apiKey=s3cr3t-value",
      "https://gw.example.com/v1?api-key=s3cr3t-value",
      "https://gw.example.com/v1?access_token=s3cr3t-value",
      "https://gw.example.com/v1?x-api-key=s3cr3t-value",
      "https://gw.example.com/v1?subscription-key=s3cr3t-value",
      "https://gw.example.com/v1?secret=s3cr3t-value",
      "https://gw.example.com/v1?password=s3cr3t-value",
      "https://gw.example.com/v1?auth=s3cr3t-value",
      "https://gw.example.com/v1?authorization=s3cr3t-value",
      "https://gw.example.com/v1?sig=s3cr3t-value",
      "https://gw.example.com/v1?api-version=2&token=s3cr3t-value",
    ])("refuses a credential-shaped query parameter: %s", (url) => {
      const r = validateBaseUrl(url);
      expect(r.ok).toBe(false);
      // The name is named — it is what the owner has to remove — and the value
      // never is, for the same reason a refused `model` is never quoted.
      expect(r.ok === false && r.problem).not.toContain("s3cr3t-value");
    });

    it("refuses a query value shaped like a credential under a name no list could carry", () => {
      const r = validateBaseUrl("https://gw.example.com/v1?t=sk-live-0123456789abcdefghij");
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.problem).not.toContain("sk-live");
    });

    it("still accepts the routing parameters the query string is permitted for", () => {
      // The case the comment in `validateBaseUrl` names, and the reason this is
      // a rule about parameter NAMES rather than about having a query at all.
      expect(validateBaseUrl("https://gw.example.com/v1?api-version=2026-01-01").ok).toBe(true);
      expect(validateBaseUrl("https://gw.example.com/v1?deployment=prod&region=eu").ok).toBe(true);
    });

    it("takes a query string off a base URL, parseable or not", () => {
      expect(baseUrlWithoutQuery("https://gw.example.com/v1?api-version=2")).toEqual({
        url: "https://gw.example.com/v1",
        hadQuery: true,
      });
      expect(baseUrlWithoutQuery("https://gw.example.com/v1")).toEqual({
        url: "https://gw.example.com/v1",
        hadQuery: false,
      });
      // A refused file is where this matters most, and its value may not parse.
      expect(baseUrlWithoutQuery("htp:/gw?token=s3cr3t-value")).toEqual({ url: "htp:/gw", hadQuery: true });
    });

    it("takes userinfo off too, which the loader refuses as a credential", () => {
      expect(baseUrlWithoutQuery("https://svc:sk-secret@gw.example.com/v1")).toEqual({
        url: "https://gw.example.com/v1",
        hadQuery: false,
      });
      expect(baseUrlWithoutQuery("https://svc:sk-secret@gw.example.com/v1?a=1").url).toBe("https://gw.example.com/v1");
      expect(baseUrlWithoutQuery("https://svc:sk-secret@bad host/v1").url).toBe("https://bad host/v1");
    });
  });

  describe("model versions", () => {
    it("reads the version out of every provider's spelling", () => {
      expect(jevModelVersion("jev-1.13.0")).toEqual({ major: 1, minor: 13, patch: 0, date: null });
      expect(jevModelVersion("typesafe/jev-1.13-20260917")).toEqual({ major: 1, minor: 13, patch: null, date: "20260917" });
      expect(jevModelVersion("typesafe/jev-1.13")).toEqual({ major: 1, minor: 13, patch: null, date: null });
      expect(jevModelVersion("typesafe-ai/jev-1.13.2")).toMatchObject({ major: 1, minor: 13, patch: 2 });
    });

    it("treats aliases as unversioned", () => {
      for (const alias of ["typesafe/jev", "typesafe-ai/jev", "~typesafe/jev-latest", "jev-latest", "jev"]) {
        expect(jevModelVersion(alias)).toBeNull();
      }
    });

    it("calls only the 1.13 family calibrated", () => {
      expect(isCalibratedJevModel("jev-1.13.7")).toBe(true);
      expect(isCalibratedJevModel("typesafe/jev-1.13-20270101")).toBe(true);
      expect(isCalibratedJevModel("jev-1.12.9")).toBe(false);
      expect(isCalibratedJevModel("jev-2.13.0")).toBe(false);
      expect(isCalibratedJevModel("jev-1.130.0")).toBe(false);
      expect(isCalibratedJevModel("typesafe-ai/jev")).toBe(false);
    });
  });
});
