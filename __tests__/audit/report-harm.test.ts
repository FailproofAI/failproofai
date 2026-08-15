/**
 * The reporting side effect, and the property that matters most about it:
 * NOTHING here may break a scan.
 *
 * By the time `reportHarm` runs the scan has already completed and its result is
 * already on disk. A dead network, an expired session or an api-server having a
 * bad day must leave the local feature working and the local dashboard correct —
 * a person who never enabled emailed reports must not be able to tell this code
 * exists at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const { readConfigMock, getTokenMock, submitMock } = vi.hoisted(() => ({
  readConfigMock: vi.fn(),
  getTokenMock: vi.fn(),
  submitMock: vi.fn(),
}));

vi.mock("../../src/hooks/fp-config", () => ({ readConfig: readConfigMock }));
vi.mock("../../lib/auth/auth-store", () => ({ getValidAccessToken: getTokenMock }));
vi.mock("../../lib/auth/api-server-client", async (orig) => ({
  ...(await orig<typeof import("../../lib/auth/api-server-client")>()),
  submitAuditReport: submitMock,
}));

import { reportHarm, describeOutcome } from "../../src/audit/report-harm";
import { auditMachineFile } from "../../src/hooks/fp-home";
import type { AuditResult } from "../../src/audit/types";

let home: string;
let prevHome: string | undefined;

const SCANNED_AT = "2026-08-14T12:00:00.000Z";

function result(): AuditResult {
  return {
    version: 2,
    scannedAt: SCANNED_AT,
    scope: { cli: [], projects: "all", since: null },
    transcripts: { scanned: 1, skipped: 0, errors: 0, durationMs: 1 },
    results: [
      {
        name: "failproofai/block-rm-rf",
        source: "builtin",
        category: "Dangerous Commands",
        severity: "deny",
        hits: 4,
        projects: 1,
        firstSeen: SCANNED_AT,
        lastSeen: SCANNED_AT,
        examples: [
          { sessionId: "s", cwd: "/home/x", timestamp: SCANNED_AT, example: "rm -rf /home/x/y/z" },
        ],
        displayTitle: "Ran rm -rf",
        impact: "",
        enabledInConfig: false,
        installHint: "",
      },
    ],
    totals: { hits: 4, projectsWithHits: 1 },
    projectsScanned: [],
    eventsScanned: 10,
    enabledBuiltinNames: [],
  };
}

function enableEmail(on: boolean) {
  // ONE switch — `auto` means "scan on a timer AND tell me" — plus the consent
  // stamp that says the person who set it was shown what "tell me" sends. Both
  // are written by the same call in every opt-in path, so a machine with `auto`
  // and no stamp is specifically one that inherited the key from a release
  // where it meant "scan locally", and `grandfatheredAuto()` below covers it.
  readConfigMock.mockReturnValue({
    audit: { auto: on, intervalDays: 7, reportsConsentedAt: on ? 1_700_000_000_000 : undefined },
  });
}

/** `auto` set under the OLD meaning: scheduled locally, never consented to send. */
function grandfatheredAuto() {
  readConfigMock.mockReturnValue({
    audit: { auto: true, intervalDays: 7, reportsConsentedAt: undefined },
  });
}

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-report-"));
  process.env.FAILPROOFAI_HOME = home;
  readConfigMock.mockReset();
  getTokenMock.mockReset();
  submitMock.mockReset();
  enableEmail(true);
  getTokenMock.mockResolvedValue({ access_token: "at", user: { id: "u", email: "a@b.c" } });
  submitMock.mockResolvedValue({
    report_id: "r1",
    emailed: true,
    reason: null,
    next_window_from: SCANNED_AT,
  });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("reportHarm — the opt-in", () => {
  it("does nothing at all when scheduled audits are off", async () => {
    // The majority case. No token read, no machine id minted, no request.
    enableEmail(false);
    expect(await reportHarm(result())).toEqual({ kind: "disabled" });
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(existsSync(auditMachineFile())).toBe(false);
  });

  it("treats an unreadable config as off — the direction that sends nothing", async () => {
    readConfigMock.mockImplementation(() => {
      throw new Error("corrupt");
    });
    expect(await reportHarm(result())).toEqual({ kind: "disabled" });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("sends NOTHING for a machine that set `auto` before it meant sending", async () => {
    // The upgrade case, and the whole reason the consent stamp exists. Through
    // 1.0.0 `auto` meant "scan this machine locally on a timer": it needed no
    // account, the server action that wrote it had no auth check, and the
    // toggle's own copy said nothing leaves the machine. Reading that stored
    // bit as consent to upload transcript excerpts would have mailed a digest
    // from every such machine on its first scheduled run after the upgrade,
    // with the only notice a line in the systemd journal.
    grandfatheredAuto();
    expect(await reportHarm(result())).toEqual({ kind: "consent-required" });
    expect(submitMock).not.toHaveBeenCalled();
    // Not even a token is read: the decision is made before anything touches
    // the session, so this cannot depend on whether one happens to be present.
    expect(getTokenMock).not.toHaveBeenCalled();
    // And no machine identity is minted, so the machine stays unregistered.
    expect(existsSync(auditMachineFile())).toBe(false);
  });

  it("sends once the same machine opts in again", async () => {
    // The other half: consent-required is a pause, not a dead end. The CLI and
    // the settings toggle both stamp `reportsConsentedAt` in the same write
    // that sets `auto`, and that is all this needs to resume.
    enableEmail(true);
    expect((await reportHarm(result())).kind).toBe("sent");
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it("reports signed-out rather than failing when there is no session", async () => {
    // An expired or revoked token. The scan already succeeded and its result is
    // on the dashboard; only the email is lost, and the remedy needs a human.
    getTokenMock.mockResolvedValue(null);
    expect(await reportHarm(result())).toEqual({ kind: "signed-out" });
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe("reportHarm — the request", () => {
  it("sends a redacted payload and never the destination address", async () => {
    await reportHarm(result());
    const [token, body] = submitMock.mock.calls[0];
    expect(token).toBe("at");
    expect(body.machine_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.window_to).toBe(SCANNED_AT);
    expect(body.harmful[0].policy).toBe("block-rm-rf");
    // Redaction reached the wire.
    expect(body.harmful[0].examples[0]).toContain("/…/z");
    // The api-server takes the address from the token claims, so a report can
    // never name where its own digest goes.
    expect(JSON.stringify(body)).not.toContain("a@b.c");
  });

  it("mints the machine id once and reuses it", async () => {
    await reportHarm(result());
    const first = JSON.parse(readFileSync(auditMachineFile(), "utf8")).machine_id;
    await reportHarm(result());
    const second = JSON.parse(readFileSync(auditMachineFile(), "utf8")).machine_id;
    expect(second).toBe(first);
  });

  it("persists the server's watermark, not its own window", async () => {
    // The server anchors on the last DELIVERED digest. Computing this locally
    // would advance it past a held or failed digest and drop those findings.
    submitMock.mockResolvedValue({
      report_id: "r1",
      emailed: true,
      reason: null,
      next_window_from: "2026-08-13T00:00:00.000Z",
    });
    await reportHarm(result());
    expect(JSON.parse(readFileSync(auditMachineFile(), "utf8")).last_reported_at).toBe(
      "2026-08-13T00:00:00.000Z",
    );
  });

  it("persists the watermark even when nothing was mailed", async () => {
    // The server's answer already accounts for that — a held digest leaves the
    // watermark where it was. Writing it back is how this machine inherits that
    // decision instead of re-deriving it and getting it subtly wrong.
    submitMock.mockResolvedValue({
      report_id: "r1",
      emailed: false,
      reason: "cooldown",
      next_window_from: "2026-08-01T00:00:00.000Z",
    });
    const outcome = await reportHarm(result());
    expect(outcome).toEqual({ kind: "held", hits: 4, reason: "cooldown" });
    expect(JSON.parse(readFileSync(auditMachineFile(), "utf8")).last_reported_at).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  it("sends the window it last recorded", async () => {
    mkdirSync(resolve(home, "audit"), { recursive: true });
    writeFileSync(
      auditMachineFile(),
      JSON.stringify({ machine_id: "m-1", last_reported_at: "2026-08-07T00:00:00.000Z", created_at: SCANNED_AT }),
    );
    await reportHarm(result());
    expect(submitMock.mock.calls[0][1].window_from).toBe("2026-08-07T00:00:00.000Z");
  });
});

describe("reportHarm — failure never escapes", () => {
  it("returns an outcome instead of throwing when the request fails", async () => {
    submitMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const outcome = await reportHarm(result());
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.error).toContain("ECONNREFUSED");
  });

  it("survives a machine file that cannot be written", async () => {
    // A read-only home, or a full disk. The scan still succeeded.
    writeFileSync(resolve(home, "audit"), "not a directory");
    const outcome = await reportHarm(result());
    expect(outcome.kind).toBe("failed");
  });
});

describe("describeOutcome", () => {
  it("says nothing to the majority who never opted in", () => {
    expect(describeOutcome({ kind: "disabled" })).toBeNull();
  });

  it("tells a signed-out machine how to resume", () => {
    const line = describeOutcome({ kind: "signed-out" });
    expect(line).toContain("signed out");
    // Names the two surfaces that can actually fix it. It used to say "sign in
    // from the audit page" — which stopped being true when this release moved
    // that dialog behind "invite a friend".
    expect(line).toContain("--schedule");
    expect(line).toContain("/settings");
    expect(line).not.toContain("audit page");
  });

  it("tells a grandfathered machine how to turn digests on", () => {
    // Must be actionable, not just a refusal: this machine's owner asked for
    // scheduled scans and is still getting them, and the line is the only place
    // that says why no email arrived.
    const line = describeOutcome({ kind: "consent-required" });
    expect(line).toContain("--schedule");
    expect(line).toContain("/settings");
  });

  it("does not call a held digest an error", () => {
    // A machine below the threshold, or inside its cooldown, is working exactly
    // as intended. Calling that a failure trains people to ignore the line.
    const line = describeOutcome({ kind: "held", hits: 2, reason: "below_threshold" }) ?? "";
    // Matched against the MESSAGE, not the whole line — the brand name itself
    // contains "fail", which a naive /fail/i would happily flag.
    const message = line.replace(/^failproofai:\s*/, "");
    expect(message).not.toMatch(/error|fail|could not/i);
    expect(message).toContain("below_threshold");
  });

  it("pluralises findings", () => {
    expect(describeOutcome({ kind: "sent", hits: 1 })).toContain("1 finding)");
    expect(describeOutcome({ kind: "sent", hits: 3 })).toContain("3 findings)");
  });
});
