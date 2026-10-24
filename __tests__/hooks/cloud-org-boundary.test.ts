// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToCloud, describeOutcome, type ConnectInput } from "../../src/hooks/cloud-connection";
import { readCredentials, writeCredentials } from "../../src/hooks/fp-config";
import { backfillRequestPath } from "../../src/hooks/backfill-request";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-org-boundary-"));
  process.env.FAILPROOFAI_HOME = home;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function connect(orgId?: string, over: Partial<ConnectInput> = {}) {
  return connectToCloud({
    url: "https://cloud.example", token: "new", machineId: "m",
    introspect: async () => orgId
      ? { kind: "ok", identity: { orgId, orgName: orgId, permissions: ["events:add", "policies:pull"] } }
      : { kind: "unsupported" },
    verifyPolicy: async () => ({ ok: true, policyCount: 0, deployment: 0 }),
    verifyIngest: async () => ({ ok: true }),
    ...over,
  });
}
function previous(id?: string) {
  writeCredentials({
    org: { id, since: 100 },
    cloud: { url: "https://cloud.example", token: "old", machineId: "m" },
    ingest: { url: "https://cloud.example/v1/events", key: "old" },
  });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(backfillRequestPath(), '{"kind":"user","sinceMs":0}');
}

describe("cloud organisation recording boundary", () => {
  it("first connect sets no boundary, so the machine backfills its window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    await connect("A");
    expect(readCredentials().org).toEqual({ id: "A", name: "A", slug: undefined });
    expect(readCredentials().org).not.toHaveProperty("since");
  });
  it("first connect on a server without introspect sets no boundary either", async () => {
    await connect();
    expect(readCredentials().org?.since).toBeUndefined();
  });
  it("a machine upgrading from a version with no boundary keeps none on a same-key reconnect", async () => {
    writeCredentials({
      cloud: { url: "https://cloud.example", token: "new", machineId: "m" },
      ingest: { url: "https://cloud.example/v1/events", key: "new" },
    });
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(backfillRequestPath(), '{"kind":"user","sinceMs":0}');
    await connect("A");
    expect(readCredentials().org?.since).toBeUndefined();
    expect(existsSync(backfillRequestPath())).toBe(true);
  });
  it("switching known organisations drops pending backfill and announces the clean break", async () => {
    previous("A");
    vi.spyOn(Date, "now").mockReturnValue(2000);
    const result = await connect("B");
    expect(readCredentials().org).toEqual({ id: "B", name: "B", slug: undefined, since: 2000 });
    expect(existsSync(backfillRequestPath())).toBe(false);
    expect(describeOutcome(result, "m", "https://cloud.example").join("\n")).toContain(
      "Switched from A to B. Nothing recorded before now will be sent to B; A's cloud policies stop within ~30 s.",
    );
  });
  it("same-org rotation keeps the original boundary and pending backfill", async () => {
    previous("A");
    await connect("A");
    expect(readCredentials().org?.since).toBe(100);
    expect(existsSync(backfillRequestPath())).toBe(true);
  });
  it.each([[undefined, "B"], ["A", undefined], [undefined, undefined]])(
    "changed key with either org unknown resets the boundary (%s to %s)",
    async (old, next) => {
      previous(old);
      vi.spyOn(Date, "now").mockReturnValue(3000);
      await connect(next);
      expect(readCredentials().org?.since).toBe(3000);
      expect(existsSync(backfillRequestPath())).toBe(false);
    },
  );
  it("an unchanged unknown identity does not reset its boundary", async () => {
    previous();
    await connect(undefined, { token: "old" });
    expect(readCredentials().org?.since).toBe(100);
  });
  // B1 (e2e round 1): the same organisation on a new URL — http → https, a new
  // host for the same Cloud — is a reconnect. Treating it as a switch printed
  // "Switched from A to A" and cleared the org's Cloud policies until the next poll.
  it("changing origin for the same known org is not a switch: boundary, backfill and policies stay", async () => {
    previous("A");
    const policies = join(home, "policies", "cloud-policies");
    mkdirSync(policies, { recursive: true });
    writeFileSync(join(policies, "active.json"), "{}");
    vi.spyOn(Date, "now").mockReturnValue(4000);
    const result = await connect("A", { token: "old", url: "http://other.example:8080" });
    expect(readCredentials().org?.since).toBe(100);
    expect(existsSync(backfillRequestPath())).toBe(true);
    expect(existsSync(join(policies, "active.json"))).toBe(true);
    expect(describeOutcome(result, "m", "http://other.example:8080").join("\n")).not.toMatch(/Switched from/);
  });
  it("changing origin with either org unknown still resets the boundary", async () => {
    previous("A");
    vi.spyOn(Date, "now").mockReturnValue(4000);
    await connect(undefined, { token: "old", url: "https://other.example" });
    expect(readCredentials().org?.since).toBe(4000);
  });
  it("a failed org switch keeps credentials and pending backfill untouched", async () => {
    previous("A");
    const before = readCredentials();
    await connect("B", {
      verifyPolicy: async () => ({ ok: false, status: 503, reason: "offline" }),
      verifyIngest: async () => ({ ok: false, reason: "offline" }),
    });
    expect(readCredentials()).toEqual(before);
    expect(existsSync(backfillRequestPath())).toBe(true);
  });
});
