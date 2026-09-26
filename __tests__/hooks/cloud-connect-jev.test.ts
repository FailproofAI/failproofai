// @vitest-environment node
/**
 * What connecting and disconnecting do to Jev.
 *
 *   - A key whose introspect lists `jev:evaluate` stores itself in the `jev`
 *     slot of credentials.json, under the origin it was verified against, and —
 *     only when there is NO jev.json — writes one that turns Jev on through
 *     FailproofAI Cloud in shadow mode.
 *   - An existing jev.json is never overwritten, whatever it names.
 *   - A key introspect says lacks `jev:evaluate` writes no Jev state at all,
 *     and drops the Jev key a previous connection left. An introspect that
 *     gives no answer (unreachable, or a server without it) turns nothing on,
 *     keeps a slot that already holds this very key, and drops any other.
 *   - `--no-transcripts` stores the key and never switches Jev on.
 *   - Disconnect clears the slot and deletes jev.json only when it names the
 *     Cloud provider; a BYOK file stays, byte for byte.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { connectToCloud, configuredPaths, describeOutcome } from "../../src/hooks/cloud-connection";
import { runConnectCommand, runDisconnectCommand } from "../../src/hooks/cloud-enrollment-cli";
import { readCredentials, writeJevCloudCredential } from "../../src/hooks/fp-config";
import { credentialsFile, jevConfigFile } from "../../src/hooks/fp-home";
import { inspectJevConfig, loadJevConfig, validateJevConfig } from "../../src/hooks/semantic/jev-config";
import { writeCloudJevConfigIfAbsent } from "../../src/hooks/jev-cloud-connection";
import { introspectKey, type IntrospectResult } from "../../src/hooks/cloud-introspect";
import { runJevCommand } from "../../src/hooks/jev-cli";

const posix = process.platform !== "win32";
// Built at runtime: this repo's own hooks refuse secret-shaped literals.
const TOKEN = ["fp", "machine", "0a1b2c3d4e5f6789"].join("-");
const OLD_TOKEN = ["fp", "earlier", "9f8e7d6c5b4a3210"].join("-");
const BYOK_KEY = ["ts", "byok", "0123456789abcdef"].join("-");
const URL_ = "https://app.befailproof.ai";

let home: string;
let prevHome: string | undefined;
let prevCloudCreds: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  prevCloudCreds = process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
  delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
  home = mkdtempSync(resolve(tmpdir(), "fpai-connect-jev-"));
  process.env.FAILPROOFAI_HOME = home;
  chmodSync(home, 0o700);
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  if (prevCloudCreds === undefined) delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
  else process.env.FAILPROOFAI_CLOUD_CREDENTIALS = prevCloudCreds;
  rmSync(home, { recursive: true, force: true });
});

const ORG = { orgId: "org_123", orgSlug: "acme", orgName: "Acme Inc" };
const MACHINE_PRESET = ["events:add", "policies:pull", "jev:evaluate"];

const introspecting = (result: IntrospectResult) => async () => result;
const withPermissions = (...permissions: string[]) => introspecting({ kind: "ok", identity: { ...ORG, permissions } });

function connect(introspect: (origin: string, token: string) => Promise<IntrospectResult>, url = URL_, token = TOKEN, ok = true) {
  return connectToCloud({
    url,
    token,
    machineId: "machine-1",
    sessions: true,
    introspect,
    verifyPolicy: async () => (ok ? { ok: true as const, policyCount: 1, deployment: 2 } : { ok: false as const, reason: "down" }),
    verifyIngest: async () => (ok ? { ok: true as const } : { ok: false as const, reason: "down" }),
  });
}

function seedJev(obj: unknown, mode = 0o600): string {
  const path = jevConfigFile();
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj), { mode });
  chmodSync(path, mode);
  return readFileSync(path, "utf8");
}

describe("connecting with a key that carries jev:evaluate", () => {
  it("stores the key under the verified origin and turns Jev on in shadow mode", async () => {
    const outcome = await connect(withPermissions(...MACHINE_PRESET));
    expect(outcome.jev?.ok).toBe(true);
    expect(outcome.jev?.config?.status).toBe("written");

    expect(readCredentials().jev).toEqual({ url: URL_, key: TOKEN });
    const onDisk = JSON.parse(readFileSync(jevConfigFile(), "utf8"));
    expect(onDisk).toEqual({ provider: "failproofai", baseUrl: `${URL_}/enforcement/v1/jev`, mode: "shadow" });
    // No key in jev.json: the Cloud key has one home.
    expect(readFileSync(jevConfigFile(), "utf8")).not.toContain(TOKEN);
    if (posix) {
      expect(statSync(jevConfigFile()).mode & 0o777).toBe(0o600);
      expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o022).toBe(0);
    }

    // What the hooks will now read.
    const cfg = loadJevConfig();
    expect(cfg).toMatchObject({ provider: "failproofai", apiKey: TOKEN, mode: "shadow" });
    const r = inspectJevConfig();
    expect(r.status === "ok" && r.keySource).toBe("cloud");

    const text = describeOutcome(outcome, "machine-1", URL_).join("\n");
    expect(text).toMatch(/Jev\s+on through FailproofAI Cloud, in shadow mode/);
    expect(text).toContain("--mode enforce");
    expect(text).not.toContain(TOKEN);
    expect(configuredPaths(outcome)).toContain(credentialsFile());
  });

  it("puts the Jev route under a self-hosted Cloud's path prefix, and the credential on its origin", async () => {
    const outcome = await connect(withPermissions(...MACHINE_PRESET), "http://localhost:8080/fp");
    expect(readCredentials().jev?.url).toBe("http://localhost:8080");
    expect(JSON.parse(readFileSync(jevConfigFile(), "utf8")).baseUrl).toBe("http://localhost:8080/fp/enforcement/v1/jev");
    // Plain http to loopback is fine in the shadow mode connect writes.
    expect(loadJevConfig()?.baseUrl).toBe("http://localhost:8080/fp/enforcement/v1/jev");
    // …and only there: `jev setup --mode enforce` (and the dashboard switch)
    // refuses plain http, so the output must not name it as the next step.
    const text = describeOutcome(outcome, "machine-1", "http://localhost:8080/fp").join("\n");
    expect(text).toMatch(/Jev\s+on through FailproofAI Cloud, in shadow mode/);
    expect(text).not.toContain("--mode enforce");
    expect(text).toContain("Enforce needs an https FailproofAI Cloud URL");
    // The command it would have named really is refused, and the refusal names the step that works.
    const enforce = validateJevConfig({ ...JSON.parse(readFileSync(jevConfigFile(), "utf8")), mode: "enforce" }, null, { url: "http://localhost:8080", key: TOKEN });
    expect(enforce.ok).toBe(false);
    expect(!enforce.ok && enforce.problem).toContain("Reconnect to an https FailproofAI Cloud URL");
  });

  it("never overwrites a BYOK jev.json, and says so in one line", async () => {
    const before = seedJev({ provider: "typesafe", apiKey: BYOK_KEY, mode: "enforce" });
    const outcome = await connect(withPermissions(...MACHINE_PRESET));
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
    expect(outcome.jev?.config).toMatchObject({ status: "kept", provider: "typesafe" });
    // The key is stored all the same, for whenever the owner switches.
    expect(readCredentials().jev?.key).toBe(TOKEN);
    // And BYOK keeps being what runs.
    expect(loadJevConfig()?.apiKey).toBe(BYOK_KEY);
    const jevLines = describeOutcome(outcome, "machine-1", URL_).filter((l) => l.includes("Jev"));
    expect(jevLines).toHaveLength(1);
    expect(jevLines[0]).toContain("left as configured");
    expect(describeOutcome(outcome, "machine-1", URL_).join("\n")).not.toContain(BYOK_KEY);
  });

  it("never overwrites a Cloud jev.json either — not even one switched off or to enforce", async () => {
    for (const mode of ["off", "enforce"]) {
      const before = seedJev({ provider: "failproofai", baseUrl: `${URL_}/enforcement/v1/jev`, mode });
      await connect(withPermissions(...MACHINE_PRESET));
      expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
    }
  });

  it("never overwrites a file it cannot even read, and says Jev is off because of it", async () => {
    const before = seedJev("{ this is not json");
    const outcome = await connect(withPermissions(...MACHINE_PRESET));
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
    expect(outcome.jev?.config?.status).toBe("kept");
    // Someone who just minted a machine key must not come away thinking Jev is on.
    const text = describeOutcome(outcome, "machine-1", URL_).join("\n");
    expect(text).toContain("left as configured");
    expect(text).toMatch(/refused/);
    expect(text).toContain("Jev is off");
  });

  it("says a kept Cloud jev.json switched off leaves Jev off, and how to turn it on", async () => {
    seedJev({ provider: "failproofai", baseUrl: `${URL_}/enforcement/v1/jev`, mode: "off" });
    const outcome = await connect(withPermissions(...MACHINE_PRESET));
    const text = describeOutcome(outcome, "machine-1", URL_).join("\n");
    expect(text).toContain("switched off");
    expect(text).toContain("jev setup --mode shadow");
  });

  it("names the other origin when the Cloud jev.json on disk points somewhere else", async () => {
    seedJev({ provider: "failproofai", baseUrl: "https://staging.befailproof.ai/enforcement/v1/jev", mode: "shadow" });
    const outcome = await connect(withPermissions(...MACHINE_PRESET));
    expect(outcome.jev?.config).toMatchObject({ status: "kept", otherOrigin: "https://staging.befailproof.ai" });
    const text = describeOutcome(outcome, "machine-1", URL_).join("\n");
    expect(text).toContain("https://staging.befailproof.ai");
    expect(text).toContain("jev setup --provider failproofai");
    // The origins disagree, so Jev is off rather than sending the key there.
    expect(loadJevConfig()).toBeNull();
  });

  it("the no-clobber write loses to a file that appears first", () => {
    const before = seedJev({ provider: "custom", apiKey: BYOK_KEY, baseUrl: "https://proxy.example.com/v1" });
    expect(writeCloudJevConfigIfAbsent(URL_).status).toBe("kept");
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
    // And leaves no temp file behind.
    const leftovers = readdirTmp();
    expect(leftovers).toEqual([]);
  });
});

describe("connecting with --no-transcripts (sessions !== true)", () => {
  const decisionsOnly = (sessions: boolean | undefined = false) =>
    connectToCloud({
      url: URL_,
      token: TOKEN,
      machineId: "machine-1",
      sessions,
      introspect: withPermissions(...MACHINE_PRESET),
      verifyPolicy: async () => ({ ok: true as const, policyCount: 1, deployment: 2 }),
      verifyIngest: async () => ({ ok: true as const }),
    });

  it("stores the Jev key but never switches Jev on, and says how to, in one line", async () => {
    for (const sessions of [false, undefined]) {
      rmSync(jevConfigFile(), { force: true });
      const outcome = await decisionsOnly(sessions);
      expect(outcome.jev).toEqual({ ok: true, optIn: true });
      // The key is where `jev setup --provider failproofai` will find it…
      expect(readCredentials().jev).toEqual({ url: URL_, key: TOKEN });
      // …and no jev.json, so the hooks run exactly what they ran before.
      expect(existsSync(jevConfigFile())).toBe(false);
      expect(inspectJevConfig().status).toBe("absent");
      expect(loadJevConfig()).toBeNull();

      const lines = describeOutcome(outcome, "machine-1", URL_);
      const jevLines = lines.filter((l) => l.includes("Jev"));
      expect(jevLines).toHaveLength(1);
      expect(jevLines[0]).toContain("available on this key");
      expect(jevLines[0]).toContain("each checked tool call and the recent prompt to FailproofAI Cloud");
      expect(jevLines[0]).toContain("`failproofai jev setup --provider failproofai`");
      const text = lines.join("\n");
      expect(text).not.toMatch(/Jev\s+on\b/);
      expect(text).not.toContain("shadow mode");
      expect(text).not.toContain(TOKEN);
      // The key file is named in the closing note: a key WAS stored.
      expect(configuredPaths(outcome)).toContain(credentialsFile());
    }
  });

  it("an existing jev.json is still reported as it is, and still never touched", async () => {
    const before = seedJev({ provider: "typesafe", apiKey: BYOK_KEY, mode: "enforce" });
    const outcome = await decisionsOnly();
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
    expect(outcome.jev).toMatchObject({ ok: true, config: { status: "kept", provider: "typesafe" } });
    const text = describeOutcome(outcome, "machine-1", URL_).join("\n");
    expect(text).toContain("left as configured");
    expect(text).not.toContain("available on this key");
  });

  it("a Cloud jev.json already on (shadow or enforce) is left alone — and the output says Jev still sends, and how to stop it", async () => {
    for (const mode of ["shadow", "enforce"] as const) {
      const before = seedJev({ provider: "failproofai", baseUrl: `${URL_}/enforcement/v1/jev`, mode });
      const outcome = await decisionsOnly();
      // Never overwritten (decision 16, invariant 7)…
      expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
      expect(outcome.jev).toMatchObject({ ok: true, config: { status: "kept", provider: "failproofai" }, stillOn: mode });
      // …and still what the hooks run.
      expect(loadJevConfig()).toMatchObject({ provider: "failproofai", mode });

      const text = describeOutcome(outcome, "machine-1", URL_).join("\n");
      expect(text).toContain("left as configured");
      expect(text).toContain(`Jev is still on through FailproofAI Cloud (${mode} mode)`);
      expect(text).toContain("each checked tool call and the recent prompt to FailproofAI Cloud");
      expect(text).toContain("`failproofai jev setup --mode off`");
      expect(text).not.toContain(TOKEN);
    }
  });

  it("…the same line on the --connect path, above \"Decisions only.\"", async () => {
    seedJev({ provider: "failproofai", baseUrl: `${URL_}/enforcement/v1/jev`, mode: "shadow" });
    const r = await runConnectCommand({
      url: URL_,
      token: TOKEN,
      machineId: "machine-1",
      sessions: false,
      introspect: withPermissions(...MACHINE_PRESET),
      verify: async () => ({ ok: true as const, policyCount: 1, deployment: 2 }),
      verifyIngest: async () => ({ ok: true as const }),
      daemonStatus: () => "running",
    });
    const text = r.lines.join("\n");
    expect(text).toContain("Jev is still on through FailproofAI Cloud (shadow mode)");
    expect(text).toContain("Decisions only.");
    expect(text.indexOf("still on through")).toBeLessThan(text.indexOf("Decisions only."));
  });

  it("no such line when the Cloud jev.json does not send: switched off, or pointing at another Cloud", async () => {
    for (const file of [
      { provider: "failproofai", baseUrl: `${URL_}/enforcement/v1/jev`, mode: "off" },
      { provider: "failproofai", baseUrl: "https://staging.befailproof.ai/enforcement/v1/jev", mode: "shadow" },
    ]) {
      seedJev(file);
      const outcome = await decisionsOnly();
      expect(outcome.jev?.stillOn).toBeUndefined();
      expect(loadJevConfig()).toBeNull();
      expect(describeOutcome(outcome, "machine-1", URL_).join("\n")).not.toContain("still on");
    }
  });

  it("the --connect path prints no \"Jev on\" either", async () => {
    const r = await runConnectCommand({
      url: URL_,
      token: TOKEN,
      machineId: "machine-1",
      sessions: false,
      introspect: withPermissions(...MACHINE_PRESET),
      verify: async () => ({ ok: true as const, policyCount: 1, deployment: 2 }),
      verifyIngest: async () => ({ ok: true as const }),
      daemonStatus: () => "running",
    });
    expect(r.exitCode).toBe(0);
    const text = r.lines.join("\n");
    expect(text).toContain("available on this key");
    expect(text).toContain("Session transcripts are NOT being sent");
    expect(text).not.toMatch(/Jev\s+on\b/);
    expect(existsSync(jevConfigFile())).toBe(false);
  });

  it("opting in afterwards is the one command it names", async () => {
    await decisionsOnly();
    const { runJevCommand } = await import("../../src/hooks/jev-cli");
    const r = await runJevCommand(["setup", "--provider", "failproofai"], { render: { cols: 120, color: false } });
    expect(r.exitCode).toBe(0);
    expect(loadJevConfig()).toMatchObject({ provider: "failproofai", apiKey: TOKEN, mode: "shadow" });
  });
});

function readdirTmp(): string[] {
  return readdirSync(home).filter((n) => n.endsWith(".tmp"));
}

describe("connecting with a key that does not carry jev:evaluate", () => {
  it("writes no Jev state at all", async () => {
    const outcome = await connect(withPermissions("events:add", "policies:pull"));
    expect(outcome.jev).toEqual({ ok: false, reason: expect.stringContaining("jev:evaluate") });
    expect(readCredentials().jev).toBeUndefined();
    expect(existsSync(jevConfigFile())).toBe(false);
    const text = describeOutcome(outcome, "machine-1", URL_).join("\n");
    expect(text).toMatch(/Jev\s+not through FailproofAI Cloud/);
  });

  it("drops the Jev key an earlier connection stored: the new connection replaces it", async () => {
    writeJevCloudCredential({ url: URL_, key: OLD_TOKEN });
    seedJev({ provider: "failproofai", baseUrl: `${URL_}/enforcement/v1/jev`, mode: "enforce" });
    await connect(withPermissions("events:add", "policies:pull"));
    expect(readCredentials().jev).toBeUndefined();
    expect(JSON.stringify(readCredentials())).not.toContain(OLD_TOKEN);
    // The Cloud file stays (connect never rewrites jev.json) and reads off —
    // as a connected machine whose key has no Jev, never as "not connected".
    expect(inspectJevConfig().status).toBe("key-lacks-jev");
    expect(loadJevConfig()).toBeNull();
  });

  it("writes nothing for Jev when the server cannot say what the key carries", async () => {
    const outcome = await connect(introspecting({ kind: "unsupported" }));
    expect(outcome.anyConfigured).toBe(true);
    expect(outcome.jev).toBeUndefined();
    expect(readCredentials().jev).toBeUndefined();
    expect(existsSync(jevConfigFile())).toBe(false);
  });

  it("is not switched off by a reconnect whose introspect failed (HTTP 502)", async () => {
    await connect(withPermissions(...MACHINE_PRESET));
    expect(inspectJevConfig().status).toBe("ok");
    const jevBefore = readFileSync(jevConfigFile(), "utf8");

    // The real introspect client, against a server whose introspect answers 502.
    const answering502 = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const outcome = await connect((origin: string, token: string) => introspectKey(origin, token, answering502));
    expect(outcome.anyConfigured).toBe(true);
    expect(outcome.jev).toEqual({ ok: false, unconfirmed: "kept" });

    // Left exactly as it was: the slot, the file, and what the hooks read.
    expect(readCredentials().jev).toEqual({ url: URL_, key: TOKEN });
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(jevBefore);
    expect(inspectJevConfig().status).toBe("ok");
    expect(loadJevConfig()).toMatchObject({ provider: "failproofai", apiKey: TOKEN });
    const status = await runJevCommand(["status", "--json"], { render: { cols: 120, color: false } });
    expect(JSON.parse(status.json as string)).toMatchObject({ status: "ok", provider: "failproofai" });

    const jevLines = describeOutcome(outcome, "machine-1", URL_).filter((l) => l.includes("Jev"));
    expect(jevLines).toHaveLength(1);
    expect(jevLines[0]).toContain("could not confirm the key's Jev permission; left as it was.");
  });

  it("an unanswered introspect never lends the NEW connection a previous key's Jev slot", async () => {
    await connect(withPermissions(...MACHINE_PRESET), URL_, OLD_TOKEN);
    expect(readCredentials().jev?.key).toBe(OLD_TOKEN);
    const outcome = await connect(introspecting({ kind: "unreachable", reason: "the server answered 502" }));
    expect(outcome.jev).toEqual({ ok: false, unconfirmed: "cleared" });
    expect(readCredentials().jev).toBeUndefined();
    expect(JSON.stringify(readCredentials())).not.toContain(OLD_TOKEN);
    // Connected with the new key, which is not known to carry Jev: said so.
    expect(inspectJevConfig().status).toBe("key-lacks-jev");
    const text = describeOutcome(outcome, "machine-1", URL_).join("\n");
    expect(text).toContain("could not confirm this key's Jev permission");
    expect(text).toContain("config --token <key>");
    expect(text).not.toContain(OLD_TOKEN);
    // Nothing on disk says whether this key carries Jev, so status must not
    // claim it does not: re-running the same connect is the fix.
    const status = (await runJevCommand(["status"], { render: { cols: 120, color: false } })).lines.join("\n");
    expect(status).not.toContain("does not carry");
    expect(status).toContain("config --token <key>");
  });

  it("an unanswered introspect with no Jev slot says so and writes nothing for Jev", async () => {
    const outcome = await connect(introspecting({ kind: "unreachable", reason: "timeout" }));
    expect(outcome.jev).toEqual({ ok: false, unconfirmed: "none" });
    expect(readCredentials().jev).toBeUndefined();
    expect(existsSync(jevConfigFile())).toBe(false);
    expect(describeOutcome(outcome, "machine-1", URL_).join("\n")).toContain("could not confirm the key's Jev permission; left as it was.");
  });

  it("a server with no introspect keeps this key's own slot, and drops another key's", async () => {
    await connect(withPermissions(...MACHINE_PRESET));
    const kept = await connect(introspecting({ kind: "unsupported" }));
    expect(kept.jev).toEqual({ ok: false, unconfirmed: "kept" });
    expect(readCredentials().jev?.key).toBe(TOKEN);

    const other = await connect(introspecting({ kind: "unsupported" }), URL_, OLD_TOKEN);
    expect(other.jev).toEqual({ ok: false, unconfirmed: "cleared" });
    expect(readCredentials().jev).toBeUndefined();
  });

  it("writes nothing when nothing connected, whatever the key carries", async () => {
    const outcome = await connect(withPermissions(...MACHINE_PRESET), URL_, TOKEN, false);
    expect(outcome.anyConfigured).toBe(false);
    expect(outcome.jev).toBeUndefined();
    expect(readCredentials().jev).toBeUndefined();
    expect(existsSync(jevConfigFile())).toBe(false);
  });

  it("writes nothing for a key the server refused", async () => {
    await connect(introspecting({ kind: "rejected" }));
    expect(readCredentials().jev).toBeUndefined();
    expect(existsSync(jevConfigFile())).toBe(false);
  });
});

describe("disconnecting", () => {
  it("clears the Jev key and removes the Cloud's jev.json: Jev is off", async () => {
    await connect(withPermissions(...MACHINE_PRESET));
    expect(loadJevConfig()).not.toBeNull();
    const r = runDisconnectCommand();
    expect(r.exitCode).toBe(0);
    expect(readCredentials().jev).toBeUndefined();
    expect(existsSync(jevConfigFile())).toBe(false);
    expect(loadJevConfig()).toBeNull();
    expect(r.lines.join("\n")).toContain("Jev through FailproofAI Cloud is off");
    expect(r.lines.join("\n")).not.toContain(TOKEN);
  });

  it("keeps a BYOK jev.json exactly as it was, and says whose it is", async () => {
    const before = seedJev({ provider: "openrouter", apiKey: BYOK_KEY, mode: "shadow" });
    await connect(withPermissions(...MACHINE_PRESET));
    const r = runDisconnectCommand();
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
    expect(readCredentials().jev).toBeUndefined();
    expect(loadJevConfig()?.apiKey).toBe(BYOK_KEY);
    const text = r.lines.join("\n");
    expect(text).toContain("provider openrouter");
    expect(text).toContain("left in place");
    expect(text).not.toContain(BYOK_KEY);
  });

  // `--mode off` is "the switch that lasts" (jev-cloud.mdx): deleting it here
  // made the next connect write a fresh shadow file, and Jev came back on.
  it("keeps a Cloud jev.json switched off, so reconnecting leaves Jev off", async () => {
    await connect(withPermissions(...MACHINE_PRESET));
    const before = seedJev({ provider: "failproofai", baseUrl: `${URL_}/enforcement/v1/jev`, mode: "off" });
    const r = runDisconnectCommand();
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
    expect(readCredentials().jev).toBeUndefined();
    expect(r.lines.join("\n")).toContain("stays switched off");
    await connect(withPermissions(...MACHINE_PRESET));
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
  });

  it("keeps a jev.json it cannot read", async () => {
    const before = seedJev("not json at all");
    runDisconnectCommand();
    expect(readFileSync(jevConfigFile(), "utf8")).toBe(before);
  });

  it("removes a Cloud jev.json even with no key left to clear", () => {
    mkdirSync(home, { recursive: true });
    seedJev({ provider: "failproofai", baseUrl: `${URL_}/enforcement/v1/jev`, mode: "shadow" });
    const r = runDisconnectCommand();
    expect(existsSync(jevConfigFile())).toBe(false);
    expect(r.lines[0]).toBe("Disconnected from FailproofAI Cloud.");
  });

  it("on a machine with nothing to disconnect, says so as before", () => {
    const r = runDisconnectCommand();
    expect(r.lines).toEqual(["This machine is not connected to FailproofAI Cloud."]);
  });
});
