// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  checkVersions,
  extractTomlTable,
  readTomlString,
  inheritsWorkspaceVersion,
  FORBIDDEN_LIFECYCLE_SCRIPTS,
} from "@/scripts/check-versions.mjs";

type Violation = { file: string; message: string };

const ROOT_VERSION = "0.0.16-beta.0";

let root: string;

/** Write a package.json at the fixture root. */
function writeRootPkg(extra: Record<string, unknown> = {}) {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "failproofai", version: ROOT_VERSION, ...extra }, null, 2),
  );
}

function writeCargo(version: string = ROOT_VERSION) {
  writeFileSync(
    join(root, "Cargo.toml"),
    [
      "[workspace]",
      'resolver = "3"',
      'members = ["crates/*"]',
      "",
      "[workspace.package]",
      `version = "${version}"`,
      'edition = "2024"',
      "",
    ].join("\n"),
  );
}

function writeCrate(name: string, manifestBody: string) {
  mkdirSync(join(root, "crates", name), { recursive: true });
  writeFileSync(join(root, "crates", name, "Cargo.toml"), manifestBody);
}

function messages(violations: Violation[]) {
  return violations.map((v) => `${v.file}: ${v.message}`).join("\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-versions-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkVersions — the consistent case", () => {
  it("passes with only a root package.json (no packages/, no Cargo.toml)", () => {
    writeRootPkg();
    expect(checkVersions(root)).toEqual([]);
  });

  it("passes with a matching Cargo workspace and a crate that inherits", () => {
    writeRootPkg();
    writeCargo();
    writeCrate(
      "fpai-ipc",
      ['[package]', 'name = "fpai-ipc"', "version.workspace = true", "edition.workspace = true", ""].join("\n"),
    );
    expect(checkVersions(root)).toEqual([]);
  });

  it("passes with matching packages/* and wrapper optionalDependencies", () => {
    writeRootPkg();
    mkdirSync(join(root, "packages", "wrapper"), { recursive: true });
    writeFileSync(
      join(root, "packages", "wrapper", "package.json"),
      JSON.stringify({
        name: "wrapper",
        version: ROOT_VERSION,
        optionalDependencies: { "failproofai-linux-x64": ROOT_VERSION },
      }),
    );
    expect(checkVersions(root)).toEqual([]);
  });

  it("accepts developer-local pre-hooks like predev/prestart", () => {
    // These are pre-hooks for named scripts. npm never runs them on install,
    // pack or publish, so they are not lifecycle scripts and must not fail.
    writeRootPkg({ scripts: { predev: "bun run build:cli", prestart: "bun run build:cli", dev: "x", start: "y" } });
    expect(checkVersions(root)).toEqual([]);
  });
});

describe("checkVersions — absent optional trees are not errors", () => {
  it("does not error when packages/ is absent", () => {
    writeRootPkg();
    const violations: Violation[] = checkVersions(root);
    expect(violations).toEqual([]);
    expect(messages(violations)).not.toContain("packages/");
  });

  it("does not error when Cargo.toml is absent", () => {
    writeRootPkg();
    const violations: Violation[] = checkVersions(root);
    expect(violations).toEqual([]);
    expect(messages(violations)).not.toContain("Cargo.toml");
  });

  it("does not error when crates/ exists but holds no crate", () => {
    writeRootPkg();
    writeCargo();
    mkdirSync(join(root, "crates"), { recursive: true });
    writeFileSync(join(root, "crates", ".gitkeep"), "");
    expect(checkVersions(root)).toEqual([]);
  });
});

describe("checkVersions — packages/*", () => {
  it("fails when a packages/* version does not match root", () => {
    writeRootPkg();
    mkdirSync(join(root, "packages", "wrapper"), { recursive: true });
    writeFileSync(
      join(root, "packages", "wrapper", "package.json"),
      JSON.stringify({ name: "wrapper", version: "0.0.15-beta.1" }),
    );

    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("packages/wrapper/package.json");
    expect(violations[0].message).toContain("0.0.15-beta.1");
    expect(violations[0].message).toContain(ROOT_VERSION);
  });

  it("fails when a wrapper optionalDependency does not match root", () => {
    writeRootPkg();
    mkdirSync(join(root, "packages", "wrapper"), { recursive: true });
    writeFileSync(
      join(root, "packages", "wrapper", "package.json"),
      JSON.stringify({
        name: "wrapper",
        version: ROOT_VERSION,
        optionalDependencies: {
          "failproofai-linux-x64": ROOT_VERSION,
          "failproofai-darwin-arm64": "0.0.14",
        },
      }),
    );

    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("packages/wrapper/package.json");
    expect(violations[0].message).toContain("failproofai-darwin-arm64");
    expect(violations[0].message).toContain("0.0.14");
  });
});

describe("checkVersions — Cargo workspace", () => {
  it("fails when the workspace version does not match root package.json", () => {
    writeRootPkg();
    writeCargo("0.1.0");

    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("Cargo.toml");
    expect(violations[0].message).toContain("0.1.0");
    expect(violations[0].message).toContain(ROOT_VERSION);
  });

  it("fails when Cargo.toml declares no [workspace.package] version", () => {
    writeRootPkg();
    writeFileSync(join(root, "Cargo.toml"), '[workspace]\nresolver = "3"\nmembers = []\n');

    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("Cargo.toml");
    expect(violations[0].message).toContain("workspace.package");
  });

  it("ignores a `#` comment after the version value", () => {
    writeRootPkg();
    writeFileSync(
      join(root, "Cargo.toml"),
      `[workspace.package]\nversion = "${ROOT_VERSION}" # keep in sync with package.json\n`,
    );
    expect(checkVersions(root)).toEqual([]);
  });
});

describe("checkVersions — crate version inheritance", () => {
  it("fails when a crate pins a literal version", () => {
    writeRootPkg();
    writeCargo();
    writeCrate(
      "failproofaid",
      ['[package]', 'name = "failproofaid"', `version = "${ROOT_VERSION}"`, ""].join("\n"),
    );

    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("crates/failproofaid/Cargo.toml");
    expect(violations[0].message).toContain("version.workspace = true");
  });

  it("fails a literal version even when it currently equals the root version", () => {
    // The point is drift-resistance, not today's equality — a matching literal
    // is exactly the one that silently goes stale on the next bump.
    writeRootPkg();
    writeCargo();
    writeCrate("fpai-canon", `[package]\nname = "fpai-canon"\nversion = "${ROOT_VERSION}"\n`);
    expect(checkVersions(root)).toHaveLength(1);
  });

  it("accepts the inline table spelling `version = { workspace = true }`", () => {
    writeRootPkg();
    writeCargo();
    writeCrate("fpai-canon", '[package]\nname = "fpai-canon"\nversion = { workspace = true }\n');
    expect(checkVersions(root)).toEqual([]);
  });

  it("fails when a crate declares no version at all", () => {
    writeRootPkg();
    writeCargo();
    writeCrate("fpai-ipc", '[package]\nname = "fpai-ipc"\nedition.workspace = true\n');

    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("version.workspace = true");
  });
});

describe("checkVersions — lifecycle scripts", () => {
  it("fails when `prepare` is re-added", () => {
    writeRootPkg({ scripts: { build: "bun build", prepare: "bun run build" } });

    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("package.json");
    expect(violations[0].message).toContain("prepare");
  });

  it.each(FORBIDDEN_LIFECYCLE_SCRIPTS as string[])("fails when `%s` is declared", (name) => {
    writeRootPkg({ scripts: { [name]: "echo hi" } });

    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain(name);
  });

  it("reports one violation per declared lifecycle script", () => {
    writeRootPkg({ scripts: { prepare: "x", postinstall: "y", prepack: "z" } });
    expect(checkVersions(root)).toHaveLength(3);
  });

  it("covers every lifecycle script npm runs on install, pack or publish", () => {
    expect(FORBIDDEN_LIFECYCLE_SCRIPTS).toEqual([
      "prepare",
      "prepublish",
      "prepublishOnly",
      "prepack",
      "postpack",
      "preinstall",
      "install",
      "postinstall",
    ]);
  });
});

describe("checkVersions — malformed input", () => {
  it("reports a missing root package.json rather than throwing", () => {
    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("No package.json");
  });

  it("reports an unparseable root package.json rather than throwing", () => {
    writeFileSync(join(root, "package.json"), "{ not json");
    const violations: Violation[] = checkVersions(root);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("Could not parse");
  });
});

describe("the minimal TOML helpers", () => {
  it("extracts a table body and stops at the next table header", () => {
    const src = '[workspace.package]\nversion = "1.0.0"\n\n[profile.release]\nlto = "thin"\n';
    expect(extractTomlTable(src, "workspace.package")).toContain('version = "1.0.0"');
    expect(extractTomlTable(src, "workspace.package")).not.toContain("lto");
  });

  it("returns null for an absent table", () => {
    expect(extractTomlTable('[workspace]\nmembers = []\n', "workspace.package")).toBeNull();
  });

  it("does not treat a `#` inside a quoted value as a comment", () => {
    const src = '[workspace.package]\nrepository = "https://example.com/a#b"\n';
    expect(readTomlString(src, "workspace.package", "repository")).toBe("https://example.com/a#b");
  });

  it("does not confuse `rust-version` with `version`", () => {
    const src = '[workspace.package]\nrust-version = "1.90"\nversion = "0.2.0"\n';
    expect(readTomlString(src, "workspace.package", "version")).toBe("0.2.0");
  });

  it("recognises both workspace-inheritance spellings and rejects a literal", () => {
    expect(inheritsWorkspaceVersion("[package]\nversion.workspace = true\n")).toBe(true);
    expect(inheritsWorkspaceVersion("[package]\nversion = { workspace = true }\n")).toBe(true);
    expect(inheritsWorkspaceVersion('[package]\nversion = "1.2.3"\n')).toBe(false);
  });
});

describe("the repository's own state", () => {
  it("passes against the real repository root", () => {
    // The gate is only worth having if it is green on `main`. This is the same
    // assertion CI makes, run in-process so a local break is caught before push.
    const repoRoot = join(__dirname, "..", "..");
    expect(checkVersions(repoRoot)).toEqual([]);
  });
});
