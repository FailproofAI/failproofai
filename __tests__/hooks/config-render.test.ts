// @vitest-environment node
/**
 * The template engine, against what the eight hand-written writers produced.
 *
 * `__tests__/fixtures/config-templates/*.json` was captured from the previous
 * implementation before any of it was touched, and it is the whole safety net:
 * a refactor of the code that installs enforcement has to be provably
 * behaviour-preserving, because the failure mode is a machine that looks
 * installed and enforces nothing.
 *
 * Each fixture holds three scenarios, because rendering into an empty object
 * only proves the entries are built right and says nothing about the merge —
 * which is the part being consolidated:
 *
 *   empty    a fresh install
 *   foreign  somebody else's hook, and their unrelated settings, must survive
 *   stale    our entry on an event we no longer install
 *
 * The `stale` row is the one deliberate change, and it is asserted as a change
 * rather than quietly accepted. See "the one thing that is different" below.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderConfig, buildTemplateEntry } from "../../src/hooks/config-render";
import { HOOK_TEMPLATES, validateTemplate, type HookTemplate } from "../../src/hooks/config-template";
import { getIntegration } from "../../src/hooks/integrations";
import type { HookScope, IntegrationType } from "../../src/hooks/types";

const DIR = join(__dirname, "..", "fixtures", "config-templates");

interface Fixture {
  cli: IntegrationType;
  scope: HookScope;
  binary: string;
  empty: Record<string, unknown>;
  foreign: Record<string, unknown>;
  stale: Record<string, unknown>;
}

const FIXTURES: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture);

const render = (fx: Fixture, into: Record<string, unknown>) => {
  renderConfig(HOOK_TEMPLATES[fx.cli], into, {
    binaryPath: fx.binary,
    scope: fx.scope,
    cli: fx.cli,
  });
  return into;
};

describe("rendering matches the writers it replaced", () => {
  it("covers every Family-A CLI, so a missing fixture cannot pass vacuously", () => {
    expect(new Set(FIXTURES.map((f) => f.cli))).toEqual(
      new Set(["claude", "codex", "copilot", "cursor", "factory", "devin", "antigravity", "goose"]),
    );
    expect(FIXTURES.length).toBeGreaterThanOrEqual(17);
  });

  it.each(FIXTURES.map((f) => [`${f.cli}/${f.scope}`, f] as const))(
    "%s: a fresh install is byte-identical",
    (_label, fx) => {
      expect(render(fx, {})).toEqual(fx.empty);
    },
  );

  it.each(FIXTURES.map((f) => [`${f.cli}/${f.scope}`, f] as const))(
    "%s: writing again over our own output changes nothing",
    (_label, fx) => {
      // Idempotence is what makes repair safe to run on a schedule: it must
      // replace our entry in place rather than appending a second copy.
      const once = render(fx, {});
      expect(render(fx, structuredClone(once))).toEqual(once);
    },
  );

  it.each(FIXTURES.map((f) => [`${f.cli}/${f.scope}`, f] as const))(
    "%s: another tool's hook and settings survive untouched",
    (_label, fx) => {
      // The file belongs to the user, and often to another tool as well.
      expect(render(fx, structuredClone(fx.foreign))).toEqual(fx.foreign);
    },
  );
});

describe("the one thing that is different", () => {
  it.each(FIXTURES.map((f) => [`${f.cli}/${f.scope}`, f] as const))(
    "%s: our entry is pruned from an event we no longer install",
    (_label, fx) => {
      // THE deliberate behaviour change. Of the eight writers only Claude did
      // this; the other seven left our entry on a dropped event in the user's
      // file forever, where reinstalling could not clear it — the situation a
      // removed Claude event once created, leaving a registered hook that broke
      // a flag until somebody hand-edited the file.
      //
      // Consolidating gives every CLI Claude's behaviour. Asserted here so the
      // fix is a named decision rather than a side effect nobody noticed.
      const out = render(fx, structuredClone(fx.stale));
      expect(JSON.stringify(out)).not.toContain("AnEventWeNoLongerInstall");
      // And pruning is all that changed: the rest still matches a fresh install.
      expect(out).toEqual(fx.empty);
    },
  );
});

describe("buildHookEntry still works per CLI", () => {
  it.each(FIXTURES.map((f) => [`${f.cli}/${f.scope}`, f] as const))(
    "%s: the integration's own entry builder agrees with the template",
    (_label, fx) => {
      // `buildHookEntry` is part of the Integration interface and tested
      // directly per CLI, so the entry has to be reachable on its own.
      const template = HOOK_TEMPLATES[fx.cli];
      const event = template.events[0];
      expect(
        getIntegration(fx.cli).buildHookEntry(fx.binary, event, fx.scope),
      ).toEqual(buildTemplateEntry(template, event, { binaryPath: fx.binary, scope: fx.scope, cli: fx.cli }));
    },
  );
});

describe("a template may describe shape, never content", () => {
  it("accepts all eight bundled templates", () => {
    for (const [cli, template] of Object.entries(HOOK_TEMPLATES)) {
      expect({ cli, problems: validateTemplate(template) }).toEqual({ cli, problems: [] });
    }
  });

  it.each([
    ["a command in a field name", { entryType: "npx -y failproofai --hook X" }],
    ["a path in the container", { container: ["/etc/cron.d/x"] }],
    ["a flag as a command field", { commandFields: ["-rf"] }],
    ["a command hidden in a file default", { fileDefaults: { x: "sh -c evil" } }],
    ["a matcher carrying arguments", { matcher: { on: "all" as const, value: "* ; rm -rf /" } }],
  ])("rejects %s", (_label, patch) => {
    // The boundary this whole design rests on. A template that could set the
    // command would be arbitrary code execution on every machine, on every tool
    // call — so the check is structural (arguments, path separators, leading
    // dashes) rather than a list of bad words, and it is checked rather than
    // documented.
    const problems = validateTemplate({ ...HOOK_TEMPLATES.claude, ...patch } as HookTemplate);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("still allows a key that happens to be our own name", () => {
    // Antigravity's container key is literally `failproofai`. An earlier
    // version of the check matched the word and rejected a legitimate template,
    // which is why the rule is about executability instead.
    expect(validateTemplate(HOOK_TEMPLATES.antigravity)).toEqual([]);
  });
});

describe("what it refuses to do to a file it does not understand", () => {
  it("throws rather than discard a value sitting on an event we install", () => {
    // Surfaces as `unreadable` in drift detection, which repair then declines
    // to touch. Silently replacing the value would destroy another tool's
    // config, and doing it quietly is worse than refusing.
    const settings = { hooks: { PreToolUse: { matcher: "*", hooks: [] } } };
    expect(() =>
      renderConfig(HOOK_TEMPLATES.claude, settings, {
        binaryPath: "/usr/bin/failproofai",
        scope: "user",
        cli: "claude",
      }),
    ).toThrow();
  });

  it("leaves an unrecognised value alone when it sits on an event we do not install", () => {
    // The asymmetry with the case above: there the event is ours to write, here
    // it is somebody else's to keep, and throwing would let an unrelated key
    // abort an install.
    const settings: Record<string, unknown> = { hooks: { SomeOtherTool: "not a list" } };
    renderConfig(HOOK_TEMPLATES.claude, settings, {
      binaryPath: "/usr/bin/failproofai",
      scope: "user",
      cli: "claude",
    });
    expect((settings.hooks as Record<string, unknown>).SomeOtherTool).toBe("not a list");
  });
});
