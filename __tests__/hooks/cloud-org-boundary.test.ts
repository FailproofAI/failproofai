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
  it("first connect sets an epoch-ms boundary even on a server without introspect", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    await connect();
    expect(readCredentials().org).toEqual({ since: 1000 });
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
  it("changing origin resets the boundary even if org id and token are the same", async () => {
    previous("A");
    vi.spyOn(Date, "now").mockReturnValue(4000);
    await connect("A", { token: "old", url: "https://other.example" });
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
