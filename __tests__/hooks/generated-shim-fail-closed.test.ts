// @vitest-environment node
/**
 * The generated launcher scripts, checked as SHIPPED ARTIFACTS.
 *
 * These files are strings built at install time, so nothing else typechecks or
 * exercises them — which is how a fail-open crept into the ori feature: its
 * `close` handler took no arguments, so a failproofai binary that crashed
 * before writing stdout resolved to `{permission:"allow"}`. Ori's
 * `failureBehavior:"deny"` could never fire on that path, because RESOLVING is
 * what tells ori the provider succeeded; only a rejection reaches the guarantee.
 * The integration claimed to fail closed and, on the one path that matters when
 * failproofai is broken, did the opposite.
 *
 * SCOPE, stated honestly: these assert on the generated SOURCE, not on a live
 * ori runtime — the feature imports `ori`, which only exists inside ori's own
 * process. They are a regression guard on the artifact we write to disk, and
 * they would catch the exact reintroduction of the bug above. They do not prove
 * ori honours the rejection; that was verified by hand against ori 0.12.0.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ori, cline } from "@/src/hooks/integrations";

const made: string[] = [];
function tempHome(envVar: "ORI_HOME" | "CLINE_HOME"): string {
  const dir = mkdtempSync(join(tmpdir(), "fp-shim-"));
  made.push(dir);
  process.env[envVar] = dir;
  return dir;
}

afterEach(() => {
  delete process.env.ORI_HOME;
  delete process.env.CLINE_HOME;
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("generated ori feature fails CLOSED on a broken failproofai", () => {
  function generate(): string {
    const home = tempHome("ORI_HOME");
    ori.writeHookEntries({}, "/usr/local/bin/failproofai", "user");
    const path = join(home, "global", "features", "failproofai", "feature.ts");
    expect(existsSync(path)).toBe(true);
    return readFileSync(path, "utf8");
  }

  it("inspects the child's exit code and signal", () => {
    const src = generate();
    expect(src).toMatch(/child\.on\("close",\s*\(code,\s*signal\)/);
  });

  it("treats a non-zero exit or a signal as a failure, not an allow", () => {
    const src = generate();
    // The guard must appear BEFORE the empty-stdout allow, or a crashed binary
    // with no output takes the allow path first and the guard is dead code.
    const guard = src.search(/if \(signal \|\| \(typeof code === "number" && code !== 0\)\)/);
    const emptyAllow = src.search(/if \(!stdout\) \{ finish\(done, \{ permission: "allow" \}\); return; \}/);
    expect(guard).toBeGreaterThan(-1);
    expect(emptyAllow).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(emptyAllow);
  });

  it("rejects a verdict that is neither an explicit allow nor an explicit deny", () => {
    // decide() maps every non-"deny" to allow, so an unvalidated object would
    // silently become one.
    const src = generate();
    expect(src).toMatch(/verdict\.permission !== "allow" && verdict\.permission !== "deny"/);
  });

  it("still treats exit 0 with empty stdout as a real allow", () => {
    // That IS the evaluator's clean-allow shape; rejecting it would deny every
    // allowed tool call on a working install.
    const src = generate();
    expect(src).toMatch(/if \(!stdout\) \{ finish\(done, \{ permission: "allow" \}\); return; \}/);
  });

  it("routes every failure through FAIL_OPEN so the escape hatch still works", () => {
    const src = generate();
    // Each failure branch offers the documented opt-out rather than hardcoding
    // a deny — an operator who cannot afford a failproofai fault to stop their
    // agent needs a way out that does not mean uninstalling.
    const branches = src.match(/FAIL_OPEN \? finish\(done, \{ permission: "allow" \}\) : finish\(fail,/g);
    expect(branches?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe("generated cline launcher always emits exactly one JSON object", () => {
  it("prints {} when failproofai produces nothing", () => {
    // Cline IGNORES the exit code and reads stdout only. Unparseable or empty
    // stdout makes it skip the hook and run the tool, so the launcher must
    // always print one object — cline is fail-open with no opt-out, and this is
    // the one place we can keep that from becoming garbled output.
    const home = tempHome("CLINE_HOME");
    cline.writeHookEntries({}, "/usr/local/bin/failproofai", "user");
    const src = readFileSync(join(home, "hooks", "PreToolUse.sh"), "utf8");
    expect(src).toContain('verdict=\'{}\'');
    expect(src).toMatch(/printf '%s\\n' "\$verdict"/);
    expect(src).toContain("--hook PreToolUse --cli cline");
  });

  it("names the file for the event, because the filename IS the subscription", () => {
    const home = tempHome("CLINE_HOME");
    cline.writeHookEntries({}, "/usr/local/bin/failproofai", "user");
    for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "TaskComplete"]) {
      const path = join(home, "hooks", `${event}.sh`);
      expect(existsSync(path), `${event}.sh must exist`).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(`--hook ${event} --cli cline`);
    }
    // PreCompact maps to undefined upstream and is skipped at dispatch.
    expect(existsSync(join(home, "hooks", "PreCompact.sh"))).toBe(false);
  });
});
