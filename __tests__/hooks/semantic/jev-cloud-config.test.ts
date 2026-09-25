// @vitest-environment node
/**
 * The FailproofAI Cloud provider (`provider: "failproofai"`) and `mode: "off"`.
 *
 * The Cloud route is the one provider whose key is not in `jev.json`: it lives
 * in the `jev` slot of `credentials.json`, written by `config --token`. So the
 * properties pinned here are the ones that keep that second file from becoming
 * a second, weaker way in:
 *
 *   - the key comes from `credentials.json` and nowhere else — an `apiKey` in
 *     the file is refused, `FAILPROOFAI_JEV_API_KEY` is ignored, and
 *     `FAILPROOFAI_CLOUD_CREDENTIALS` (the daemon's override) is never read;
 *   - `credentials.json` gets `jev.json`'s owner-only checks: a loose file or
 *     directory is REFUSED, not read, and Jev is off;
 *   - the base URL's origin must equal the credential's, so a key is only sent
 *     where it was issued;
 *   - no credential is `not-connected` — off, with a status that says so;
 *   - `off` runs no Jev for any provider, and is not `ok`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JEV_API_KEY_ENV,
  JEV_CLOUD_BASE_PATH,
  JEV_PROVIDER_KINDS,
  inspectJevConfig,
  jevCloudBaseUrl,
  jevConfigPath,
  loadJevConfig,
  validateJevConfig,
  validateLoadedJevConfig,
  type JevConfig,
} from "../../../src/hooks/semantic/jev-config";
import { JevError, jevRoute, transportForConfig } from "../../../src/hooks/semantic/jev-client";
import {
  clearJevCloudCredential,
  readCredentials,
  readJevCloudCredential,
  writeCredentials,
  writeJevCloudCredential,
} from "../../../src/hooks/fp-config";
import { credentialsFile } from "../../../src/hooks/fp-home";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const KEY = ["fp", "machine", "0123456789abcdef"].join("-");
const OTHER_KEY = ["fp", "other", "fedcba9876543210"].join("-");
const ORIGIN = "https://app.befailproof.ai";
const BASE = `${ORIGIN}/enforcement/v1/jev`;
const posix = process.platform !== "win32";

const ENV_KEYS = ["FAILPROOFAI_HOME", JEV_API_KEY_ENV, "FAILPROOFAI_CLOUD_CREDENTIALS", "FAILPROOFAI_JEV_CONFIG_DIR"] as const;

describe("jev-config: the FailproofAI Cloud provider", () => {
  let home: string;
  let fpHome: string;
  const saved: Partial<Record<string, string | undefined>> = {};
  const savedCwd = process.cwd();

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    home = mkdtempSync(join(tmpdir(), "fp-jev-cloud-"));
    fpHome = join(home, ".failproofai");
    process.env.FAILPROOFAI_HOME = fpHome;
    process.env.FAILPROOFAI_JEV_CONFIG_DIR = join(home, "no-typesafe");
    mkdirSync(fpHome, { recursive: true, mode: 0o700 });
    chmodSync(fpHome, 0o700);
  });
  afterEach(() => {
    process.chdir(savedCwd);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  const writeJev = (obj: unknown, mode = 0o600) => {
    const file = jevConfigPath();
    writeFileSync(file, JSON.stringify(obj), { mode });
    chmodSync(file, mode);
  };
  // What `config --token` leaves: the Jev slot AND the reporting credential it
  // came with. A slot counts only while a connection on its origin is there.
  const connect = (url = ORIGIN, key = KEY) => {
    const current = readCredentials();
    if (!current.ingest) writeCredentials({ ...current, ingest: { url: `${url}/v1/events`, key } });
    return writeJevCloudCredential({ url, key });
  };
  const cloudFile = (over: Record<string, unknown> = {}) => ({ provider: "failproofai", baseUrl: BASE, mode: "shadow", ...over });

  describe("the credentials.json slot", () => {
    it("round-trips at 0600, beside every other credential, and clears alone", () => {
      writeCredentials({ ingest: { url: `${ORIGIN}/v1/events`, key: OTHER_KEY }, org: { slug: "acme" } });
      connect();
      expect(readCredentials().jev).toEqual({ url: ORIGIN, key: KEY });
      expect(readCredentials().ingest?.key).toBe(OTHER_KEY);
      if (posix) expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
      const onDisk = JSON.parse(readFileSync(credentialsFile(), "utf8"));
      expect(onDisk.jev).toEqual({ url: ORIGIN, key: KEY });

      expect(clearJevCloudCredential()).toBe(true);
      expect(readCredentials().jev).toBeUndefined();
      expect(readCredentials().ingest?.key).toBe(OTHER_KEY);
      expect(readCredentials().org?.slug).toBe("acme");
      expect(clearJevCloudCredential()).toBe(false);
    });

    it("survives a write by another capability's writer", () => {
      connect();
      // What `writeIngestCredential` and `writeCloudCredentials` do.
      writeCredentials({ ...readCredentials(), ingest: { url: `${ORIGIN}/v1/events`, key: KEY } });
      expect(readCredentials().jev).toEqual({ url: ORIGIN, key: KEY });
    });

    it("reads as absent with no file, or a file with no usable slot", () => {
      expect(readJevCloudCredential().status).toBe("absent");
      writeCredentials({ ingest: { url: `${ORIGIN}/v1/events`, key: KEY } });
      expect(readJevCloudCredential().status).toBe("absent");
      writeFileSync(credentialsFile(), JSON.stringify({ jev: { url: ORIGIN, key: "" } }), { mode: 0o600 });
      expect(readJevCloudCredential().status).toBe("absent");
    });

    it.skipIf(!posix)("refuses a credentials file other users can read or write", () => {
      connect();
      for (const mode of [0o644, 0o640, 0o620, 0o604]) {
        chmodSync(credentialsFile(), mode);
        const r = readJevCloudCredential();
        expect(r.status).toBe("refused");
        if (r.status === "refused") {
          expect(r.reason).toBe("too-open");
          expect(r.fix).toBe(`chmod 600 ${credentialsFile()}`);
          expect(JSON.stringify(r)).not.toContain(KEY);
        }
      }
    });

    it.skipIf(!posix)("refuses a credentials file in a directory other users can write", () => {
      connect();
      chmodSync(fpHome, 0o770);
      const r = readJevCloudCredential();
      expect(r.status).toBe("refused");
      expect(r.status === "refused" && r.fix).toBe(`chmod 700 ${fpHome}`);
    });

    it("refuses one that is not JSON, or too large to be a credentials file", () => {
      writeFileSync(credentialsFile(), "{not json", { mode: 0o600 });
      chmodSync(credentialsFile(), 0o600);
      expect(readJevCloudCredential()).toMatchObject({ status: "refused", reason: "not-json" });
      writeFileSync(credentialsFile(), JSON.stringify({ jev: { url: ORIGIN, key: KEY }, pad: "x".repeat(70_000) }), { mode: 0o600 });
      expect(readJevCloudCredential()).toMatchObject({ status: "refused", reason: "too-large" });
    });

    it("never reads FAILPROOFAI_CLOUD_CREDENTIALS: an env var cannot supply the key Jev spends", () => {
      const elsewhere = join(home, "elsewhere.json");
      writeFileSync(elsewhere, JSON.stringify({ jev: { url: ORIGIN, key: OTHER_KEY } }), { mode: 0o600 });
      process.env.FAILPROOFAI_CLOUD_CREDENTIALS = elsewhere;
      expect(readJevCloudCredential().status).toBe("absent");
      writeJev(cloudFile());
      expect(inspectJevConfig().status).toBe("not-connected");
      expect(loadJevConfig()).toBeNull();
    });
  });

  describe("the slot counts only beside the connection it came with", () => {
    const INGEST = { url: `${ORIGIN}/v1/events`, key: KEY };

    it("a slot with no connection beside it is ignored: not-connected, and Jev is off", () => {
      writeCredentials({ jev: { url: ORIGIN, key: KEY } });
      expect(readJevCloudCredential()).toMatchObject({ status: "absent", connected: false, orphaned: true });
      writeJev(cloudFile());
      expect(inspectJevConfig().status).toBe("not-connected");
      expect(loadJevConfig()).toBeNull();
    });

    it("downgrade → disconnect → upgrade does not re-arm Cloud Jev", () => {
      // Connected by this build: the slot, the reporting and the policy credential.
      writeCredentials({ cloud: { url: ORIGIN, machineId: "m-1", token: KEY }, ingest: INGEST, jev: { url: ORIGIN, key: KEY } });
      writeJev(cloudFile());
      expect(loadJevConfig()?.apiKey).toBe(KEY);
      // An older build's disconnect: it drops the two tables it knows and
      // carries `jev` over as a key it does not own. jev.json is not touched.
      const raw = JSON.parse(readFileSync(credentialsFile(), "utf8")) as Record<string, unknown>;
      delete raw.cloud;
      delete raw.ingest;
      writeFileSync(credentialsFile(), JSON.stringify(raw), { mode: 0o600 });
      expect(readCredentials().jev).toEqual({ url: ORIGIN, key: KEY });
      // Back on this build: the key is still on disk, and Jev stays off.
      expect(inspectJevConfig().status).toBe("not-connected");
      expect(loadJevConfig()).toBeNull();
    });

    it("a connection on ANOTHER origin does not back it: connected, but no Jev key", () => {
      writeCredentials({ ingest: { url: "https://staging.befailproof.ai/v1/events", key: OTHER_KEY }, jev: { url: ORIGIN, key: KEY } });
      expect(readJevCloudCredential()).toMatchObject({ status: "absent", connected: true, orphaned: true });
      writeJev(cloudFile());
      expect(inspectJevConfig().status).toBe("key-lacks-jev");
      expect(loadJevConfig()).toBeNull();
    });

    it("either the policy or the reporting credential backs it, under any path on its origin", () => {
      writeCredentials({ cloud: { url: `${ORIGIN}/fp`, machineId: "m-1", token: KEY }, jev: { url: ORIGIN, key: KEY } });
      expect(readJevCloudCredential().status).toBe("ok");
      writeCredentials({ ingest: INGEST, jev: { url: ORIGIN, key: KEY } });
      expect(readJevCloudCredential().status).toBe("ok");
      writeJev(cloudFile());
      expect(loadJevConfig()?.apiKey).toBe(KEY);
    });

    it("connected with a key that has no Jev: key-lacks-jev — not not-connected — and off", () => {
      writeCredentials({ cloud: { url: ORIGIN, machineId: "m-1", token: KEY }, ingest: INGEST });
      expect(readJevCloudCredential()).toMatchObject({ status: "absent", connected: true });
      writeJev(cloudFile());
      const r = inspectJevConfig();
      expect(r.status).toBe("key-lacks-jev");
      if (r.status !== "key-lacks-jev") return;
      expect(r.routing).toEqual({ provider: "failproofai", baseUrl: BASE, mode: "shadow", timeoutMs: 3000 });
      expect(r.problem).toContain("does not carry jev:evaluate");
      expect(r.problem).not.toMatch(/not connected/);
      expect(JSON.stringify(r)).not.toContain(KEY);
      expect(loadJevConfig()).toBeNull();
    });

    it("a broken Cloud file on a connected machine is still refused, not key-lacks-jev", () => {
      writeCredentials({ ingest: INGEST });
      writeJev(cloudFile({ timeoutMs: 60_000 }));
      expect(inspectJevConfig()).toMatchObject({ status: "refused", reason: "invalid" });
    });
  });

  describe("loading", () => {
    it("is a known provider kind", () => {
      expect(JEV_PROVIDER_KINDS).toContain("failproofai");
    });

    it("builds the base URL connect writes", () => {
      expect(JEV_CLOUD_BASE_PATH).toBe("/enforcement/v1/jev");
      expect(jevCloudBaseUrl(ORIGIN)).toBe(BASE);
      expect(jevCloudBaseUrl(`${ORIGIN}/`)).toBe(BASE);
      // A self-hosted Cloud under a path prefix: the same prefix, as the
      // desired-state pull uses it.
      expect(jevCloudBaseUrl(`${ORIGIN}/fp`)).toBe(`${ORIGIN}/fp/enforcement/v1/jev`);
    });

    it("loads with the credential's key, and reports it as the cloud source", () => {
      connect();
      writeJev(cloudFile());
      const r = inspectJevConfig();
      expect(r.status).toBe("ok");
      if (r.status !== "ok") return;
      expect(r.keySource).toBe("cloud");
      expect(r.config).toMatchObject({ provider: "failproofai", apiKey: KEY, baseUrl: BASE, mode: "shadow", timeoutMs: 3000 });
      expect(loadJevConfig()?.apiKey).toBe(KEY);
      // The route the transport will POST to.
      expect(jevRoute(r.config).endpoint).toBe(`${BASE}/systemone`);
      expect(jevRoute(r.config).model).toBe("jev-1.13.0");
      expect(() => transportForConfig(r.config)).not.toThrow();
      expect(transportForConfig(r.config).via).toBe("failproofai");
      expect(validateLoadedJevConfig(r.config).ok).toBe(true);
    });

    describe("validateLoadedJevConfig checks the origin again, for real", () => {
      const loaded = () => {
        connect();
        writeJev(cloudFile());
        const cfg = loadJevConfig();
        if (!cfg) throw new Error("expected a loaded config");
        return cfg;
      };

      it("the loader records the credential's origin, and the loaded config passes", () => {
        const cfg = loaded();
        expect(cfg.credentialOrigin).toBe(ORIGIN);
        expect(validateLoadedJevConfig(cfg).ok).toBe(true);
      });

      it("a Cloud config built by hand, with no credential origin, is refused — no route, no transport", () => {
        const byHand: JevConfig = { provider: "failproofai", apiKey: KEY, baseUrl: BASE, mode: "enforce", timeoutMs: 3000 };
        const r = validateLoadedJevConfig(byHand);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.problem).not.toContain(KEY);
        expect(() => jevRoute(byHand)).toThrow(JevError);
        expect(() => transportForConfig(byHand)).toThrow(JevError);
      });

      it("a loaded config whose base URL has since moved to another origin is refused", () => {
        const moved = { ...loaded(), baseUrl: "https://evil.example.com/enforcement/v1/jev" };
        expect(validateLoadedJevConfig(moved).ok).toBe(false);
        expect(() => transportForConfig(moved)).toThrow(JevError);
      });

      it("…and so is one whose credential origin was swapped for another", () => {
        const swapped = { ...loaded(), credentialOrigin: "https://evil.example.com" };
        expect(validateLoadedJevConfig(swapped).ok).toBe(false);
      });

      it("a credentialOrigin written into jev.json is ignored: only the credential sets it", () => {
        connect();
        writeJev(cloudFile({ credentialOrigin: "https://evil.example.com" }));
        expect(loadJevConfig()?.credentialOrigin).toBe(ORIGIN);
      });
    });

    it("defaults to enforce when the file names no mode, like every provider", () => {
      connect();
      writeJev({ provider: "failproofai", baseUrl: BASE });
      expect(loadJevConfig()?.mode).toBe("enforce");
    });

    it("refuses an apiKey in the file, without quoting it", () => {
      connect();
      writeJev(cloudFile({ apiKey: OTHER_KEY }));
      const r = inspectJevConfig();
      expect(r).toMatchObject({ status: "refused", reason: "invalid" });
      expect(JSON.stringify(r)).not.toContain(OTHER_KEY);
      expect(loadJevConfig()).toBeNull();
    });

    it("ignores FAILPROOFAI_JEV_API_KEY: never the key, never a substitute for the connection", () => {
      process.env[JEV_API_KEY_ENV] = OTHER_KEY;
      writeJev(cloudFile());
      expect(inspectJevConfig().status).toBe("not-connected");
      expect(loadJevConfig()).toBeNull();
      connect();
      expect(loadJevConfig()?.apiKey).toBe(KEY);
    });

    it("needs a baseUrl", () => {
      connect();
      writeJev({ provider: "failproofai", mode: "shadow" });
      expect(inspectJevConfig()).toMatchObject({ status: "refused", reason: "invalid" });
    });

    it.each([
      ["another host", "https://evil.example.com/enforcement/v1/jev"],
      ["another port", "https://app.befailproof.ai:8443/enforcement/v1/jev"],
      ["another scheme", "http://app.befailproof.ai/enforcement/v1/jev"],
      ["a subdomain", "https://x.app.befailproof.ai/enforcement/v1/jev"],
    ])("refuses a base URL on %s than the credential's origin", (_name, baseUrl) => {
      connect();
      writeJev(cloudFile({ baseUrl }));
      const r = inspectJevConfig();
      expect(r.status).toBe("refused");
      expect(loadJevConfig()).toBeNull();
    });

    it("accepts any path under the credential's origin", () => {
      connect();
      writeJev(cloudFile({ baseUrl: `${ORIGIN}/somewhere/else` }));
      expect(loadJevConfig()?.baseUrl).toBe(`${ORIGIN}/somewhere/else`);
    });

    it("is not-connected, and off, with no credential — and the routing is still reported", () => {
      writeJev(cloudFile());
      const r = inspectJevConfig();
      expect(r.status).toBe("not-connected");
      if (r.status !== "not-connected") return;
      expect(r.routing).toEqual({ provider: "failproofai", baseUrl: BASE, mode: "shadow", timeoutMs: 3000 });
      expect(r.problem).toMatch(/not connected to FailproofAI Cloud/);
      expect(r.problem).toMatch(/config --token/);
      expect(loadJevConfig()).toBeNull();
    });

    it("a not-connected file that is broken further down is refused, not reported as fine", () => {
      writeJev(cloudFile({ timeoutMs: 60_000 }));
      expect(inspectJevConfig()).toMatchObject({ status: "refused", reason: "invalid" });
    });

    it.skipIf(!posix)("refuses — does not read — a loose credentials file, and Jev is off", () => {
      connect();
      writeJev(cloudFile());
      chmodSync(credentialsFile(), 0o644);
      const r = inspectJevConfig();
      expect(r).toMatchObject({ status: "refused", reason: "too-open", fix: `chmod 600 ${credentialsFile()}` });
      expect(JSON.stringify(r)).not.toContain(KEY);
      expect(loadJevConfig()).toBeNull();
    });

    it("refuses a credential that names no usable origin", () => {
      writeCredentials({ jev: { url: "ftp://app.befailproof.ai", key: KEY }, ingest: { url: "ftp://app.befailproof.ai/v1/events", key: KEY } });
      writeJev(cloudFile());
      expect(inspectJevConfig()).toMatchObject({ status: "refused", reason: "invalid" });
    });

    it("refuses a credential key that could not go in a header", () => {
      writeCredentials({ jev: { url: ORIGIN, key: `${KEY}\r\nX-Injected: 1` }, ingest: { url: `${ORIGIN}/v1/events`, key: KEY } });
      writeJev(cloudFile());
      const r = inspectJevConfig();
      expect(r).toMatchObject({ status: "refused", reason: "invalid" });
      expect(JSON.stringify(r)).not.toContain(KEY);
    });

    it("keeps plain http to localhost out of enforce mode, as for every provider", () => {
      const local = "http://localhost:8080";
      connect(local);
      writeJev(cloudFile({ baseUrl: `${local}/enforcement/v1/jev`, mode: "shadow" }));
      expect(loadJevConfig()?.baseUrl).toBe(`${local}/enforcement/v1/jev`);
      writeJev(cloudFile({ baseUrl: `${local}/enforcement/v1/jev`, mode: "enforce" }));
      expect(inspectJevConfig()).toMatchObject({ status: "refused", reason: "invalid" });
    });

    it("is never read from a project's .failproofai", () => {
      const project = join(home, "repo");
      mkdirSync(join(project, ".failproofai"), { recursive: true });
      writeFileSync(join(project, ".failproofai", "jev.json"), JSON.stringify(cloudFile()), { mode: 0o600 });
      writeFileSync(join(project, ".failproofai", "credentials.json"), JSON.stringify({ jev: { url: ORIGIN, key: OTHER_KEY } }), {
        mode: 0o600,
      });
      process.chdir(project);
      expect(inspectJevConfig().status).toBe("absent");
      writeJev(cloudFile());
      expect(inspectJevConfig().status).toBe("not-connected");
    });
  });

  describe("mode off", () => {
    it.each([
      ["FailproofAI Cloud, connected", () => connect(), cloudFile({ mode: "off" })],
      ["FailproofAI Cloud, not connected", () => {}, cloudFile({ mode: "off" })],
      ["BYOK with a stored key", () => {}, { provider: "typesafe", apiKey: KEY, mode: "off" }],
      ["BYOK taking its key from the environment", () => {}, { provider: "typesafe", mode: "off" }],
      ["a custom loopback proxy over plain http", () => {}, { provider: "custom", apiKey: KEY, baseUrl: "http://localhost:4000/v1", mode: "off" }],
    ])("%s: status off, and no config reaches the hook path", (_name, arrange, file) => {
      arrange();
      writeJev(file);
      const r = inspectJevConfig();
      expect(r.status).toBe("off");
      if (r.status === "off") {
        expect(r.routing.mode).toBe("off");
        expect(JSON.stringify(r)).not.toContain(KEY);
      }
      expect(loadJevConfig()).toBeNull();
    });

    it("an off file that is broken is refused, not off", () => {
      writeJev({ provider: "custom", apiKey: KEY, mode: "off" });
      expect(inspectJevConfig()).toMatchObject({ status: "refused", reason: "invalid" });
      writeJev(cloudFile({ mode: "off", apiKey: KEY }));
      expect(inspectJevConfig()).toMatchObject({ status: "refused", reason: "invalid" });
    });

    it("validates as a mode, alongside shadow and enforce, and nothing else", () => {
      for (const mode of ["off", "shadow", "enforce"]) {
        expect(validateJevConfig({ provider: "typesafe", apiKey: KEY, mode }).ok).toBe(true);
      }
      for (const mode of ["disabled", "OFF", "", 0, false, null]) {
        expect(validateJevConfig({ provider: "typesafe", apiKey: KEY, mode }).ok).toBe(false);
      }
    });
  });
});
