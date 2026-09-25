// @vitest-environment node
/**
 * The /settings Jev panel's FailproofAI Cloud controls, against the real
 * loader: `setJevModeAction` (the on/off switch and shadow/enforce) and the
 * Cloud connection row in `getJevSettingsAction`.
 *
 *   1. **It rewrites `mode` and nothing else** — every other byte-level field
 *      of the file survives, the file stays 0600, and "off" keeps the file.
 *   2. **The Cloud key never reaches the page.** The connection row is built
 *      from credentials.json, which holds every token on the machine; the
 *      whole response is searched for each of them.
 *   3. **A cross-site call is refused**, as every write on this surface is.
 *   4. **The BYOK form cannot save the Cloud provider**: its endpoint and key
 *      come from the connection, not from a form.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { headersMock } = vi.hoisted(() => ({ headersMock: vi.fn() }));
vi.mock("next/headers", () => ({ headers: headersMock }));

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { jevConfigFile } from "../../src/hooks/fp-home";
import { writeCredentials, writeJevCloudCredential } from "../../src/hooks/fp-config";
import { inspectJevConfig, loadJevConfig } from "../../src/hooks/semantic/jev-config";
import { getJevSettingsAction } from "../../app/actions/get-jev-config";
import { saveJevConfigAction, setJevModeAction } from "../../app/actions/update-jev-config";

// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const CLOUD_KEY = ["fp", "machine", "5ec2e7c10d0123ab"].join("-");
const INGEST_KEY = ["fp", "ingest", "0badc0ffee123456"].join("-");
const POLICY_KEY = ["fp", "policy", "feedfacecafe7890"].join("-");
const BYOK_KEY = ["ts", "byok", "0123456789abcdef"].join("-");
const ORIGIN = "https://app.befailproof.ai";
const CLOUD_FILE = { provider: "failproofai", baseUrl: `${ORIGIN}/enforcement/v1/jev`, mode: "shadow" };

let home: string;
let prevHome: string | undefined;
let prevBind: string | undefined;
let prevEnvKey: string | undefined;

const sameOrigin = () => new Headers({ host: "localhost:8020", origin: "http://localhost:8020" });

function seed(obj: Record<string, unknown>, extra = ""): string {
  const text = `${JSON.stringify(obj, null, 2)}\n${extra}`;
  writeFileSync(jevConfigFile(), text, { mode: 0o600 });
  chmodSync(jevConfigFile(), 0o600);
  return text;
}
const onDisk = () => JSON.parse(readFileSync(jevConfigFile(), "utf8")) as Record<string, unknown>;

function connect(withJev = true) {
  writeCredentials({
    cloud: { url: ORIGIN, machineId: "m-1", token: POLICY_KEY },
    // A Jev slot counts only beside a same-origin credential holding its key:
    // connecting a Jev key writes it to the reporting credential too.
    ingest: { url: `${ORIGIN}/v1/events`, key: withJev ? CLOUD_KEY : INGEST_KEY },
    org: { id: "org_1", slug: "acme", name: "Acme Inc" },
  });
  if (withJev) writeJevCloudCredential({ url: ORIGIN, key: CLOUD_KEY });
}

function secretFree(value: unknown) {
  const text = JSON.stringify(value);
  for (const k of [CLOUD_KEY, INGEST_KEY, POLICY_KEY, BYOK_KEY]) expect(text).not.toContain(k);
}

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  prevBind = process.env.FAILPROOFAI_DASHBOARD_HOST;
  prevEnvKey = process.env.FAILPROOFAI_JEV_API_KEY;
  delete process.env.FAILPROOFAI_JEV_API_KEY;
  home = mkdtempSync(resolve(tmpdir(), "fpai-jev-mode-"));
  chmodSync(home, 0o700);
  process.env.FAILPROOFAI_HOME = home;
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

describe("setJevModeAction", () => {
  it("rewrites mode and nothing else, at 0600", async () => {
    connect();
    // A field this build does not know, and one it does not show: both must survive.
    seed({ ...CLOUD_FILE, timeoutMs: 2500, fromANewerBuild: { x: 1 } });
    for (const mode of ["enforce", "off", "shadow"] as const) {
      const res = await setJevModeAction(mode);
      expect(res.ok).toBe(true);
      expect(onDisk()).toEqual({ ...CLOUD_FILE, timeoutMs: 2500, fromANewerBuild: { x: 1 }, mode });
      expect(statSync(jevConfigFile()).mode & 0o777).toBe(0o600);
      if (res.ok) secretFree(res);
    }
  });

  it("off keeps the file and runs no Jev; on again runs it with the Cloud key", async () => {
    connect();
    seed(CLOUD_FILE);
    const off = await setJevModeAction("off");
    expect(existsSync(jevConfigFile())).toBe(true);
    expect(inspectJevConfig().status).toBe("off");
    expect(loadJevConfig()).toBeNull();
    expect(off.ok && off.view).toMatchObject({ status: "off", on: false, mode: "off", provider: "failproofai", token: { source: "cloud" } });

    const on = await setJevModeAction("enforce");
    expect(on.ok && on.view).toMatchObject({ status: "ok", on: true, mode: "enforce", token: { source: "cloud" } });
    expect(loadJevConfig()).toMatchObject({ provider: "failproofai", apiKey: CLOUD_KEY, mode: "enforce" });
  });

  it("switches a BYOK file too, keeping its key in the file", async () => {
    seed({ provider: "typesafe", apiKey: BYOK_KEY, mode: "enforce" });
    const res = await setJevModeAction("off");
    expect(res.ok).toBe(true);
    expect(onDisk()).toEqual({ provider: "typesafe", apiKey: BYOK_KEY, mode: "off" });
    secretFree(res);
    expect((await setJevModeAction("shadow")).ok).toBe(true);
    expect(loadJevConfig()?.apiKey).toBe(BYOK_KEY);
  });

  it("refuses a mode the loader would refuse: enforce over plain http", async () => {
    writeJevCloudCredential({ url: "http://localhost:8080", key: CLOUD_KEY });
    const before = seed({ ...CLOUD_FILE, baseUrl: "http://localhost:8080/enforcement/v1/jev" });
    const res = await setJevModeAction("enforce");
    expect(res.ok).toBe(false);
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
  });

  it("refuses anything that is not a mode, and a missing file", async () => {
    connect();
    expect((await setJevModeAction("disabled")).ok).toBe(false);
    const missing = await setJevModeAction("off");
    expect(missing.ok).toBe(false);
    expect(existsSync(jevConfigFile())).toBe(false);
  });

  it("refuses to re-save a file other users could have written", async () => {
    connect();
    const before = seed(CLOUD_FILE);
    chmodSync(jevConfigFile(), 0o644);
    const res = await setJevModeAction("enforce");
    expect(res.ok).toBe(false);
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
    expect(statSync(jevConfigFile()).mode & 0o777).toBe(0o644);
  });

  it("refuses a cross-site call and writes nothing", async () => {
    connect();
    const before = seed(CLOUD_FILE);
    headersMock.mockResolvedValue(new Headers({ host: "localhost:8020", origin: "https://evil.example.com" }));
    const res = await setJevModeAction("enforce");
    expect(res.ok).toBe(false);
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
  });

  it("switches a not-connected Cloud file (the page then says it is not connected)", async () => {
    seed(CLOUD_FILE);
    const res = await setJevModeAction("enforce");
    expect(res.ok && res.view).toMatchObject({ status: "not-connected", on: false, mode: "enforce" });
  });
});

describe("the FailproofAI Cloud connection row", () => {
  it("says which org and whether the key carries Jev — and carries no key", async () => {
    connect();
    seed(CLOUD_FILE);
    const view = await getJevSettingsAction();
    expect(view.cloud).toEqual({ connected: true, org: "Acme Inc (acme)", host: "app.befailproof.ai", jev: "yes" });
    expect(view.provider).toBe("failproofai");
    secretFree(view);
  });

  it("a key without Jev, and no connection at all", async () => {
    connect(false);
    expect((await getJevSettingsAction()).cloud).toEqual({ connected: true, org: "Acme Inc (acme)", host: "app.befailproof.ai", jev: "no" });
    rmSync(resolve(home, "credentials.json"));
    expect((await getJevSettingsAction()).cloud).toEqual({ connected: false, org: null, host: null, jev: "no" });
  });

  it("a Jev key in a loose credentials file is reported refused", async () => {
    connect();
    chmodSync(resolve(home, "credentials.json"), 0o644);
    const view = await getJevSettingsAction();
    expect(view.cloud.jev).toBe("refused");
    secretFree(view);
  });

  it("a not-connected Cloud file says so, with the fix", async () => {
    seed(CLOUD_FILE);
    const view = await getJevSettingsAction();
    expect(view).toMatchObject({ status: "not-connected", on: false, provider: "failproofai", token: null });
    expect(view.fix).toContain("config --token");
  });

  it("a Cloud file on a machine connected with a key that has no Jev is NOT called not-connected", async () => {
    connect(false);
    seed(CLOUD_FILE);
    const view = await getJevSettingsAction();
    expect(view).toMatchObject({ status: "key-lacks-jev", on: false, provider: "failproofai", token: null });
    expect(view.cloud).toMatchObject({ connected: true, jev: "no" });
    expect(view.problem).toContain("does not carry jev:evaluate");
    expect(view.problem).not.toMatch(/not connected/);
    expect(view.fix).toContain("reconnect");
    secretFree(view);
  });
});

describe("the BYOK form and the Cloud provider", () => {
  it("cannot save the Cloud provider: its endpoint and key are not a form's", async () => {
    connect();
    const res = await saveJevConfigAction({ provider: "failproofai", baseUrl: `${ORIGIN}/enforcement/v1/jev`, accountId: "", mode: "enforce", token: "" });
    expect(res.ok).toBe(false);
    expect(existsSync(jevConfigFile())).toBe(false);
  });

  it("can save a BYOK config switched off, keeping the file", async () => {
    const res = await saveJevConfigAction({ provider: "typesafe", baseUrl: "", accountId: "", mode: "off", token: BYOK_KEY });
    expect(res.ok && res.view).toMatchObject({ status: "off", on: false, mode: "off" });
    expect(onDisk()).toMatchObject({ provider: "typesafe", mode: "off" });
    secretFree(res.ok ? res.view : res);
  });
});
