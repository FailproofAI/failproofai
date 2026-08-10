import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  runConnectCommand,
  runDisconnectCommand,
  runRenameCommand,
  describeMachine,
  connectionStatusLines,
} from "../../src/hooks/cloud-enrollment-cli";
import { cloudCredentialPath, readCloudCredentials, writeCloudCredentials } from "../../src/hooks/cloud-enrollment";
import { readIngestCredential } from "../../src/hooks/collector-config";
import { readConfig } from "../../src/hooks/fp-config";

let dir: string;
let realHome: string | undefined;
const ok = vi.fn(async () => ({ ok: true as const, policyCount: 3, deployment: 12 }));
const ingestOk = vi.fn(async () => ({ ok: true as const }));
// A key carrying both permissions, so the capability gating is transparent here
// and each test exercises whatever `verify`/`verifyIngest` it injected. Reports
// no org, which keeps these assertions about the connect flow rather than about
// the org line — `cloud-connect-permissions.test.ts` covers the org and the
// permission gating on their own.
const introspectOk = vi.fn(async () => ({
  kind: "ok" as const,
  identity: { permissions: ["events:add", "policies:pull"] },
}));

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
  introspectOk.mockClear();
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
  introspect: introspectOk,
  daemonStatus: () => "running" as const,
};

