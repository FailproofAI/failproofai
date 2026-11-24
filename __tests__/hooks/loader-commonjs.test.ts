/** Exercise rewritten modules in native Node, which has no global ESM require. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupTmpFiles, rewriteFileTree, TMP_SUFFIX } from "../../src/hooks/loader-utils";

describe("rewritten CommonJS policies under Node", () => {
  let dir: string;
  let temporaryFiles: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fpai-cjs-loader-"));
    temporaryFiles = [];
    vi.stubEnv("FAILPROOFAI_HOME", join(dir, "fp-home"));
    writeFileSync(join(dir, "dist.cjs"), "module.exports = { value: 8 };\n");
    writeFileSync(join(dir, "helper.cjs"), 'module.exports = require("failproofai").value;\n');
  });

  afterEach(async () => {
    await cleanupTmpFiles(temporaryFiles);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function importInNode(entry: string): Promise<unknown> {
    const dist = join(dir, "dist.cjs");
    temporaryFiles = await rewriteFileTree(entry, pathToFileURL(dist).href, dist);
    const rewrittenEntry = temporaryFiles.find((file) => file.startsWith(entry + TMP_SUFFIX));
    expect(rewrittenEntry).toBeDefined();
    const result = spawnSync("node", [
      "--input-type=module", "-e",
      "const loaded = await import(process.argv[1]); console.log(JSON.stringify(loaded.default));",
      pathToFileURL(rewrittenEntry!).href,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  it.each(["js", "cjs"])("preserves require and CommonJS globals in a .%s entry and its helper", async (extension) => {
    const entry = join(dir, `entry.${extension}`);
    writeFileSync(entry, [
      "#!/usr/bin/env node",
      'const { basename } = require("node:path");',
      'exports.value = require("./helper.cjs") + 1;',
      "exports.directory = basename(__dirname);",
    ].join("\n"));
    expect(await importInNode(entry)).toEqual({ value: 9, directory: basename(dir) });
  });

  it("keeps ESM .js imports working when a dependency is CommonJS", async () => {
    const entry = join(dir, "entry.js");
    writeFileSync(entry, 'import value from "./helper.cjs"; export default value + 1;\n');
    expect(await importInNode(entry)).toBe(9);
  });
});
