import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runConnectCommand, runDisconnectCommand, connectionStatusLines } from "../../src/hooks/cloud-enrollment-cli";
import { cloudCredentialPath, readCloudCredentials, writeCloudCredentials } from "../../src/hooks/cloud-enrollment";
import { readIngestCredential } from "../../src/hooks/collector-config";
import { readHooksConfig } from "../../src/hooks/hooks-config";

let dir: string;
let realHome: string | undefined;
const ok = vi.fn(async () => ({ ok: true as const, policyCount: 3, generation: 12 }));
const ingestOk = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "fpai-enrollcli-"));
  process.env.FAILPROOFAI_CLOUD_CREDENTIALS = resolve(dir, "cloud.json");
  process.env.FAILPROOFAI_HOME = resolve(dir, "home");
  // `--connect` now also writes the collector block, and that path resolves
  // through `homedir()` rather than FAILPROOFAI_HOME — so without this the
  // suite would edit the real `~/.failproofai/policies-config.json`.
  realHome = process.env.HOME;
  process.env.HOME = resolve(dir, "home");
  delete process.env.FAILPROOFAI_CLOUD_URL;
  ok.mockClear();
  ingestOk.mockClear();
});

afterEach(() => {
  delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
  delete process.env.FAILPROOFAI_HOME;
  delete process.env.FAILPROOFAI_CLOUD_URL;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  url: "https://be.failproof.ai",
  token: "a-machine-token",
  verify: ok,
  // Stubbed for the same reason `verify` is: a real call would reach the
  // network from a unit test.
  verifyIngest: ingestOk,
  daemonStatus: () => "running" as const,
};

describe("--connect", () => {
  it("verifies before writing, and reports what is assigned", async () => {
    const r = await runConnectCommand({ ...base, machineId: "m-1" });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toMatch(/Connected to https:\/\/be\.failproof\.ai as m-1/);
    expect(r.lines.join("\n")).toMatch(/3 policies assigned \(generation 12\)/);
    expect(readCloudCredentials()).toEqual({ url: base.url, machineId: "m-1", token: base.token });
  });

  it("writes NOTHING when verification fails", async () => {
    // A stored credential that does not work is worse than none — `--status`
    // would then claim a connection this machine does not have.
    const verify = vi.fn(async () => ({ ok: false as const, reason: "nope" }));
    const r = await runConnectCommand({ ...base, verify, machineId: "m-1" });
    expect(r.exitCode).toBe(1);
    expect(existsSync(cloudCredentialPath())).toBe(false);
  });

  it("never prints the token in full", async () => {
    const r = await runConnectCommand({ ...base, machineId: "m-1" });
    expect(r.lines.join("\n")).not.toContain("a-machine-token");
    expect(r.lines.join("\n")).toMatch(/\*\*\*\*oken/);
  });

  it("defaults the machine id to the host name", async () => {
    await runConnectCommand({ ...base, defaultMachineId: "my-laptop" });
    expect(readCloudCredentials()?.machineId).toBe("my-laptop");
  });

  it("refuses without a token, and says which key to make", async () => {
    const r = await runConnectCommand({ url: base.url, machineId: "m", verify: ok });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/policies:pull/);
    expect(ok).not.toHaveBeenCalled();
  });

  it("refuses plain http to a remote host before contacting anything", async () => {
    const r = await runConnectCommand({ ...base, url: "http://cloud.example.com", machineId: "m" });
    expect(r.exitCode).toBe(1);
    expect(ok).not.toHaveBeenCalled();
  });

  it("succeeds but warns loudly when no daemon is installed", async () => {
    // Enrolment is genuinely independent of the daemon — refusing would break
    // baking an image where the daemon lands later — but credentials alone
    // pull nothing, so it must not look finished.
    const r = await runConnectCommand({ ...base, machineId: "m", daemonStatus: () => "not-installed" as const });
    expect(r.exitCode).toBe(0);
    expect(readCloudCredentials()).not.toBeNull();
    expect(r.lines.join("\n")).toMatch(/not installed as a service, so nothing will be pulled/);
  });

  it("warns differently when the daemon is installed but stopped", async () => {
    const r = await runConnectCommand({ ...base, machineId: "m", daemonStatus: () => "stopped" as const });
    expect(r.lines.join("\n")).toMatch(/not running/);
  });
});

describe("--disconnect", () => {
  it("removes the credential and says what stops happening", () => {
    writeCloudCredentials({ url: "https://x", machineId: "m", token: "t" });
    const r = runDisconnectCommand();
    expect(r.exitCode).toBe(0);
    expect(existsSync(cloudCredentialPath())).toBe(false);
    expect(r.lines.join("\n")).toMatch(/Local\s+builtin, custom and convention policies are unaffected/);
  });

  it("is a no-op, not an error, when not connected", () => {
    const r = runDisconnectCommand();
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toMatch(/not connected/);
  });
});

