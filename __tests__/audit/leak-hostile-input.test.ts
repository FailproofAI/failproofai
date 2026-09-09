// @vitest-environment node
/**
 * Adversarial input, on the two paths that read attacker-shaped data.
 *
 * The audit reads transcripts. A transcript is a record of whatever a repository
 * made an agent do — file contents, command output, pasted blobs — so every
 * string reaching the scanner is, in the strict sense, hostile input from a
 * source the user does not control. Two classes of bug live here, and both were
 * found by measurement rather than by reading:
 *
 *   1. Quadratic regexes. A 300 KB unbroken token hung the scan for over 20
 *      seconds. Base64 images, minified bundles and whole files arrive as single
 *      lines constantly; a scheduled scan hitting a few would stall for minutes
 *      with nobody watching.
 *   2. Ids becoming filenames. A finding id is used as a path component, and
 *      `"../../../../tmp/PWNED"` created that file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { findSecrets } from "@/src/audit/leak-scan";
import { redactExample } from "@/src/audit/redact-example";
import { isFindingId } from "@/src/audit/leak-fingerprint";
import { markLeakNoticeDelivered, pendingLeakNotice } from "@/src/audit/leak-notice";
import { queueMacNotification, macNotifyDir } from "@/src/audit/macos-notifier";

// Generous on purpose. The point is to catch a return to catastrophic
// backtracking (20_000ms+), not to police normal variation on a loaded CI box.
const BUDGET_MS = 3_000;

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

const BOMBS: ReadonlyArray<readonly [string, string]> = [
  // The two that actually hung. A single long assignment value, and a plain
  // base64-shaped blob — the single most common large token in a transcript.
  ["a long assignment value", "A=" + "a".repeat(200_000)],
  ["a 300KB unbroken token", "A".repeat(300_000)],
  // The URL shape that took 4.8s inside the redactor's credential matcher.
  ["a very long URL", "https://" + "a".repeat(50_000) + "?token=x"],
  ["quote flood", '"'.repeat(50_000)],
  ["open-quote flood", 'K="'.repeat(20_000)],
  ["separator flood", "=".repeat(100_000)],
  ["colon flood", ":".repeat(100_000)],
  ["spaces before a separator", "K" + " ".repeat(50_000) + "=v"],
  ["tab flood", ("K" + TAB).repeat(30_000) + "=v"],
  ["many small assignments", Array.from({ length: 20_000 }, (_, i) => `K${i}=v${i}`).join(" ")],
  ["vendor-prefix flood", "sk-".repeat(50_000)],
  ["newline flood", NL.repeat(200_000)],
  ["deep path", "/a".repeat(40_000)],
  ["one enormous path segment", "/" + "a".repeat(200_000)],
];

describe("pathological input finishes", () => {
  for (const [name, input] of BOMBS) {
    it(`scans ${name} without backtracking`, () => {
      const t0 = performance.now();
      findSecrets(input);
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
    });

    it(`redacts ${name} without backtracking`, () => {
      const t0 = performance.now();
      redactExample(input);
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
    });
  }

  it("stays roughly linear as the input grows", () => {
    // The signature of the bug: 4x the input took ~16x the time. Linear-ish
    // growth is what a bounded quantifier buys, and it is the property worth
    // asserting rather than any single duration.
    const time = (n: number) => {
      const text = "A".repeat(n);
      const t0 = performance.now();
      findSecrets(text);
      redactExample(text);
      return performance.now() - t0;
    };
    time(20_000); // warm up, so JIT does not masquerade as growth
    const small = Math.max(time(50_000), 1);
    const large = time(200_000);
    expect(large / small).toBeLessThan(12); // 4x input; quadratic would be ~16x
  });
});

// Correctness must survive the bounds — a faster redactor that stops redacting
// is not a fix.
describe("the bounds did not cost a match", () => {
  it("still strips credentials out of a URL", () => {
    const out = redactExample("git clone https://alice:hunter2@github.com/acme/x.git");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED");
  });

  it("still strips them from every scheme it used to", () => {
    for (const scheme of ["http", "https", "postgres", "redis", "mongodb+srv", "amqp"]) {
      const out = redactExample(`${scheme}://user:s3cr3tpassword@host/db`);
      expect(out, scheme).not.toContain("s3cr3tpassword");
    }
  });

  it("still annotates a recognized credential with a normal-length name", () => {
    const found = findSecrets('GITHUB_TOKEN="ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"');
    expect(found.map((f) => f.name)).toContain("GITHUB_TOKEN");
  });

  it("ignores an identifier longer than any real one", () => {
    // 128 is the bound. Nothing real is near it, and matching past it is what
    // made the scan quadratic.
    const name = "A".repeat(400);
    expect(findSecrets(`${name}_SECRET="abcdefghijklmnopqrstuvwxyz012345"`)).toEqual([]);
  });
});

describe("an id is never allowed to be a path", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fp-hostile-"));
    process.env.FAILPROOFAI_HOME = home;
  });
  afterEach(() => {
    delete process.env.FAILPROOFAI_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync("/tmp/fp-should-not-exist", { force: true });
  });

  const HOSTILE = [
    "../../../../tmp/fp-should-not-exist",
    "..",
    ".",
    "",
    "a/b/c",
    "/tmp/fp-should-not-exist",
    "a b",
    "A".repeat(400),
    "0123456789ABCDEF", // uppercase: not what fingerprintId mints
    "0123456789abcde",  // 15 chars
    "0123456789abcdefg", // 17
  ];

  it("refuses every id fingerprintId could not have produced", () => {
    for (const id of HOSTILE) expect(isFindingId(id), JSON.stringify(id)).toBe(false);
    expect(isFindingId("0123456789abcdef")).toBe(true);
  });

  it("does not write a notice marker outside its directory", () => {
    // The measured escape. Refusing also means NOT reporting the id as won, so
    // a caller never records a notice it did not actually claim.
    for (const id of HOSTILE) expect(markLeakNoticeDelivered([id]), id).toEqual([]);
    expect(existsSync("/tmp/fp-should-not-exist")).toBe(false);
  });

  it("does not queue a macOS banner outside its directory", () => {
    for (const id of HOSTILE) expect(queueMacNotification(id, "T", "B"), id).toBe(false);
    expect(existsSync("/tmp/fp-should-not-exist")).toBe(false);
  });

  it("leaves no staging file behind when a queue write is refused", () => {
    // Every rejected attempt used to strand a `notify-*.tmp` beside the watched
    // directory: never collected, because the agent only reads inside it.
    queueMacNotification("0123456789abcdef", "T", "B");
    for (const id of HOSTILE) queueMacNotification(id, "T", "B");
    const runDirEntries = readdirSync(resolve(macNotifyDir(), ".."));
    expect(runDirEntries.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("still accepts a real id", () => {
    expect(markLeakNoticeDelivered(["0123456789abcdef"])).toEqual(["0123456789abcdef"]);
    expect(queueMacNotification("fedcba9876543210", "T", "B")).toBe(true);
    expect(pendingLeakNotice().count).toBe(0);
  });
});
