// @vitest-environment node
import { describe, it, expect } from "vitest";

import { resolveCwd } from "../../src/hooks/resolve-cwd";
import type { IntegrationType } from "../../src/hooks/types";

const ALL_CLIS: IntegrationType[] = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "pi",
  "opencode",
];

const NON_CURSOR_CLIS: IntegrationType[] = ALL_CLIS.filter((c) => c !== "cursor");

describe("resolveCwd", () => {
  describe("stdin passthrough (every CLI)", () => {
    it.each(ALL_CLIS)("returns parsed.cwd verbatim when set (%s)", (cli) => {
      const out = resolveCwd(cli, { cwd: "/repo/foo" });
      expect(out).toBe("/repo/foo");
    });
  });

  describe("Cursor-specific workspace_roots fallback", () => {
    it("returns workspace_roots[0] when parsed.cwd is absent", () => {
      const out = resolveCwd("cursor", { workspace_roots: ["/repo/cursor"] });
      expect(out).toBe("/repo/cursor");
    });

    it("returns workspace_roots[0] when parsed.cwd is empty string", () => {
      const out = resolveCwd("cursor", { cwd: "", workspace_roots: ["/repo/cursor"] });
      expect(out).toBe("/repo/cursor");
    });

    it("uses the first entry when workspace_roots has multiple paths", () => {
      const out = resolveCwd("cursor", { workspace_roots: ["/first", "/second"] });
      expect(out).toBe("/first");
    });

    it("returns undefined when workspace_roots is empty array", () => {
      const out = resolveCwd("cursor", { workspace_roots: [] });
      expect(out).toBeUndefined();
    });

    it("returns undefined when workspace_roots[0] is empty string", () => {
      const out = resolveCwd("cursor", { workspace_roots: [""] });
      expect(out).toBeUndefined();
    });

    it("returns undefined when workspace_roots[0] is non-string", () => {
      const out = resolveCwd("cursor", { workspace_roots: [123] });
      expect(out).toBeUndefined();
    });

    it("returns undefined when workspace_roots is not an array", () => {
      const out = resolveCwd("cursor", { workspace_roots: "/repo/cursor" });
      expect(out).toBeUndefined();
    });

    it("returns undefined when both cwd and workspace_roots are absent", () => {
      const out = resolveCwd("cursor", {});
      expect(out).toBeUndefined();
    });
  });

  describe("non-Cursor CLIs ignore workspace_roots", () => {
    it.each(NON_CURSOR_CLIS)(
      "returns undefined when only workspace_roots is present (%s)",
      (cli) => {
        const out = resolveCwd(cli, { workspace_roots: ["/from-roots"] });
        expect(out).toBeUndefined();
      },
    );
  });

  describe("runtime type guards", () => {
    it("ignores a non-string parsed.cwd and falls back to undefined for non-cursor", () => {
      const out = resolveCwd("claude", { cwd: 42 as unknown as string });
      expect(out).toBeUndefined();
    });

    it("ignores a non-string parsed.cwd and falls back to workspace_roots for cursor", () => {
      const out = resolveCwd("cursor", {
        cwd: 42 as unknown as string,
        workspace_roots: ["/repo/cursor"],
      });
      expect(out).toBe("/repo/cursor");
    });

    it("treats empty-string parsed.cwd as missing (every CLI)", () => {
      for (const cli of NON_CURSOR_CLIS) {
        expect(resolveCwd(cli, { cwd: "" })).toBeUndefined();
      }
    });
  });

  describe("stdin precedence beats workspace_roots fallback", () => {
    it("trusts cwd even when workspace_roots is also set (cursor)", () => {
      const out = resolveCwd("cursor", {
        cwd: "/from-cwd",
        workspace_roots: ["/from-roots"],
      });
      expect(out).toBe("/from-cwd");
    });
  });
});
