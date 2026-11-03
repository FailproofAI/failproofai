// @vitest-environment node
/**
 * Which entry shapes count as "imports a relative file".
 *
 * `publish` and `build` are the only two outcomes for a multi-file entry, and
 * they have to agree: publish BUNDLES it into the one artifact a pack has to be,
 * build REFUSES it because only the entry file is digest-pinned. A shape neither
 * recognises is bundled by neither and refused by neither, and what the author
 * sees instead is whatever the loader's rewrite makes of it — an esbuild parse
 * error naming a token, with no mention of a file or a fix.
 *
 * That is not hypothetical: the real FailproofAI/jev-policies entry is two bare
 * side-effect imports, because each half of the pack registers at module scope
 * and there is nothing to name afterwards. Publishing it failed with
 * `Expected "from" but found "{"`, pointing at a file that parses fine on its
 * own.
 */
import { describe, it, expect } from "vitest";

import { firstRelativeSpecifier } from "@/src/hooks/pack-cli";

describe("firstRelativeSpecifier", () => {
  it("finds a bare side-effect import, which has no `from` at all", () => {
    // The shape the real pack entry uses, and the one that shipped broken.
    expect(firstRelativeSpecifier(`import "./policies/regex";\n`)).toBe("./policies/regex");
    expect(firstRelativeSpecifier(`import './a'\n`)).toBe("./a");
    expect(firstRelativeSpecifier(`import "../sibling/x";\n`)).toBe("../sibling/x");
  });

  it("finds a named import whose `from` is on another line", () => {
    // A long import list wraps. The previous detector used `[^;\n]*`, which
    // cannot cross the newline, so this read as having no relative import.
    const source = [
      "import {",
      "  getCommand,",
      "  getFilePath,",
      "  parseArgvTokens,",
      '} from "./shared";',
    ].join("\n");
    expect(firstRelativeSpecifier(source)).toBe("./shared");
  });

  it("finds single-line, default, namespace and re-export forms", () => {
    expect(firstRelativeSpecifier(`import { a } from "./x";`)).toBe("./x");
    expect(firstRelativeSpecifier(`import a from "./x";`)).toBe("./x");
    expect(firstRelativeSpecifier(`import * as a from "./x";`)).toBe("./x");
    expect(firstRelativeSpecifier(`export { a } from "./x";`)).toBe("./x");
    expect(firstRelativeSpecifier(`export * from "./x";`)).toBe("./x");
    expect(firstRelativeSpecifier(`import type { T } from "./x";`)).toBe("./x");
  });

  it("finds dynamic import and require, which the loader also rewrites", () => {
    expect(firstRelativeSpecifier(`const m = await import("./x");`)).toBe("./x");
    expect(firstRelativeSpecifier(`const m = require("./x");`)).toBe("./x");
  });

  it("says nothing for an entry that imports only packages", () => {
    const source = [
      'import { customPolicies, allow, deny } from "failproofai";',
      'import { execFileSync } from "node:child_process";',
      'import {',
      '  readFile,',
      '  writeFile,',
      '} from "node:fs/promises";',
      'const m = await import("node:path");',
    ].join("\n");
    expect(firstRelativeSpecifier(source)).toBeNull();
  });

  it("is not fooled by a bare package whose name merely starts with a dot elsewhere", () => {
    // `.` has to be the first character of the SPECIFIER, not appear in it.
    expect(firstRelativeSpecifier(`import { a } from "pkg/sub.js";`)).toBeNull();
    expect(firstRelativeSpecifier(`import { a } from "@scope/pkg.name";`)).toBeNull();
  });

  it("finds the relative one when a package import comes first without a semicolon", () => {
    // Over-reaching past an ASI-style statement boundary is acceptable: the
    // answer is only ever used as "is there a relative import, and name one",
    // and there is one here.
    const source = ['import { a } from "failproofai"', 'import { b } from "./local"'].join("\n");
    expect(firstRelativeSpecifier(source)).toBe("./local");
  });
});
