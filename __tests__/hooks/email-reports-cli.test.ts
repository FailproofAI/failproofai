// @vitest-environment node
/**
 * `failproofai config --email | --no-email`.
 *
 * The two properties worth pinning are refusals, not successes. An unenrolled
 * machine must FAIL — a silently-accepted opt-in that can never produce an
 * email is the bug that gets found six months later by someone who assumed it
 * was working — and it must store NOTHING, because an address on disk that can
 * never be used is a privacy cost bought with no benefit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readConfig,
  readCredentials,
  updateConfig,
  writeCredentials,
  writeVersionFile,
} from "../../src/hooks/fp-config";
import { configFile, credentialsFile } from "../../src/hooks/fp-home";
import {
  emailReportStatusLines,
  runEmailReportsOffCommand,
  runEmailReportsOnCommand,
} from "../../src/hooks/email-reports-cli";

let home: string;
let prevHome: string | undefined;
let prevAuthDir: string | undefined;

function enroll(): void {
  writeVersionFile({});
  writeCredentials({
    cloud: { url: "https://app.befailproof.ai", machineId: "machine-1", token: "fpai_secret" },
  });
  updateConfig({ mode: "cloud" });
}

function signIn(email = "chetan@example.com"): void {
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      access_token: "a",
      refresh_token: "r",
      access_expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id: "u1", email },
    }),
  );
}

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  prevAuthDir = process.env.FAILPROOFAI_AUTH_DIR;
  home = mkdtempSync(resolve(tmpdir(), "fpai-email-cli-"));
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_AUTH_DIR = home;
  delete process.env.FAILPROOFAI_CLOUD_URL;
  delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  if (prevAuthDir === undefined) delete process.env.FAILPROOFAI_AUTH_DIR;
  else process.env.FAILPROOFAI_AUTH_DIR = prevAuthDir;
  rmSync(home, { recursive: true, force: true });
});

describe("--email on a machine that cannot use it", () => {
  it("exits non-zero, points at --connect, and stores nothing", () => {
    signIn();
    const result = runEmailReportsOnCommand();
    expect(result.exitCode).not.toBe(0);
    expect(result.lines.join("\n")).toContain("--connect");
    expect(result.lines.join("\n")).toContain("open mail relay");

    expect(readConfig().email.reports).toBe(false);
    expect(readCredentials().email).toBeUndefined();
  });

  it("does not leave the address anywhere on disk", () => {
    signIn("someone@acme.test");
    runEmailReportsOnCommand();
    // Belt and braces: not just absent from the parsed struct, absent from the
    // bytes. This is the assertion that catches a partial write.
    for (const path of [configFile(), credentialsFile()]) {
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue; // never written at all — also fine
      }
      expect(text).not.toContain("someone@acme.test");
    }
  });

  it("exits non-zero and stores nothing when enrolled but not signed in", () => {
    enroll();
    const result = runEmailReportsOnCommand();
    expect(result.exitCode).not.toBe(0);
    expect(result.lines.join("\n")).toContain("failproofai auth login");
    expect(readConfig().email.reports).toBe(false);
    expect(readCredentials().email).toBeUndefined();
  });
});

describe("--email on a machine that can", () => {
  it("stores the boolean in config.toml and the address in credentials.toml", () => {
    enroll();
    signIn();
    const result = runEmailReportsOnCommand();
    expect(result.exitCode).toBe(0);

    expect(readConfig().email.reports).toBe(true);
    expect(readCredentials().email).toEqual({ verifiedFor: "chetan@example.com" });

    // The split is the point: config.toml lands 0664 under a normal umask, so
    // the address must not be in it.
    expect(readFileSync(configFile(), "utf8")).not.toContain("chetan@example.com");
    expect(readFileSync(credentialsFile(), "utf8")).toContain("chetan@example.com");
  });

  it("reuses the OTP-verified session rather than taking a second address", () => {
    enroll();
    signIn("verified@example.com");
    const result = runEmailReportsOnCommand();
    expect(result.lines.join("\n")).toContain("verified@example.com");
    expect(readCredentials().email?.verifiedFor).toBe("verified@example.com");
  });

  it("keeps the cloud credential it was merged into", () => {
    enroll();
    signIn();
    runEmailReportsOnCommand();
    expect(readCredentials().cloud?.token).toBe("fpai_secret");
  });

  it("warns when scheduled scanning is off, because nothing would ever be sent", () => {
    enroll();
    signIn();
    expect(readConfig().audit.auto).toBe(false);
    expect(runEmailReportsOnCommand().lines.join("\n")).toContain("Scheduled scanning is OFF");
  });
});

describe("--no-email", () => {
  it("clears the boolean and forgets the address", () => {
    enroll();
    signIn();
    runEmailReportsOnCommand();

    const result = runEmailReportsOffCommand();
    expect(result.exitCode).toBe(0);
    expect(readConfig().email.reports).toBe(false);
    expect(readCredentials().email).toBeUndefined();
    expect(readFileSync(credentialsFile(), "utf8")).not.toContain("chetan@example.com");
    // and does not revoke anything else
    expect(readCredentials().cloud?.token).toBe("fpai_secret");
  });

  it("succeeds when reports were never on", () => {
    const result = runEmailReportsOffCommand();
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("already off");
  });
});

describe("--status", () => {
  it("says email is unavailable on a local-only machine", () => {
    expect(emailReportStatusLines().join("\n")).toContain("email is unavailable");
  });

  it("offers the command on a connected machine that has not opted in", () => {
    enroll();
    expect(emailReportStatusLines().join("\n")).toContain("failproofai config --email");
  });

  it("names who opted in", () => {
    enroll();
    signIn();
    runEmailReportsOnCommand();
    expect(emailReportStatusLines().join("\n")).toContain("chetan@example.com");
  });

  it("flags a sign-in by somebody other than whoever opted in", () => {
    enroll();
    signIn("alice@example.com");
    runEmailReportsOnCommand();
    signIn("bob@example.com");
    const status = emailReportStatusLines().join("\n");
    expect(status).toContain("Signed in as bob@example.com");
    expect(status).toContain("alice@example.com");
  });

  it("flags an opt-in left behind by --disconnect", () => {
    enroll();
    signIn();
    runEmailReportsOnCommand();
    updateConfig({ mode: "oss" });
    expect(emailReportStatusLines().join("\n")).toContain("Not connected to Failproof Cloud");
  });
});