describe("status", () => {
  it("says not connected when there is no credential", () => {
    expect(connectionStatusLines(() => "running").join("\n")).toMatch(/not connected/);
  });

  it("shows the endpoint and machine id, with the token masked", () => {
    writeCloudCredentials({ url: "https://be.failproof.ai", machineId: "m-9", token: "abcdefghijkl" });
    const out = connectionStatusLines(() => "running").join("\n");
    expect(out).toMatch(/connected to https:\/\/be\.failproof\.ai as m-9/);
    expect(out).toMatch(/\*\*\*\*ijkl/);
    expect(out).not.toContain("abcdefghijkl");
  });

  it("reports the environment when it is set, because env wins in the daemon", () => {
    // Showing the file here would describe a configuration that is not the one
    // in effect.
    writeCloudCredentials({ url: "https://from-file", machineId: "m", token: "t" });
    process.env.FAILPROOFAI_CLOUD_URL = "https://from-env";
    const out = connectionStatusLines(() => "running").join("\n");
    expect(out).toMatch(/configured by environment \(https:\/\/from-env\)/);
    expect(out).not.toMatch(/from-file/);
  });
});

describe("a daemon running outside the service manager", () => {
  it("does not claim nothing will be pulled when one is demonstrably running", async () => {
    // daemonServiceStatus() asks systemd/launchd only, so a hand-run daemon —
    // exactly what a developer testing locally has — read as absent and the
    // command told them policy was not being pulled while it was.
    const sockDir = mkdtempSync(resolve(tmpdir(), "fpai-sock-"));
    const sock = resolve(sockDir, "failproofaid.sock");
    writeFileSync(sock, "");
    process.env.FAILPROOFAI_DAEMON_SOCKET = sock;
    try {
      const r = await runConnectCommand({ ...base, machineId: "m", daemonStatus: () => "not-installed" as const });
      const out = r.lines.join("\n");
      expect(out).toMatch(/running outside the service manager/);
      expect(out).not.toMatch(/nothing will be pulled/);
      expect(out).toMatch(/survive reboot and logout/);
    } finally {
      delete process.env.FAILPROOFAI_DAEMON_SOCKET;
      rmSync(sockDir, { recursive: true, force: true });
    }
  });

  it("still warns plainly when there is no daemon at all", async () => {
    process.env.FAILPROOFAI_DAEMON_SOCKET = resolve(dir, "definitely-absent.sock");
    try {
      const r = await runConnectCommand({ ...base, machineId: "m", daemonStatus: () => "not-installed" as const });
      expect(r.lines.join("\n")).toMatch(/not installed as a service, so nothing will be pulled/);
    } finally {
      delete process.env.FAILPROOFAI_DAEMON_SOCKET;
    }
  });
});

// ---------------------------------------------------------------------------
// One connection, two capabilities
//
// Enrolment and collection each arrived with their own credential, URL and
// setup step. Connecting for policy then left the dashboard empty with nothing
// to suggest a second step existed.
// ---------------------------------------------------------------------------

describe("--connect configures policy AND the dashboard", () => {
  it("writes both credentials from one url and token", async () => {
    const r = await runConnectCommand({ ...base, machineId: "m-1" });
    expect(r.exitCode).toBe(0);
    expect(readCloudCredentials()).not.toBeNull();
    expect(readIngestCredential()).toEqual({
      url: "https://be.failproof.ai/events",
      key: "a-machine-token",
    });
    // The ingest endpoint is DERIVED, never asked for separately.
    expect(ingestOk).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://be.failproof.ai/events" }),
    );
  });

  it("does not send transcripts unless asked, and says so", async () => {
    // A transcript carries prompts, file contents and whatever was pasted into
    // a terminal. It can never be a side effect of connecting.
    const r = await runConnectCommand({ ...base, machineId: "m-1" });
    expect(readHooksConfig().collector).toMatchObject({ hooks: true, sessions: false });
    expect(r.lines.join("\n")).toMatch(/transcripts are NOT being sent/i);
  });

  it("sends transcripts when explicitly opted in", async () => {
    await runConnectCommand({ ...base, machineId: "m-1", sessions: true });
    expect(readHooksConfig().collector).toMatchObject({ sessions: true });
  });

  it("accepts the ingest endpoint too, rather than being pedantic about it", async () => {
    // People paste what the older prompt asked for, or what is already in
    // their ingest.json.
    const r = await runConnectCommand({
      ...base,
      url: "https://be.failproof.ai/events",
      machineId: "m-1",
    });
    expect(r.exitCode).toBe(0);
    expect(readCloudCredentials()?.url).toBe("https://be.failproof.ai");
    expect(readIngestCredential()?.url).toBe("https://be.failproof.ai/events");
  });
});

