// @vitest-environment node
/**
 * Drift guard for scripts/prune-standalone.mjs.
 *
 * Next's file tracer over-collects: it emits the warning "whole project was
 * traced unintentionally" and sweeps repo directories into `.next/standalone`,
 * which `package.json` "files" then publishes. prune-standalone.mjs deletes
 * them again from a HAND-MAINTAINED denylist — so the moment someone adds a
 * top-level directory, it ships to every npm user and no test says a word.
 *
 * That is not hypothetical. `assets/` (612 KB of design lab) was shipping
 * unnoticed until a survey looked, and `target/` once made `npm pack` hang on
 * fifteen gigabytes of Rust build output.
 *
 * This test reads the script as TEXT rather than importing it, because the
 * module has no exports and executes on import (it exits 1 when
 * `.next/standalone` is absent). That is the same technique
 * `release-pipeline.test.ts` uses against the workflow YAML.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "prune-standalone.mjs"), "utf8");

/** Top-level directories the Next server genuinely needs at runtime, plus the
 *  build outputs it is assembled from. Everything else is repo content. */
const RUNTIME_NEEDED = new Set([".next", "node_modules", "public", "app", "lib"]);

function listed(constName: string): string[] {
  const block = SCRIPT.match(
    new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\n\\];`),
  );
  if (!block) throw new Error(`${constName} not found in prune-standalone.mjs`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("prune-standalone denylist", () => {
  const prunedDirs = listed("STANDALONE_ROOT_PRUNE");
  const prunedFiles = listed("STANDALONE_ROOT_PRUNE_FILES");

  it("accounts for every tracked top-level directory", () => {
    // `git ls-files --stage` rather than plain `ls-files`, because a SUBMODULE
    // is a gitlink (mode 160000) with no trailing path segment — plain
    // `ls-files` reports `skills` as if it were a file, so a directory-only
    // filter walks straight past it. That is exactly how the 544 KB `skills/`
    // submodule ended up in the published tarball unnoticed.
    const staged = execFileSync("git", ["ls-files", "--stage"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        return { mode: meta.split(" ")[0], path };
      });

    const tracked = new Set<string>();
    for (const { mode, path } of staged) {
      if (mode === "160000") tracked.add(path); // submodule gitlink
      else if (path.includes("/")) tracked.add(path.split("/")[0]);
    }

    const unaccounted = [...tracked].filter(
      (d) => !RUNTIME_NEEDED.has(d) && !prunedDirs.includes(d),
    );

    expect(
      unaccounted,
      `these top-level directories are neither needed at runtime nor pruned, ` +
        `so Next may trace them into the published tarball — add each to ` +
        `STANDALONE_ROOT_PRUNE or to RUNTIME_NEEDED in this test`,
    ).toEqual([]);
  });

  it("names no directory that no longer exists", () => {
    // A stale entry is harmless at runtime but rots the list into noise, which
    // is how the real gaps stay hidden. `.vscode`/`.idea` are editor dirs that
    // are legitimately absent from a clean checkout.
    const editorDirs = new Set([".vscode", ".idea", "design-docs"]);
    const present = new Set(readdirSync(ROOT));
    const stale = prunedDirs.filter(
      (d) => !present.has(d) && !editorDirs.has(d) && !d.startsWith("release-") && !d.startsWith("."),
    );
    expect(stale, "prune list names directories that do not exist").toEqual([]);
  });

  it("prunes the directories whose contents would be largest", () => {
    // These four are the ones that have actually caused damage.
    for (const d of ["target", "crates", "assets", "__tests__"]) {
      expect(prunedDirs, `${d} must stay in the prune list`).toContain(d);
    }
  });

  it("keeps the runtime entrypoint and app code", () => {
    for (const keep of ["public", "app", ".next", "node_modules"]) {
      expect(prunedDirs, `${keep} must never be pruned`).not.toContain(keep);
      expect(prunedFiles, `${keep} must never be pruned`).not.toContain(keep);
    }
  });
});
