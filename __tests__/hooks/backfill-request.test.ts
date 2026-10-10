import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

vi.mock("../../src/hooks/daemon-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/daemon-service")>();
  // The result screen asks systemd whether the daemon runs; never reach it.
  return { ...actual, isDaemonSupportedPlatform: vi.fn(() => false), daemonServiceStatus: vi.fn(() => "running") };
});

import {
  ADDED_REQUEST_MAX_AGE_MS,
  backfillRequestPath,
  mergeBackfillRequests,
  readPendingRequest,
  writeBackfillRequest,
  type BackfillRequest,
} from "../../src/hooks/backfill-request";
import { runBackfillCommand } from "../../src/hooks/backfill-cli";
import { writeCollectorSettings, writeIngestCredential } from "../../src/hooks/collector-config";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-backfill-"));
  process.env.FAILPROOFAI_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("readPendingRequest — read the way the daemon reads it", () => {
  it("reads a request with no kind as a user request, as older CLIs wrote it", () => {
    expect(readPendingRequest({ sinceMs: 5, requestedAtMs: 6 }, NOW)).toEqual({ kind: "user", sinceMs: 5, requestedAtMs: 6 });
  });

  it("drops what the daemon would drop", () => {
    expect(readPendingRequest({ kind: "user" }, NOW)).toBeNull(); // no window
    expect(readPendingRequest({ kind: "added", requestedAtMs: NOW }, NOW)).toBeNull(); // no agents
    expect(readPendingRequest({ kind: "added", agents: ["goose"] }, NOW)).toBeNull(); // no age
    expect(readPendingRequest({ kind: "later", sinceMs: 1 }, NOW)).toBeNull(); // unknown kind
    expect(readPendingRequest({ sinceMs: 1, agents: "claude" }, NOW)).toBeNull(); // not a list
    expect(readPendingRequest([], NOW)).toBeNull();
  });

  it("drops an added request older than the daemon would act on", () => {
    const old = { kind: "added", agents: ["goose"], requestedAtMs: NOW - ADDED_REQUEST_MAX_AGE_MS - 1 };
    expect(readPendingRequest(old, NOW)).toBeNull();
    expect(readPendingRequest({ ...old, requestedAtMs: NOW - 1000 }, NOW)).toMatchObject({ kind: "added" });
  });
});

describe("mergeBackfillRequests — the stronger request wins", () => {
  const added = (agents: string[]): BackfillRequest => ({ kind: "added", requestedAtMs: NOW, agents });
  const user = (sinceMs: number, agents?: string[]): BackfillRequest => ({
    kind: "user",
    sinceMs,
    requestedAtMs: NOW,
    ...(agents ? { agents } : {}),
  });

  it("is the new request when nothing is pending", () => {
    expect(mergeBackfillRequests(null, added(["goose"]))).toEqual(added(["goose"]));
  });

  it("unions two added requests", () => {
    expect(mergeBackfillRequests(added(["goose"]), added(["hermes", "goose"]))).toEqual(added(["goose", "hermes"]));
  });

  it("keeps a pending user request a user request, with its window", () => {
    expect(mergeBackfillRequests(user(NOW - 30 * DAY, ["claude"]), added(["goose"]))).toEqual(
      user(NOW - 30 * DAY, ["claude", "goose"]),
    );
  });

  it("turns a pending added request into the user request that follows it", () => {
    expect(mergeBackfillRequests(added(["goose"]), user(NOW - DAY, ["claude"]))).toEqual(user(NOW - DAY, ["goose", "claude"]));
  });

  it("keeps the widest window, and no list when either side reaches every agent", () => {
    expect(mergeBackfillRequests(user(NOW - 30 * DAY), user(NOW - DAY, ["claude"]))).toEqual(user(NOW - 30 * DAY));
    expect(mergeBackfillRequests(user(NOW - DAY), added(["goose"]))).toEqual(user(NOW - DAY));
  });
});

describe("writeBackfillRequest", () => {
  it("writes the request owner-only, where the daemon looks", () => {
    writeBackfillRequest({ kind: "added", requestedAtMs: NOW, agents: ["goose"] });
    const path = backfillRequestPath();
    expect(path).toBe(resolve(home, "state", "backfill-request.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ kind: "added", requestedAtMs: NOW, agents: ["goose"] });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("merges with a request still pending instead of replacing it", () => {
    const path = backfillRequestPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sinceMs: NOW - 30 * DAY, requestedAtMs: NOW - DAY }));
    const written = writeBackfillRequest({ kind: "added", requestedAtMs: NOW, agents: ["goose"] });
    expect(written).toEqual({ kind: "user", sinceMs: NOW - 30 * DAY, requestedAtMs: NOW });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(written);
  });

  it("replaces a pending file the daemon could not read anyway", () => {
    const path = backfillRequestPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");
    expect(writeBackfillRequest({ kind: "added", requestedAtMs: NOW, agents: ["goose"] })).toEqual({
      kind: "added",
      requestedAtMs: NOW,
      agents: ["goose"],
    });
  });

  it("never puts a window on an added request, which an older daemon would replay for every agent", () => {
    writeBackfillRequest({ kind: "added", requestedAtMs: NOW, agents: ["goose"] });
    expect(JSON.parse(readFileSync(backfillRequestPath(), "utf8"))).not.toHaveProperty("sinceMs");
  });
});

describe("failproofai backfill writes through the shared writer", () => {
  it("writes a user request with its window", () => {
    writeIngestCredential({ url: "https://app.befailproof.ai/v1/events", key: "k".repeat(20) });
    writeCollectorSettings({ sessions: true, hooks: true });
    const result = runBackfillCommand({ now: NOW, sinceMs: NOW - 7 * DAY });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(backfillRequestPath(), "utf8"))).toEqual({
      kind: "user",
      sinceMs: NOW - 7 * DAY,
      requestedAtMs: NOW,
    });
  });

  it("writes nothing on a dry run, or on a machine that is not connected", () => {
    expect(runBackfillCommand({ now: NOW }).exitCode).toBe(1);
    expect(existsSync(backfillRequestPath())).toBe(false);
    writeIngestCredential({ url: "https://app.befailproof.ai/v1/events", key: "k".repeat(20) });
    writeCollectorSettings({ sessions: true, hooks: true });
    expect(runBackfillCommand({ now: NOW, dryRun: true }).exitCode).toBe(0);
    expect(existsSync(backfillRequestPath())).toBe(false);
  });
});
