// @vitest-environment node
/**
 * The off-switch, from the CLI side.
 *
 * The property that matters is not the flag — it is that this and the
 * dashboard's toggle and the audit child's read are all the SAME key. Two
 * surfaces that each remember their own answer is how a user silences a banner
 * and keeps getting it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runNotifyToggle } from "@/src/audit/schedule-cli";
import { readConfig } from "@/src/hooks/fp-config";

let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(join(tmpdir(), "fp-notify-"));
  process.env.FAILPROOFAI_HOME = home;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prev === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("failproofai audit --notify / --no-notify", () => {
  it("writes the key the daemon's audit child reads", () => {
    runNotifyToggle(false);
    expect(readConfig().audit.notify).toBe(false);
    expect(JSON.parse(readFileSync(resolve(home, "config.json"), "utf8")).audit.notify).toBe(false);

    runNotifyToggle(true);
    expect(readConfig().audit.notify).toBe(true);
  });

  it("does not touch the schedule", () => {
    // The whole reason this is its own flag pair: somebody silencing a banner
    // must not discover they also switched off the weekly scan.
    writeFileSync(
      resolve(home, "config.json"),
      JSON.stringify({ audit: { auto: true, interval_days: 30 } }),
    );

    runNotifyToggle(false);

    const after = readConfig().audit;
    expect(after.auto).toBe(true);
    expect(after.intervalDays).toBe(30);
    expect(after.notify).toBe(false);
  });

  it("leaves unrelated settings alone", () => {
    writeFileSync(
      resolve(home, "config.json"),
      JSON.stringify({ audit: { auto: true }, telemetry: { enabled: false } }),
    );
    runNotifyToggle(false);
    expect(readConfig().telemetry.enabled).toBe(false);
  });

  it("says which way it went, in both directions", () => {
    const out = vi.mocked(process.stdout.write);
    runNotifyToggle(false);
    expect(out.mock.calls.flat().join("")).toContain("scans continue");
    out.mockClear();
    runNotifyToggle(true);
    expect(out.mock.calls.flat().join("")).toContain("finds a credential");
  });
});
