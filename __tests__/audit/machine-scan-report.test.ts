// @vitest-environment node
/**
 * The three gates in front of the upload, and what happens when the cloud is
 * having a bad day.
 *
 * The gate worth staring at is `not-opted-in`. The server picks recipients from
 * org membership; it has no idea whether anyone on this machine consented. So
 * this local boolean is the ONLY thing standing between an enrolled fleet and
 * mail nobody asked for, and a test that merely checked "the request has the
 * right shape" would pass on a build that sent unconditionally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { updateConfig, writeCredentials, writeVersionFile } from "../../src/hooks/fp-config";
import {
  machineScanTarget,
  reportScanToCloud,
  SCAN_REPORT_TIMEOUT_MS,
} from "../../src/audit/machine-scan-report";
import { MACHINE_SCAN_PATH } from "../../src/audit/machine-scan-payload";
import type { AuditCount, AuditResult } from "../../src/audit/types";

let home: string;
let prevHome: string | undefined;

function harmfulRow(over: Partial<AuditCount> = {}): AuditCount {
  return {
    name: "failproofai/block-sudo",
    source: "builtin",
    category: "Dangerous Commands",
    severity: "deny",
    hits: 5,
    projects: 2,
    firstSeen: "2026-07-01T00:00:00.000Z",
    lastSeen: "2026-08-04T00:00:00.000Z",
    examples: [
      { sessionId: "s", cwd: "/home/chetan/secret-client", timestamp: "x", example: "sudo rm -rf /" },
    ],
    displayTitle: "",
    impact: "",
    enabledInConfig: false,
    installHint: "",
    ...over,
  };
}

function result(results: AuditCount[] = [harmfulRow()]): AuditResult {
  return {
    version: 2,
    scannedAt: new Date().toISOString(),
    scope: { cli: ["claude"], projects: "all", since: null },
    transcripts: { scanned: 10, skipped: 0, errors: 0, durationMs: 1000 },
    results,
    totals: { hits: 5, projectsWithHits: 2 },
    projectsScanned: ["/home/chetan/secret-client"],
    eventsScanned: 500,
    enabledBuiltinNames: [],
  };
}

/** An enrolled machine with a policy-pull credential. */
function enroll(): void {
  writeVersionFile({});
  writeCredentials({
    cloud: {
      url: "https://app.befailproof.ai",
      machineId: "machine-1",
      token: "fpai_secret",
      machineLabel: "laptop",
    },
  });
  updateConfig({ mode: "cloud" });
}

function optIn(): void {
  updateConfig({ email: { reports: true } });
}

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ emailQueued: true }), { status: 202 }));
}

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-scan-report-"));
  process.env.FAILPROOFAI_HOME = home;
  delete process.env.FAILPROOFAI_CLOUD_URL;
  delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("the gates", () => {
  it("posts nothing, and says nothing, on an unenrolled machine", async () => {
    const fetchImpl = okFetch();
    const outcome = await reportScanToCloud(result(), {
      osUser: "chetan",
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toEqual({ sent: false, reason: "not-enrolled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts nothing when the machine is enrolled but nobody opted in", async () => {
    enroll();
    const fetchImpl = okFetch();
    const outcome = await reportScanToCloud(result(), {
      osUser: "chetan",
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toEqual({ sent: false, reason: "not-opted-in" });
    // The load-bearing assertion: nothing reached the network. The server
    // would have mailed somebody off the back of this request.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts nothing on a clean week", async () => {
    enroll();
    optIn();
    const fetchImpl = okFetch();
    const outcome = await reportScanToCloud(result([]), {
      osUser: "chetan",
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toEqual({ sent: false, reason: "no-harmful-findings" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts nothing when the OS user cannot be resolved", async () => {
    enroll();
    optIn();
    const fetchImpl = okFetch();
    const outcome = await reportScanToCloud(result(), {
      osUser: "",
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toEqual({ sent: false, reason: "invalid-identity" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the request", () => {
  it("posts the whitelisted payload to the enforcement path with the machine key", async () => {
    enroll();
    optIn();
    const fetchImpl = okFetch();
    const outcome = await reportScanToCloud(result(), {
      osUser: "chetan",
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toEqual({ sent: true, status: 202 });

    const [url, init, timeout] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
      number,
    ];
    expect(url).toBe(`https://app.befailproof.ai${MACHINE_SCAN_PATH}`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fpai_secret");
    expect(timeout).toBe(SCAN_REPORT_TIMEOUT_MS);

    const body = JSON.parse(init.body as string);
    expect(body.machineId).toBe("machine-1");
    expect(body.osUser).toBe("chetan");
    expect(body.findings[0].ruleId).toBe("failproofai/block-sudo");
    // No recipient field exists, and no transcript content rode along.
    expect(Object.keys(body)).not.toContain("recipient");
    expect(init.body as string).not.toContain("secret-client");
    expect(init.body as string).not.toContain("rm -rf");
  });

  it("reports through an events:add-only credential, which has no [cloud] table", async () => {
    // The whole reporting-only fleet. Requiring a policy-pull key here would
    // have shipped this feature inert for every one of them.
    writeVersionFile({});
    writeCredentials({ ingest: { url: "https://app.befailproof.ai/v1/events", key: "fpai_ingest" } });
    updateConfig({ mode: "cloud", collector: { machineId: "machine-2" }, email: { reports: true } });

    const target = machineScanTarget();
    expect(target).toEqual({
      baseUrl: "https://app.befailproof.ai",
      token: "fpai_ingest",
      machineId: "machine-2",
    });

    const fetchImpl = okFetch();
    const outcome = await reportScanToCloud(result(), {
      osUser: "chetan",
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toEqual({ sent: true, status: 202 });
    // The `/v1/events` suffix is stripped — posting a scan into the events
    // handler 404s, or on the dashboard hostname returns an HTML page with 200.
    const [postedUrl] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(postedUrl).toBe(`https://app.befailproof.ai${MACHINE_SCAN_PATH}`);
  });
});

describe("when it fails", () => {
  it("never throws, and never retries, on an unreachable server", async () => {
    enroll();
    optIn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await reportScanToCloud(result(), {
      osUser: "chetan",
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toEqual({ sent: false, reason: "unreachable", detail: "ECONNREFUSED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal without retrying it", async () => {
    enroll();
    optIn();
    // 422 is what a payload the server does not recognise gets. Retrying an
    // unprocessable body in a loop is how one bad release becomes an outage.
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 422 }));
    const outcome = await reportScanToCloud(result(), {
      osUser: "chetan",
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toEqual({ sent: false, reason: "rejected", status: 422 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("survives a corrupt home rather than failing the audit", async () => {
    enroll();
    optIn();
    const fetchImpl = vi.fn(() => {
      throw new Error("boom");
    });
    await expect(
      reportScanToCloud(result(), { osUser: "chetan", fetchImpl: fetchImpl as never }),
    ).resolves.toMatchObject({ sent: false });
  });
});
