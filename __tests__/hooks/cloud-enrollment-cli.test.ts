import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runConnectCommand, runDisconnectCommand, connectionStatusLines } from "../../src/hooks/cloud-enrollment-cli";
import { cloudCredentialPath, readCloudCredentials, writeCloudCredentials } from "../../src/hooks/cloud-enrollment";

let dir: string;
const ok = vi.fn(async () => ({ ok: true as const, policyCount: 3, generation: 12 }));

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "fpai-enrollcli-"));
  process.env.FAILPROOFAI_CLOUD_CREDENTIALS = resolve(dir, "cloud.json");
  delete process.env.FAILPROOFAI_CLOUD_URL;
  ok.mockClear();
});

afterEach(() => {
  delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
  delete process.env.FAILPROOFAI_CLOUD_URL;
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  url: "https://be.failproof.ai",
  token: "a-machine-token",
  verify: ok,
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
