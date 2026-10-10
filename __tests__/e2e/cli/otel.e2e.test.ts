// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fpai-otel-bundle-"));
const home = join(root, "home");
const binary = join(root, "cli.mjs");
const repo = resolve(__dirname, "../../..");
// Like the installed tarball, external runtime deps sit next to the bundle.
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
mkdirSync(join(home, ".failproofai"), { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
writeFileSync(join(home, ".failproofai/credentials.json"), JSON.stringify({
  ingest: { url: "http://127.0.0.1:1/v1/events", key: "capture-test" },
}));
const original = '# original\nmodel = "test"\n[projects."/work"]\ntrust_level = "trusted"\n';
writeFileSync(join(home, ".codex/config.toml"), original);
const built = spawnSync("bun", ["build", "--target=node", "--format=esm", `--outfile=${binary}`,
  "bin/failproofai.mjs", "--external", "posthog-node", "--external", "sql.js"], {
  cwd: repo, encoding: "utf8", timeout: 30000,
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function cli(...args: string[]) {
  return spawnSync("node", [binary, "otel", ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, FAILPROOFAI_HOME: join(home, ".failproofai"),
      FAILPROOFAI_TELEMETRY_DISABLED: "1", FAILPROOFAI_INGEST_KEY: "", FAILPROOFAI_INGEST_URL: "" },
    encoding: "utf8", timeout: 15000,
  });
}

describe("OTEL standalone bundled CLI", () => {
  it("bundles JSONC and TOML without unresolved UMD relative imports", () => {
    expect(built.status, built.stderr).toBe(0);
    expect(existsSync(binary)).toBe(true);
    expect(cli("enable", "--help").status).toBe(0);
  });

  it("enables and restores Codex from a Node-run standalone bundle against an older/unreachable server", () => {
    const enabled = cli("enable", "codex", "--local", "--yes");
    expect(enabled.status, enabled.stderr + enabled.stdout).toBe(0);
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toContain("/v1/logs");
    const status = cli("status");
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("unknown");
    expect(status.stdout).toContain("local relay");
    const disabled = cli("disable", "all");
    expect(disabled.status, disabled.stderr + disabled.stdout).toBe(0);
    expect(readFileSync(join(home, ".codex/config.toml"), "utf8")).toBe(original);
  });
});
