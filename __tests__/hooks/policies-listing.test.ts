// @vitest-environment node
/**
 * `failproofai policies` — the window that answers "what is enforcing here?".
 *
 * It had no test at all, which is how it came to answer that question with a
 * subset: builtins in a table, convention files and cloud policies as footer
 * sections in two other shapes, and installed PACKS not at all.
 *
 * Since the 2026-10 redesign (decision D14: "the policies list exactly as
 * designed") every policy is ● on or ○ off, packs are named once as `pack` rows
 * at the top, off policies fold into one line per category, and `--all` lists
 * them by name. The assertions below pin the same facts the old chips did, in
 * that vocabulary — positively, so none of them can pass by the old label
 * simply no longer being printed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { visibleWidth } from "@/src/hooks/tui";
import type { PoliciesScreen } from "@/src/hooks/manager";

const ARTIFACT = "export const hooks = [];\n";
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

let home: string;
let project: string;
let packRoot: string;
let saved: Record<string, string | undefined>;
let out: string[];

const FINANCE = {
  id: "acme/finance",
  version: "1.2.0",
  source: "github:acme/finance@v1.2.0",
  entry: `artifacts/${DIGEST}.mjs`,
  sha256: DIGEST,
  policies: [
    {
      name: "block-big-refund",
      description: "Block big refunds",
      category: "Finance",
      defaultEnabled: true,
      match: {},
    },
    {
      name: "require-note",
      description: "Require a note",
      category: "Finance",
      defaultEnabled: true,
      match: {},
    },
  ],
};

function installPacks(packs: Array<Record<string, unknown>>): void {
  writeFileSync(join(packRoot, "installed.json"), JSON.stringify({ schemaVersion: 1, packs }));
}

function installPack(over: Record<string, unknown> = {}): void {
  installPacks([{ ...FINANCE, ...over }]);
}

/** Wire Claude Code at user scope, so "not enforcing" is decided by the policies alone. */
function wireClaude(dir: string = home): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "npx -y failproofai --hook PreToolUse", __failproofai_hook__: true }],
          },
        ],
      },
    }),
  );
}

async function run(opts: { all?: boolean } = {}): Promise<string> {
  const { listHooks } = await import("@/src/hooks/manager");
  await listHooks(project, opts);
  return out.join("\n");
}

