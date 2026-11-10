/**
 * E2E: the commands that install or remove hooks keep `agents.selected` true
 * (decision D2), through the real binary.
 *
 * Unit tests drive installHooks/removeHooks directly; this is what proves
 * bin/failproofai.mjs asks them to. Each test gets its own HOME,
 * FAILPROOFAI_HOME, pack directory and working directory, so nothing here can
 * reach the developer's own config. No command below needs the network: no
 * policy name is fetched, and `policies add` resolves against a pack written to
 * disk first.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BINARY_PATH = resolve(REPO_ROOT, "bin/failproofai.mjs");
const TRACED = "✓ Goose is traced again, so failproofai config keeps its hooks.";
const UNTRACED = "✓ Goose is no longer traced, so failproofai config won't add its hooks back.";

let root: string;
let home: string;
let fpHome: string;
let packs: string;
let project: string;

function run(...args: string[]): { exitCode: number; stdout: string; stderr: string; lastLine: string } {
  const result = spawnSync("bun", [BINARY_PATH, ...args], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FAILPROOFAI_HOME: fpHome,
      FAILPROOFAI_PACK_DIR: packs,
      FAILPROOFAI_BINARY_OVERRIDE: BINARY_PATH,
      FAILPROOFAI_TELEMETRY_DISABLED: "1",
      NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  const stdout = (result.stdout ?? "").trim();
  return {
    exitCode: result.status ?? 1,
    stdout,
    stderr: (result.stderr ?? "").trim(),
    lastLine: stdout.split("\n").at(-1) ?? "",
  };
}

function writeSelection(selected: string[], seen: string[]): void {
  writeFileSync(join(fpHome, "config.json"), `${JSON.stringify({ agents: { selected, seen } }, null, 2)}\n`);
}
const selected = (): string[] =>
  (JSON.parse(readFileSync(join(fpHome, "config.json"), "utf8")) as { agents: { selected: string[] } }).agents.selected;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fp-e2e-agent-selection-"));
  home = join(root, "home");
  fpHome = join(root, "fp-home");
  packs = join(root, "packs");
  project = join(root, "project");
  for (const dir of [home, fpHome, packs, project]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("E2E: hook commands keep the agent selection true", () => {
  it("policies --install --cli goose traces Goose, and --uninstall stops tracing it", () => {
    writeSelection(["claude"], ["claude"]);

    const installed = run("policies", "--install", "--cli", "goose");
    expect(installed.exitCode, installed.stderr).toBe(0);
    expect(installed.lastLine).toBe(TRACED);
    expect(selected()).toEqual(["claude", "goose"]);

    const removed = run("policies", "--uninstall", "--cli", "goose");
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.lastLine).toBe(UNTRACED);
    expect(selected()).toEqual(["claude"]);
  });

  it("policies --uninstall --scope project leaves the selection alone", () => {
    writeSelection(["claude", "goose"], ["goose"]);
    expect(run("policies", "--install", "--cli", "goose", "--scope", "project").exitCode).toBe(0);
    const before = readFileSync(join(fpHome, "config.json"), "utf8");

    const removed = run("policies", "--uninstall", "--cli", "goose", "--scope", "project");
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.stdout).not.toContain("traced");
    expect(readFileSync(join(fpHome, "config.json"), "utf8")).toBe(before);
  });

  it("policies add <builtin> --cli goose traces Goose, and policies remove all stops tracing it", () => {
    // The bundled pack on disk, so the name resolves without a fetch.
    const artifact = "export const hooks = [];\n";
    const digest = createHash("sha256").update(artifact).digest("hex");
    mkdirSync(join(packs, "artifacts"), { recursive: true });
    writeFileSync(join(packs, "artifacts", `${digest}.mjs`), artifact);
    writeFileSync(
      join(packs, "installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        packs: [{
          id: "FailproofAI/policies",
          version: "1.2.0",
          source: "github:FailproofAI/policies@v1.2.0",
          entry: `artifacts/${digest}.mjs`,
          sha256: digest,
          policies: [{ name: "block-sudo", description: "does block-sudo", category: "Security", defaultEnabled: true, match: {} }],
        }],
      }),
    );
    writeSelection(["claude"], ["claude"]);

    const added = run("policies", "add", "block-sudo", "--cli", "goose");
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.lastLine).toBe(TRACED);
    expect(selected()).toEqual(["claude", "goose"]);

    const removed = run("policies", "remove", "all", "--cli", "goose");
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.lastLine).toBe(UNTRACED);
    expect(selected()).toEqual(["claude"]);
  });
});