describe("--connect", () => {
  it("verifies before writing, and reports what is assigned", async () => {
    const r = await runConnectCommand({ ...base, machineId: "m-1", machineLabel: "lab-1" });
    expect(r.exitCode).toBe(0);
    // The label is the human name; the explicit id is shown in parentheses.
    expect(r.lines.join("\n")).toMatch(/Connected to https:\/\/be\.failproof\.ai as lab-1 \(m-1\)/);
    expect(r.lines.join("\n")).toMatch(/3 policies assigned \(deployment 12\)/);
    expect(readCloudCredentials()).toEqual({
      url: base.url,
      machineId: "m-1",
      token: base.token,
      machineLabel: "lab-1",
    });
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

  it("takes the host name as the label and mints a stable id, not the host name", async () => {
    // The silent-merge fix: two hosts both named "my-laptop" must not collapse
    // into one machine, so the hostname becomes the label and the id is minted.
    await runConnectCommand({ ...base, defaultMachineId: "my-laptop" });
    const creds = readCloudCredentials();
    expect(creds?.machineLabel).toBe("my-laptop");
    expect(creds?.machineId).not.toBe("my-laptop");
    expect(creds?.machineId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("reuses an already-enrolled machine id instead of minting a new one", async () => {
    // Re-running --connect must be idempotent: the machine keeps its identity.
    await runConnectCommand({ ...base, defaultMachineId: "host-a" });
    const first = readCloudCredentials()?.machineId;
    await runConnectCommand({ ...base, defaultMachineId: "host-a" });
    expect(readCloudCredentials()?.machineId).toBe(first);
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

  it("does NOT claim a daemon runs outside the service manager when the state is unreadable", async () => {
    // macOS: a LaunchDaemon is in launchd's system domain, so reading its state
    // needs elevation. Without a cached `sudo -n` credential — the normal case for
    // a read-only status command — `daemonServiceStatus()` returns "unknown",
    // meaning "I could not tell".
    //
    // That used to fall through to the socket branch and announce the daemon was
    // "running outside the service manager", telling the user to install a service
    // they already had. Linux never showed it, because `systemctl is-active` needs
    // no privileges — and that asymmetry was the entire bug.
    const r = await runConnectCommand({ ...base, machineId: "m", daemonStatus: () => "unknown" as const });

    const out = r.lines.join("\n");
    expect(r.exitCode).toBe(0);
    expect(out).not.toMatch(/outside the service manager/);
    expect(out).not.toMatch(/Install it as a service/);
    // And it says what IS true: the state could not be read.
    expect(out).toMatch(/needs elevation to read/);
  });
});

describe("--machine-label alone renames without re-enrolling", () => {
  // The flag was accepted only with --connect, so changing a display name meant
  // re-running enrolment with the url and token again. The hostname default is a
  // suggestion, so renaming is the expected path rather than an exception.

  it("stores the new label and reports the change", async () => {
    writeCloudCredentials({ url: "https://x", machineId: "abcd1234-ffff", token: "t", machineLabel: "old-name" });

    const r = await runRenameCommand("Nikita's Mac", { verify: async () => ({ ok: true }) });

    expect(r.exitCode).toBe(0);
    expect(readCloudCredentials()?.machineLabel).toBe("Nikita's Mac");
    expect(r.lines.join("\n")).toContain("old-name");
    expect(r.lines.join("\n")).toContain("Nikita's Mac");
  });

  it("keeps the rename when the server cannot be reached", async () => {
    // Refusing to rename because the network is down would fail exactly when
    // someone is labelling a machine they are debugging. The daemon sends the
    // label on its next poll, so the dashboard catches up by itself.
    writeCloudCredentials({ url: "https://x", machineId: "abcd1234-ffff", token: "t" });

    const r = await runRenameCommand("Build box", {
      verify: async () => ({ ok: false, reason: "No response from https://x within 5s." }),
    });

    expect(r.exitCode).toBe(0);
    expect(readCloudCredentials()?.machineLabel).toBe("Build box");
    expect(r.lines.join("\n")).toMatch(/stored but .* could not be told/);
  });

  it("refuses when the machine is not connected", async () => {
    const r = await runRenameCommand("Anything", { verify: async () => ({ ok: true }) });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("not connected");
  });

  it("needs a name", async () => {
    writeCloudCredentials({ url: "https://x", machineId: "m", token: "t" });
    const r = await runRenameCommand("   ", { verify: async () => ({ ok: true }) });
    expect(r.exitCode).toBe(1);
  });
});

describe("machine names in output", () => {
  it("shows the label with a SHORT id, not the whole uuid", () => {
    // 36 characters of uuid in every status line is noise for the one reader who
    // cannot use them, and it made the id look like the machine's name.
    const shown = describeMachine("dde01f39-afba-40eb-bf1a-815d9f17ac2d", "Mac.localdomain");
    expect(shown).toBe("Mac.localdomain (dde01f39)");
  });

  it("keeps the full id when asked", () => {
    const shown = describeMachine("dde01f39-afba-40eb-bf1a-815d9f17ac2d", "Mac.localdomain", true);
    expect(shown).toBe("Mac.localdomain (dde01f39-afba-40eb-bf1a-815d9f17ac2d)");
  });

  it("falls back to the bare id when there is no label", () => {
    // Credentials written before labels existed, and the case where the label IS
    // the id — printing it twice would be worse than printing it once.
    expect(describeMachine("m-1")).toBe("m-1");
    expect(describeMachine("m-1", "m-1")).toBe("m-1");
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
      url: "https://be.failproof.ai/v1/events",
      key: "a-machine-token",
    });
    // The ingest endpoint is DERIVED, never asked for separately.
    expect(ingestOk).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://be.failproof.ai/v1/events" }),
    );
  });

  it("sends transcripts by default, and says so at the moment it takes effect", async () => {
    // Transcripts are what makes a dashboard worth connecting to, so they are
    // the default rather than an opt-in nobody discovers. A default that ships
    // prompts and file contents has to be DISCLOSED where it takes effect —
    // not left in --help — which is what the message assertion pins.
    const r = await runConnectCommand({ ...base, machineId: "m-1", sessions: true });
    expect(readConfig().collector).toMatchObject({ hooks: true, sessions: true });
    const out = r.lines.join("\n");
    expect(out).toMatch(/full session transcripts/i);
    expect(out).toMatch(/prompts, file/i);
    expect(out).toMatch(/--no-transcripts/);
  });

  it("honours the explicit opt-out, and says THAT too", async () => {
    // Stated on both branches, never only on the surprising one: somebody who
    // opted out should be able to confirm it took, without reading a config file.
    const r = await runConnectCommand({ ...base, machineId: "m-1", sessions: false });
    expect(readConfig().collector).toMatchObject({ hooks: true, sessions: false });
    expect(r.lines.join("\n")).toMatch(/transcripts are NOT being sent/i);
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
    // Pasted as the unversioned path, stored as the versioned one: the base is
    // what we keep, and the ingest path is derived from it, not echoed back.
    expect(readIngestCredential()?.url).toBe("https://be.failproof.ai/v1/events");
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
    expect(r.lines.join("\n")).toMatch(/No new hook activity or transcripts will be queued/);
  });

  it("names the restart rather than claiming a running daemon already stopped", async () => {
    // It used to print "Hook activity and transcripts stop being sent", which
    // was not true yet: the collector manager starts once for the daemon's
    // lifetime (`main.rs`) and the uploader caches its bearer key at
    // construction, so a running failproofaid never notices the credential
    // file disappear. The claim only became true at the next daemon start.
    await runConnectCommand({ ...base, machineId: "m-1" });
    const text = runDisconnectCommand().lines.join("\n");
    expect(text).toMatch(/restart it to stop the current process/);
    expect(text).not.toMatch(/transcripts stop being sent/);
  });

  it("stops ENFORCING cloud-managed policies, not just refreshing them", async () => {
    // Clearing the credential ends polling. Every artifact already on disk
    // stayed referenced by active.json and kept being loaded on every tool
    // call, so a machine that had deliberately left its organisation went on
    // being governed by whatever deployment was current when it left.
    await runConnectCommand({ ...base, machineId: "m-1" });
    // A child of `policies/`: one directory holds every policy on the machine.
    const managedRoot = resolve(dir, "home", "policies", "cloud-policies");
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(
      resolve(managedRoot, "active.json"),
      JSON.stringify({ schemaVersion: 1, deployment: 4, policies: [] }),
    );

    runDisconnectCommand();

    expect(existsSync(resolve(managedRoot, "active.json"))).toBe(false);
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
