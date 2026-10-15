// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToCloud, describeOutcome, type ConnectInput } from "../../src/hooks/cloud-connection";
import { readCredentials, writeCredentials } from "../../src/hooks/fp-config";
import { credentialsFile, failedDir, cloudPoliciesDir } from "../../src/hooks/fp-home";
import { flushRequestPath } from "../../src/hooks/flush-cli";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-reconnect-"));
  process.env.FAILPROOFAI_HOME = home;
  writeCredentials({
    cloud: { url: "https://cloud.example", machineId: "m", token: "old-policy-e0ed" },
    ingest: { url: "https://cloud.example/v1/events", key: "old-ingest-abcd" },
    jev: { url: "https://cloud.example", key: "old-jev-1234" },
    org: { id: "A" },
  });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function connect(permissions: string[] | null, over: Partial<ConnectInput> = {}) {
  return connectToCloud({
    url: "https://cloud.example", token: "replacement-valid", machineId: "m", sessions: true,
    introspect: async () => permissions === null
      ? { kind: "unreachable", reason: "offline" }
      : { kind: "ok", identity: { orgId: "A", permissions } },
    verifyPolicy: async () => ({ ok: true, policyCount: 0, deployment: 0 }),
    verifyIngest: async () => ({ ok: true }),
    ...over,
  });
}

describe("replacement credentials", () => {
  it("collector-only removes previous policy and Jev keys and active policies", async () => {
    mkdirSync(cloudPoliciesDir(), { recursive: true });
    writeFileSync(join(cloudPoliciesDir(), "active.json"), "{}");
    const result = await connect(["events:add"]);
    expect(readCredentials().cloud).toBeUndefined();
    expect(readCredentials().jev).toBeUndefined();
    expect(readCredentials().ingest?.key).toBe("replacement-valid");
    expect(existsSync(join(cloudPoliciesDir(), "active.json"))).toBe(false);
    const text = describeOutcome(result, "m", "https://cloud.example").join("\n");
    expect(text).toContain("Removed the previous policy key ****e0ed");
    expect(text).toContain("policies:pull");
    expect(text).not.toContain("old-policy-e0ed");
  });

  it("policy-only removes previous ingest and Jev keys", async () => {
    const result = await connect(["policies:pull"]);
    expect(readCredentials().cloud?.token).toBe("replacement-valid");
    expect(readCredentials().ingest).toBeUndefined();
    expect(readCredentials().jev).toBeUndefined();
    expect(result.changes?.join("\n")).toContain("****abcd");
    expect(readCredentials().connectedAt).toBeGreaterThan(0);
  });

  it.each([401, 403, 404])("clears a refused policy slot (HTTP %s) even with the same token", async (status) => {
    await connect(null, {
      token: "old-policy-e0ed",
      verifyPolicy: async () => ({ ok: false, status, reason: "refused" }),
    });
    expect(readCredentials().cloud).toBeUndefined();
  });

  it.each([401, 403])("clears a refused ingest slot (HTTP %s) even with the same token", async (status) => {
    await connect(null, {
      token: "old-ingest-abcd",
      verifyIngest: async () => ({ ok: false, status, reason: "refused" }),
    });
    expect(readCredentials().ingest).toBeUndefined();
  });

  it.each([undefined, 503])("keeps an unknown policy result only for unchanged token and origin (%s)", async (status) => {
    await connect(null, {
      token: "old-policy-e0ed",
      verifyPolicy: async () => ({ ok: false, status, reason: "offline" }),
    });
    expect(readCredentials().cloud?.token).toBe("old-policy-e0ed");
  });

  it.each([undefined, 503])("drops unknown results for a replacement token (%s)", async (status) => {
    await connect(null, { verifyPolicy: async () => ({ ok: false, status, reason: "offline" }) });
    expect(readCredentials().cloud).toBeUndefined();
    expect(readCredentials().jev).toBeUndefined();
  });

  it("drops an unknown slot on an origin change, even with the same token", async () => {
    await connect(null, {
      url: "https://other.example", token: "old-policy-e0ed",
      verifyPolicy: async () => ({ ok: false, status: 503, reason: "offline" }),
    });
    expect(readCredentials().cloud).toBeUndefined();
  });

  it("a completely failed connect changes no credential bytes", async () => {
    const before = readFileSync(credentialsFile(), "utf8");
    await connect(null, {
      verifyPolicy: async () => ({ ok: false, reason: "offline" }),
      verifyIngest: async () => ({ ok: false, status: 403, reason: "refused" }),
    });
    expect(readFileSync(credentialsFile(), "utf8")).toBe(before);
  });
});

describe("credential refusal recovery", () => {
  function park(name: string) {
    mkdirSync(failedDir(), { recursive: true });
    writeFileSync(join(failedDir(), name), '{"timestamp":"2026-10-14T00:00:00Z"}\n');
  }
  it("same-org rotation redrives 401/403 and requests a flush, but leaves poison and other refusals alone", async () => {
    for (const name of ["a.a1.c401.jsonl", "b.a1.c403.jsonl", "c.a1.c422.jsonl", "d.a3.c401.jsonl.poison"]) park(name);
    await connect(["events:add", "policies:pull"]);
    expect(existsSync(join(failedDir(), "a.a1.jsonl"))).toBe(true);
    expect(existsSync(join(failedDir(), "b.a1.jsonl"))).toBe(true);
    expect(existsSync(join(failedDir(), "c.a1.c422.jsonl"))).toBe(true);
    expect(existsSync(join(failedDir(), "d.a3.c401.jsonl.poison"))).toBe(true);
    expect(existsSync(flushRequestPath())).toBe(true);
  });
  it("different-org rotation archives refusals instead of redriving them", async () => {
    park("a.a1.c401.jsonl");
    await connect(["events:add"], {
      introspect: async () => ({ kind: "ok", identity: { orgId: "B", permissions: ["events:add"] } }),
    });
    expect(existsSync(join(failedDir(), "a.a1.c401.jsonl"))).toBe(false);
    expect(existsSync(join(home, "state/previous-org/A/failed/a.a1.c401.jsonl"))).toBe(true);
    expect(existsSync(flushRequestPath())).toBe(false);
  });
  it("unknown org is not sufficient evidence to resend refused batches", async () => {
    park("a.a1.c401.jsonl");
    await connect(null);
    expect(existsSync(join(home, "state/previous-org/A/failed/a.a1.c401.jsonl"))).toBe(true);
  });
  it("unchanged token does not redrive a refusal", async () => {
    park("a.a1.c401.jsonl");
    await connect(["events:add"], { token: "old-ingest-abcd" });
    expect(existsSync(join(failedDir(), "a.a1.c401.jsonl"))).toBe(true);
  });
});