const JEV_CHECK = {
  name: "acme-check",
  title: "Did the thing",
  appliesTo: ["shell"],
  mode: "deny",
  userCanOverride: true,
  probes: [{ id: "does", instructions: "It does the thing." }],
  guidance: "Ask first.",
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fpai-listing-home-"));
  project = mkdtempSync(join(tmpdir(), "fpai-listing-proj-"));
  packRoot = mkdtempSync(join(tmpdir(), "fpai-listing-packs-"));
  mkdirSync(join(packRoot, "artifacts"), { recursive: true });
  writeFileSync(join(packRoot, "artifacts", `${DIGEST}.mjs`), ARTIFACT);
  saved = {
    FAILPROOFAI_HOME: process.env.FAILPROOFAI_HOME,
    FAILPROOFAI_PACK_DIR: process.env.FAILPROOFAI_PACK_DIR,
  };
  process.env.FAILPROOFAI_HOME = home;
  process.env.FAILPROOFAI_PACK_DIR = packRoot;
  // User-scope hook settings resolve from the OS home, not FAILPROOFAI_HOME, so
  // without this the listing reads whoever-runs-it's real ~/.claude/settings.json
  // — and any other test file that writes there decides whether this one passes.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of [home, project, packRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("failproofai policies", () => {
  it("lists no policy from this build — enforcement comes from packs", async () => {
    // The builtin table is gone. Nothing is compiled in except the always-on
    // guard, and that has no row precisely because no listing can switch it off.
    // The empty-machine line proves the listing rendered, so the absence below
    // is a finding rather than a blank screen.
    const text = await run();
    expect(text).toContain("Turn on ours:  failproofai policies add FailproofAI/policies");
    expect(text).not.toMatch(/block-failproofai-commands/);
    expect(text).not.toContain("●");
  });

  it("lists an installed pack's policies, which no listing did before", async () => {
    installPack();
    const text = await run();
    expect(text).toMatch(/^ {2}pack\s+acme\/finance@1\.2\.0$/m);
    expect(text).toMatch(/^ {2}enabled\s+2 of 2$/m);
    expect(text).toMatch(/^FINANCE {2}2 of 2$/m);
    expect(text).toMatch(/● block-big-refund\s+Block big refunds/);
    expect(text).toMatch(/● require-note\s+Require a note/);
  });

  it("shows a pack policy the user did not take as off", async () => {
    // Folded by default — one "○ 1 more off" line in its category, and counted
    // in the heading — and listed by name, ○, under --all.
    installPack({ enabled: ["block-big-refund"] });
    const text = await run();
    expect(text).toMatch(/● block-big-refund/);
    expect(text).toMatch(/^FINANCE {2}1 of 2$/m);
    expect(text).toMatch(/^ {2}○ 1 more off$/m);
    expect(text).not.toMatch(/● require-note/);
    out = [];
    expect(await run({ all: true })).toMatch(/○ require-note\s+Require a note/);
  });

  it("shows an observe pack as observing, never as enforcing", async () => {
    // observe evaluates and discards its verdict, so its pack row says so — and
    // a wired machine whose only policies observe is told it is not enforcing.
    wireClaude();
    installPack({ effect: "observe" });
    const text = await run();
    expect(text).toMatch(/^ {2}pack\s+acme\/finance@1\.2\.0 {2}· {2}observe$/m);
    expect(text).toContain("▲ Policies are not enforcing yet.  ·  failproofai config");
  });

  it("does not tag a pack that enforces", async () => {
    // The control for the one above: the tag is about the pack, not decoration.
    wireClaude();
    installPack();
    const text = await run();
    expect(text).toMatch(/^ {2}pack\s+acme\/finance@1\.2\.0$/m);
    expect(text).not.toContain("Policies are not enforcing yet.");
  });

  it("names a pack that will not load instead of quietly listing less", async () => {
    installPack({ sha256: "0".repeat(64) });
    const text = await run();
    expect(text).toMatch(/^ {2}pack\s+acme\/finance {2}· {2}failed to load: /m);
    expect(text).toContain("✕ acme/finance failed to load, so the calls it covers are denied.");
  });

  it("does not call a pack of Jev checks alone switched off", async () => {
    // Its checks are live wherever Jev is configured; "everything switched off"
    // sent people to enable policies the pack does not have. It has no regex
    // policies, so it gets no categories, no fold line and no `enabled` row —
    // its row counts the checks instead.
    installPack({ policies: [], semantic: [JEV_CHECK] });
    const text = await run();
    expect(text).toMatch(/^ {2}pack\s+acme\/finance@1\.2\.0 {2}· {2}1 Jev check$/m);
    expect(text).not.toMatch(/more off/);
    expect(text).not.toMatch(/enabled\s+0 of/);
  });

  it("shows where a pack came from, since its id is only what it says it is", async () => {
    installPack({ id: "FailproofAI/policies", source: "github:acme/evil@v9.9.9" });
    const text = await run();
    expect(text).toContain("pack       FailproofAI/policies@1.2.0  ·  from github:acme/evil@v9.9.9");
  });

  it("does not say nothing is enforcing while a refused pack is denying", async () => {
    // The refusal fails CLOSED, so the generic "not enforcing" line would say
    // the opposite of what is happening. The pack is named, and so is the deny.
    installPack({ minCliVersion: "99.0.0" });
    const text = await run();
    expect(text).toContain("✕ acme/finance failed to load, so the calls it covers are denied.");
    expect(text).toContain("failproofai policies remove acme/finance");
    expect(text).not.toContain("Policies are not enforcing yet.");
  });

  it("puts the one attention line under the pack rows, and prints no Config footer", async () => {
    // Deliberately changed (decisions D14 and D6). This test used to pin a
    // `Config: <path>` footer with every warning printed after it. The design
    // has no footer and at most one ▲, which sits between the kv rows and the
    // first category. A pack has to be installed for an unknown key to BE
    // unknown — the names a `policyParams` key may use are the policies a pack
    // carries — and hooks wired, or "not enforcing" outranks it.
    wireClaude();
    installPack();
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: [], policyParams: { "not-a-policy": { x: 1 } } }),
    );
    const text = await run();
    const enabled = text.indexOf("enabled    2 of 2");
    const warn = text.indexOf('▲ Unknown policyParams key "not-a-policy", possibly a typo.');
    const heading = text.indexOf("FINANCE  2 of 2");
    expect(enabled).toBeGreaterThan(0);
    expect(warn).toBeGreaterThan(enabled);
    expect(heading).toBeGreaterThan(warn);
    expect(text).not.toContain("Config:");
  });

  it("does not call a parameter saved through the dashboard a typo", async () => {
    // The dashboard writes a pack policy's parameters under the pack-qualified
    // `pack/<id>/<name>` key, because that is the one the evaluator reads back —
    // a bare name is not unique across installed packs. This command checked
    // keys against BARE policy names only, so every parameter a user saved in
    // the UI was reported as a "possible typo" and shipped as a
    // `policy_params_validation_warning` event, while the key was in fact the
    // only spelling that takes effect. Same setup as the test below, which
    // proves the line would show here if the key were unknown.
    wireClaude();
    installPack();
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({
        enabledPolicies: [],
        policyParams: { "pack/acme/finance/block-big-refund": { limit: 5 } },
      }),
    );
    const text = await run();
    expect(text).not.toMatch(/Unknown policyParams key/);
    // Nothing at all between the kv rows and the first category.
    expect(text).toContain("enabled    2 of 2\n\nFINANCE  2 of 2");
  });

  it("still flags a key that names no installed policy", async () => {
    // The other half: widening the known set to both spellings must not turn
    // the typo warning off. A key qualified with a pack that is not installed
    // configures nothing, exactly like a misspelled bare name.
    wireClaude();
    installPack();
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({
        enabledPolicies: [],
        policyParams: { "pack/acme/finance/no-such-policy": { limit: 5 } },
      }),
    );
    const text = await run();
    expect(text).toContain('▲ Unknown policyParams key "pack/acme/finance/no-such-policy", possibly a typo.');
  });

  it("says nothing is enforcing on an empty machine, and what to run", async () => {
    // Deliberately changed (D14, D18): "nothing installed" and its paragraph
    // became the one generic line plus the design's next step. `config` is the
    // fix because setup is the guided path that wires the hooks.
    const text = await run();
    expect(text).toContain(
      [
        "▲ Policies are not enforcing yet.  ·  failproofai config",
        "  Turn on ours:  failproofai policies add FailproofAI/policies",
        // Ours first is a convenience, not a channel.
        "  Or anyone's:   failproofai policies add <owner>/<repo>",
      ].join("\n"),
    );
  });

  it("never runs past the terminal edge", async () => {
    installPack();
    const text = await run();
    for (const line of text.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});

describe("folding and --all", () => {
  it("folds off policies into one line per category, and points at --all", async () => {
    installPack({ enabled: ["block-big-refund"] });
    const text = await run();
    expect(text).toMatch(/^ {2}○ 1 more off$/m);
    expect(text).toContain("See all 2 with failproofai policies --all");
  });

  it("lists every policy under --all, the off ones by name, and folds nothing", async () => {
    installPack({ enabled: ["block-big-refund"] });
    const text = await run({ all: true });
    expect(text).toMatch(/● block-big-refund\s+Block big refunds/);
    expect(text).toMatch(/○ require-note\s+Require a note/);
    expect(text).not.toMatch(/more off/);
    expect(text).not.toContain("See all");
  });

  it("says nothing about --all when nothing is folded", async () => {
    installPack();
    const text = await run();
    expect(text).toMatch(/● require-note/);
    expect(text).not.toContain("See all");
  });

  it("folds a category with nothing on into its line alone", async () => {
    installPack({ enabled: [] });
    const text = await run();
    expect(text).toMatch(/^FINANCE {2}0 of 2\n {2}○ 2 more off$/m);
  });
});

describe("more than one pack", () => {
  const OTHER = {
    ...FINANCE,
    id: "acme/other",
    version: "0.1.0",
    source: "github:acme/other@v0.1.0",
    policies: [
      { name: "other-guard", description: "Guard something else", category: "Finance", defaultEnabled: true, match: {} },
    ],
  };

  it("names each pack once at the top", async () => {
    installPacks([FINANCE, OTHER]);
    const text = await run();
    expect(text).toMatch(/^ {2}pack\s+acme\/finance@1\.2\.0\n {2}pack\s+acme\/other@0\.1\.0\n {2}enabled\s+3 of 3$/m);
  });

  it("prefixes category headings with the pack id, so same-named categories stay apart", async () => {
    installPacks([FINANCE, OTHER]);
    const text = await run();
    expect(text).toMatch(/^ACME\/FINANCE · FINANCE {2}2 of 2$/m);
    expect(text).toMatch(/^ACME\/OTHER · FINANCE {2}1 of 1$/m);
  });

  it("keeps headings as designed beside a pack of Jev checks alone, which has no categories", async () => {
    installPacks([FINANCE, { ...OTHER, policies: [], semantic: [JEV_CHECK] }]);
    const text = await run();
    expect(text).toMatch(/^FINANCE {2}2 of 2$/m);
    expect(text).toMatch(/^ {2}pack\s+acme\/other@0\.1\.0 {2}· {2}1 Jev check$/m);
  });
});

describe("the other sources", () => {
  it("lists a custom policy file that is missing as a failed row, and says it is not running", async () => {
    wireClaude();
    installPack();
    const missing = join(project, "gone-policies.mjs");
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: [], customPoliciesPaths: [missing] }),
    );
    const text = await run();
    expect(text).toMatch(/^CUSTOM POLICIES$/m);
    expect(text).toMatch(new RegExp(`✕ ${missing.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s+not found`));
    expect(text).toContain("▲ A custom policy file was not found, so its policies are not running.");
  });

  it("warns about hooks in more than one scope when nothing is more severe", async () => {
    wireClaude();
    wireClaude(project);
    installPack();
    const text = await run();
    expect(text).toContain(
      "▲ Hooks are installed in multiple scopes: user, project.  ·  failproofai policies --uninstall --scope <scope>",
    );
  });

  it("lets the more severe line win, one attention line at most", async () => {
    // Unwired AND an unknown key: "not enforcing" is the line, never both.
    installPack();
    writeFileSync(
      join(home, "policies-config.json"),
      JSON.stringify({ enabledPolicies: [], policyParams: { "not-a-policy": { x: 1 } } }),
    );
    const text = await run();
    expect(text).toContain("▲ Policies are not enforcing yet.");
    expect(text).not.toContain("Unknown policyParams key");
    expect(text.match(/^[▲✕] /gm)).toHaveLength(1);
  });
});