describe("a key that carries only one permission", () => {
  it("connects for policy and names why the dashboard is empty", async () => {
    const verifyIngest = vi.fn(async () => ({
      ok: false as const,
      reason: "the server rejected that key (403)",
    }));
    const r = await runConnectCommand({ ...base, verifyIngest, machineId: "m-1" });

    // Partial success, not failure: refusing to enrol for policy because the
    // dashboard would be empty protects nothing.
    expect(r.exitCode).toBe(0);
    expect(readCloudCredentials()).not.toBeNull();
    expect(readIngestCredential()).toBeNull();
    const out = r.lines.join("\n");
    expect(out).toMatch(/for policy only/);
    expect(out).toMatch(/403/);
    expect(out).toMatch(/events:add/);
  });

  it("connects for the dashboard and says policy will not arrive", async () => {
    const verify = vi.fn(async () => ({ ok: false as const, reason: "lacks policies:pull (403)" }));
    const r = await runConnectCommand({ ...base, verify, machineId: "m-1" });

    // Non-zero even though the dashboard IS configured: the exit code tracks
    // the primary purpose, so a provisioning script stops rather than treating
    // an unenrolled machine as done.
    expect(r.exitCode).toBe(1);
    expect(readCloudCredentials()).toBeNull();
    expect(readIngestCredential()).not.toBeNull();
    const out = r.lines.join("\n");
    expect(out).toMatch(/dashboard reporting only/);
    expect(out).toMatch(/will not receive centrally-managed/);
  });

  it("fails, writing nothing, when neither works", async () => {
    const verify = vi.fn(async () => ({ ok: false as const, reason: "bad token" }));
    const verifyIngest = vi.fn(async () => ({ ok: false as const, reason: "bad key" }));
    const r = await runConnectCommand({ ...base, verify, verifyIngest, machineId: "m-1" });
    expect(r.exitCode).toBe(1);
    expect(readCloudCredentials()).toBeNull();
    expect(readIngestCredential()).toBeNull();
  });

  it("reports BOTH reasons, so one fix does not just reveal the next", async () => {
    const verify = vi.fn(async () => ({ ok: false as const, reason: "bad token" }));
    const verifyIngest = vi.fn(async () => ({ ok: false as const, reason: "bad key" }));
    const r = await runConnectCommand({ ...base, verify, verifyIngest, machineId: "m-1" });
    expect(r.lines.join("\n")).toMatch(/bad token/);
    expect(r.lines.join("\n")).toMatch(/bad key/);
  });
});

describe("--disconnect means disconnect", () => {
  it("stops sending activity as well as pulling policy", async () => {
    // Clearing only the policy credential would leave the machine shipping to
    // a cloud the user believes they have left.
    await runConnectCommand({ ...base, machineId: "m-1" });
    expect(readIngestCredential()).not.toBeNull();

    const r = runDisconnectCommand();
    expect(r.exitCode).toBe(0);
    expect(readCloudCredentials()).toBeNull();
    expect(readIngestCredential()).toBeNull();
    expect(r.lines.join("\n")).toMatch(/stop being sent/);
  });
});

describe("status shows one connection with two capabilities", () => {
  it("flags a machine that pulls policy but reports nothing", async () => {
    const verifyIngest = vi.fn(async () => ({ ok: false as const, reason: "403" }));
    await runConnectCommand({ ...base, verifyIngest, machineId: "m-1" });
    const out = connectionStatusLines(() => "running").join("\n");
    expect(out).toMatch(/Dashboard NOT sending/);
    expect(out).toMatch(/--connect/);
  });

  it("flags a machine that reports but pulls no policy", async () => {
    const verify = vi.fn(async () => ({ ok: false as const, reason: "403" }));
    await runConnectCommand({ ...base, verify, machineId: "m-1" });
    const out = connectionStatusLines(() => "running").join("\n");
    expect(out).toMatch(/reporting only/);
    expect(out).toMatch(/Policy\s+NOT pulling/);
  });

  it("shows both when both are configured", async () => {
    await runConnectCommand({ ...base, machineId: "m-1" });
    const out = connectionStatusLines(() => "running").join("\n");
    expect(out).toMatch(/Policy\s+pulling/);
    expect(out).toMatch(/Dashboard sending hook activity/);
  });
});
