/**
 * The seam between the CLI's telemetry and the daemon's.
 *
 * They are two processes in two languages posting to one PostHog project, and
 * every way they can disagree is silent. A drifted API key sends daemon events
 * to a project nobody reads; a drifted `state/telemetry-id` path files one
 * machine as two persons; a `$lib` shared with the hook dispatcher makes "which
 * component reported this" unanswerable. None of that fails anything at runtime,
 * so it is asserted here instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { POSTHOG_API_KEY, POSTHOG_PRODUCT } from "../../src/posthog-key";
import { telemetryIdFile } from "../../src/hooks/fp-home";

const RUST_TELEMETRY = resolve(__dirname, "../../crates/failproofaid/src/telemetry.rs");

describe("the daemon's PostHog constants mirror the TypeScript ones", () => {
  const rust = readFileSync(RUST_TELEMETRY, "utf-8");

  it("posts to the same project as every other dispatcher", () => {
    // Rust cannot import src/posthog-key.ts, so the key is a literal there. A
    // rotated key that is changed in one file and not the other produces a
    // daemon that reports perfectly into a project nobody looks at.
    expect(rust).toContain(`const POSTHOG_API_KEY: &str = "${POSTHOG_API_KEY}";`);
    expect(rust).toContain(`const POSTHOG_PRODUCT: &str = "${POSTHOG_PRODUCT}";`);
  });

  it("uses a $lib none of the other four dispatchers uses", () => {
    // failproofai (the Next.js server), failproofai-hooks (the CLI and hook
    // binary), failproofai-web, failproofai-install — and now this one. A daemon
    // event that claimed to be a hook event would be indistinguishable from one.
    expect(rust).toContain(`const LIB: &str = "failproofai-daemon";`);
    for (const taken of ["failproofai-hooks", "failproofai-web", "failproofai-install"]) {
      expect(rust).not.toContain(`const LIB: &str = "${taken}"`);
    }
  });

  it("reads the telemetry id from the path fp-home.ts writes it to", () => {
    // Both halves of one agreement, in one assertion: fp-home.ts's own test pins
    // the TypeScript side to state/telemetry-id, and this pins the Rust side to
    // the same two segments.
    const paths = readFileSync(
      resolve(__dirname, "../../crates/failproofaid/src/paths.rs"),
      "utf-8",
    );
    expect(paths).toContain(`home.join("state").join("telemetry-id")`);
  });
});

describe("getInstanceId publishes what it resolved", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.FAILPROOFAI_HOME;
    home = mkdtempSync(resolve(tmpdir(), "fpai-telemetry-id-"));
    process.env.FAILPROOFAI_HOME = home;
    // The id is memoised per module instance, and publication happens on the
    // first resolution — so every case here needs a fresh module.
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
    else process.env.FAILPROOFAI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("writes the id the daemon will report under, owner-only", async () => {
    const { getInstanceId } = await import("../../lib/telemetry-id");
    const id = getInstanceId();
    expect(readFileSync(telemetryIdFile(), "utf-8")).toBe(id);
    // The file names nothing secret, but nothing else under state/ is
    // world-readable either and this is the id a whole PostHog person hangs off.
    expect(statSync(telemetryIdFile()).mode & 0o777).toBe(0o600);
  });

  it("leaves no staging file behind", async () => {
    // The write is tmp → rename because a torn id is not a lost byte: the daemon
    // would adopt whatever is on disk as a permanent, wrong person id.
    const { getInstanceId } = await import("../../lib/telemetry-id");
    getInstanceId();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(resolve(home, "state")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("rewrites a file whose contents disagree with what it resolved", async () => {
    // A home restored from a backup, or copied off another machine. The CLI's
    // answer is authoritative — leaving a stale value would keep the daemon
    // reporting as a machine this is not.
    mkdirSync(resolve(home, "state"), { recursive: true });
    writeFileSync(telemetryIdFile(), "someone-elses-id");
    const { getInstanceId } = await import("../../lib/telemetry-id");
    const id = getInstanceId();
    expect(id).not.toBe("someone-elses-id");
    expect(readFileSync(telemetryIdFile(), "utf-8")).toBe(id);
  });

  it("never throws when the home cannot be written", async () => {
    // This runs on the hook path. A telemetry id that could not be published is
    // worth nothing next to a tool call that did not complete.
    //
    // The home is pointed *inside a regular file*, so every write below fails
    // with ENOTDIR — unwritable in a way that holds for root as well, which a
    // chmod would not, and that CI runners reach the same way a developer does.
    const blocker = resolve(home, "not-a-directory");
    writeFileSync(blocker, "");
    process.env.FAILPROOFAI_HOME = resolve(blocker, "failproofai");
    const { getInstanceId } = await import("../../lib/telemetry-id");
    expect(() => getInstanceId()).not.toThrow();
    expect(getInstanceId()).toMatch(/^[0-9a-f-]+$/);
  });
});
