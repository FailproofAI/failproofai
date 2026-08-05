// @vitest-environment node
/**
 * The first (and only) TypeScript reader of the daemon-written
 * `state/audit-schedule.json`. The daemon and the CLI ship independently, so
 * this reader has to survive a file it did not write — a version ahead, a torn
 * write, or simply absent — without ever throwing, because it feeds a settings
 * page that must not blank out over one derived-state file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { auditScheduleFile, stateDir } from "../../src/hooks/fp-home";
import { readAuditSchedule, AUDIT_SCHEDULE_SCHEMA } from "../../src/audit/audit-schedule";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-schedule-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function writeSchedule(contents: string): void {
  mkdirSync(dirname(auditScheduleFile()), { recursive: true });
  writeFileSync(auditScheduleFile(), contents);
}

describe("readAuditSchedule", () => {
  it("returns null when the file is absent", () => {
    // stateDir exists as a concept but the file was never written.
    mkdirSync(stateDir(), { recursive: true });
    expect(readAuditSchedule()).toBeNull();
  });

  it("reads a well-formed current-schema schedule", () => {
    writeSchedule(
      JSON.stringify({
        schema: AUDIT_SCHEDULE_SCHEMA,
        next_due_at_ms: 1_000,
        last_attempt_at_ms: 900,
        last_run_at_ms: 800,
        last_exit_code: 0,
      }),
    );
    expect(readAuditSchedule()).toEqual({
      schema: AUDIT_SCHEDULE_SCHEMA,
      nextDueAtMs: 1_000,
      lastAttemptAtMs: 900,
      lastRunAtMs: 800,
      lastExitCode: 0,
      schemaAhead: false,
    });
  });

  it("defaults optional fields the daemon may omit to null", () => {
    // The Rust side writes these with #[serde(default)]; a freshly-seeded
    // schedule can carry only schema + next_due_at_ms.
    writeSchedule(JSON.stringify({ schema: AUDIT_SCHEDULE_SCHEMA, next_due_at_ms: 42 }));
    expect(readAuditSchedule()).toMatchObject({
      nextDueAtMs: 42,
      lastAttemptAtMs: null,
      lastRunAtMs: null,
      lastExitCode: null,
    });
  });

  it("still reads shared fields from a schema a version AHEAD, and flags it", () => {
    // The whole point: a newer daemon must not blank the settings page. Fields
    // are read by name regardless of schema; schemaAhead only caveats the view.
    writeSchedule(
      JSON.stringify({
        schema: AUDIT_SCHEDULE_SCHEMA + 5,
        next_due_at_ms: 2_000,
        last_run_at_ms: 1_500,
        some_future_field: "ignored",
      }),
    );
    const view = readAuditSchedule();
    expect(view).not.toBeNull();
    expect(view!.nextDueAtMs).toBe(2_000);
    expect(view!.lastRunAtMs).toBe(1_500);
    expect(view!.schemaAhead).toBe(true);
  });

  it("returns null on malformed JSON rather than throwing", () => {
    writeSchedule("{ this is not json");
    expect(readAuditSchedule()).toBeNull();
  });

  it("returns null when the top-level value is not an object", () => {
    writeSchedule("[1,2,3]");
    expect(readAuditSchedule()).toBeNull();
    writeSchedule("null");
    expect(readAuditSchedule()).toBeNull();
  });

  it("treats non-numeric fields as null instead of trusting them", () => {
    writeSchedule(
      JSON.stringify({
        schema: "1",
        next_due_at_ms: "soon",
        last_run_at_ms: null,
        last_exit_code: 2,
      }),
    );
    expect(readAuditSchedule()).toEqual({
      schema: null,
      nextDueAtMs: null,
      lastAttemptAtMs: null,
      lastRunAtMs: null,
      lastExitCode: 2,
      schemaAhead: false,
    });
  });
});