describe("renderPoliciesScreen", () => {
  const strip = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");
  const SCREEN: PoliciesScreen = {
    packs: [
      {
        id: "FailproofAI/policies",
        version: "06b802b",
        source: "github:FailproofAI/policies@06b802b",
        observe: false,
        jevChecks: 0,
        policies: [
          { name: "sanitize-jwt", description: "Redact JWTs in tool output", category: "Sanitize", on: true },
          { name: "block-sudo", description: "Block sudo", category: "Dangerous Commands", on: true },
          { name: "block-rm-rf", description: "Block recursive force deletes", category: "Dangerous Commands", on: false },
          { name: "block-force-push", description: "Block force-pushing to any branch", category: "Git", on: false },
        ],
      },
    ],
    refused: [],
    attention: { failed: false, text: "Policies are not enforcing yet.", fix: "failproofai config" },
    custom: [],
    convention: [],
    cloud: null,
  };

  it("counts the builtins this build enforces itself when no pack is installed, naming none", async () => {
    // The migration shim: handler.ts registers enabledPolicies when no regex
    // pack is installed. Without this section the screen showed nothing for a
    // machine enforcing all of them, while config --status counted them.
    const { renderPoliciesScreen } = await import("@/src/hooks/manager");
    const lines = renderPoliciesScreen(
      {
        ...SCREEN,
        packs: [],
        attention: null,
        legacy: [
          { name: "block-sudo", description: "Block sudo" },
          { name: "block-rm-rf", description: "Block recursive force deletes" },
        ],
      },
      { version: "1.0.11", cols: 104, color: false },
    );
    expect(lines).toEqual([
      "failproof ai  v1.0.11  ·  Policies",
      "",
      "BUILT IN  2 on, from before packs",
      "  Move them into a pack:  failproofai policies add FailproofAI/policies",
    ]);
  });

  function withTruecolor<T>(fn: () => T): T {
    const before = { COLORTERM: process.env.COLORTERM, TERM: process.env.TERM, NO_COLOR: process.env.NO_COLOR };
    process.env.COLORTERM = "truecolor";
    process.env.TERM = "xterm-256color";
    delete process.env.NO_COLOR;
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("draws the design's screen, line for line, with colour off", async () => {
    const { renderPoliciesScreen } = await import("@/src/hooks/manager");
    expect(renderPoliciesScreen(SCREEN, { version: "1.0.11", cols: 104, color: false })).toEqual([
      "failproof ai  v1.0.11  ·  Policies",
      "",
      "  pack       FailproofAI/policies@06b802b",
      "  enabled    2 of 4",
      "",
      "▲ Policies are not enforcing yet.  ·  failproofai config",
      "",
      "SANITIZE  1 of 1",
      "  ● sanitize-jwt                    Redact JWTs in tool output",
      "",
      "DANGEROUS COMMANDS  1 of 2",
      "  ● block-sudo                      Block sudo",
      "  ○ 1 more off",
      "",
      "GIT  0 of 1",
      "  ○ 1 more off",
      "",
      "See all 4 with failproofai policies --all",
    ]);
  });

  it("prints no escape at all with colour off", async () => {
    const { renderPoliciesScreen } = await import("@/src/hooks/manager");
    const lines = renderPoliciesScreen(
      { ...SCREEN, packs: [{ ...SCREEN.packs[0], observe: true }] },
      { version: "1.0.11", color: false },
    );
    expect(lines.join("\n")).not.toContain("\x1B");
  });

  it("paints by role with colour on: mint on, grey off and tags, amber caution, pink commands", async () => {
    const { renderPoliciesScreen } = await import("@/src/hooks/manager");
    const lines = withTruecolor(() =>
      renderPoliciesScreen(
        { ...SCREEN, packs: [{ ...SCREEN.packs[0], observe: true }] },
        { version: "1.0.11", color: true },
      ),
    );
    const text = lines.join("\n");
    expect(text).toContain("\x1B[38;2;102;209;181m●\x1B[0m sanitize-jwt");
    expect(text).toContain("\x1B[38;2;118;127;139m○\x1B[0m 1 more off");
    expect(text).toContain("\x1B[38;2;118;127;139mobserve\x1B[0m");
    expect(text).toContain("\x1B[38;2;227;179;65m▲\x1B[0m Policies are not enforcing yet.");
    expect(text).toContain("\x1B[38;2;228;88;125mfailproofai policies --all\x1B[0m");
    // The same words underneath.
    expect(strip(text)).toContain("pack       FailproofAI/policies@06b802b  ·  observe");
  });

  it("sizes the name column from the names shown, at least the design's 32 and always two past the longest", async () => {
    const { renderPoliciesScreen } = await import("@/src/hooks/manager");
    const long = "require-no-conflicts-before-stop"; // the longest real name: 32
    const lines = renderPoliciesScreen(
      {
        ...SCREEN,
        attention: null,
        packs: [
          {
            ...SCREEN.packs[0],
            policies: [
              { name: long, description: "Require no merge conflicts before stopping", category: "Workflow", on: true },
              { name: "block-sudo", description: "Block sudo", category: "Dangerous Commands", on: true },
            ],
          },
        ],
      },
      { version: "1.0.11", color: false },
    );
    const row = lines.find((l) => l.includes(long))!;
    expect(row).toBe(`  ● ${long}  Require no merge conflicts before stopping`);
    // Every pack section shares the column, so descriptions line up down the screen.
    const sudo = lines.find((l) => l.includes("block-sudo"))!;
    expect(sudo.indexOf("Block sudo")).toBe(row.indexOf("Require no"));
  });

  it("shortens descriptions on a terminal and never a name", async () => {
    const { renderPoliciesScreen } = await import("@/src/hooks/manager");
    const fitted = renderPoliciesScreen(SCREEN, { version: "1.0.11", cols: 44, color: false, fit: true });
    const row = fitted.find((l) => l.includes("sanitize-jwt"))!;
    expect(row.startsWith("  ● sanitize-jwt")).toBe(true);
    expect(row.endsWith("…")).toBe(true);
    expect(visibleWidth(row)).toBeLessThanOrEqual(44);
    // A pipe keeps every word.
    const piped = renderPoliciesScreen(SCREEN, { version: "1.0.11", cols: 44, color: false });
    expect(piped.find((l) => l.includes("sanitize-jwt"))).toContain("Redact JWTs in tool output");
  });

  it("draws custom, convention and cloud sections in the same style", async () => {
    const { renderPoliciesScreen } = await import("@/src/hooks/manager");
    const text = renderPoliciesScreen(
      {
        ...SCREEN,
        packs: [],
        attention: null,
        custom: [
          { state: "on", name: "team-guard", description: "Guard the team" },
          { state: "failed", name: "/repo/broken.mjs", description: "failed to load" },
        ],
        convention: [{ scope: "project", rows: [{ state: "on", name: "team-policies.mjs", description: "2 hooks (1 off)" }] }],
        cloud: { deployment: 7, rows: [{ state: "on", name: "watch-only", description: "v1", tag: "observe" }] },
      },
      { version: "1.0.11", color: false },
    ).join("\n");
    expect(text).toMatch(/^CUSTOM POLICIES\n {2}● team-guard\s+Guard the team\n {2}✕ \/repo\/broken\.mjs\s+failed to load$/m);
    expect(text).toMatch(/^CONVENTION POLICIES {2}project\n {2}● team-policies\.mjs\s+2 hooks \(1 off\)$/m);
    expect(text).toMatch(/^CLOUD-MANAGED {2}deployment 7\n {2}● watch-only\s+v1 {2}· {2}observe$/m);
  });
});
