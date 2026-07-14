// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";

describe("hooks/install-prompt", () => {
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("returns default-enabled policies when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const { promptPolicySelection } = await import("../../src/hooks/install-prompt");
    const selected = await promptPolicySelection();

    expect(selected).toContain("sanitize-jwt");
    expect(selected).toContain("protect-env-vars");
    expect(selected).toContain("block-env-files");
    expect(selected).toContain("block-sudo");
    expect(selected).toContain("block-curl-pipe-sh");
    expect(selected).toContain("block-push-master");
    expect(selected).toContain("block-failproofai-commands");
    expect(selected).not.toContain("block-rm-rf");
    expect(selected).not.toContain("block-force-push");
    expect(selected).not.toContain("block-secrets-write");
    expect(selected).toHaveLength(11);
  });

  it("returns preSelected when stdin is not a TTY and preSelected is provided", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const { promptPolicySelection } = await import("../../src/hooks/install-prompt");
    const selected = await promptPolicySelection(["block-sudo", "block-rm-rf"]);

    expect(selected).toEqual(["block-sudo", "block-rm-rf"]);
  });

  describe("resolveTargetClis", () => {
    it("returns explicit cli list as-is regardless of action", async () => {
      const { resolveTargetClis } = await import("../../src/hooks/install-prompt");
      expect(await resolveTargetClis(["copilot"])).toEqual(["copilot"]);
      expect(await resolveTargetClis(["claude", "codex"], "uninstall")).toEqual([
        "claude",
        "codex",
      ]);
    });

    it("uses 'removing hooks from' wording when action=uninstall and one CLI is detected", async () => {
      vi.doMock("../../src/hooks/integrations", async () => {
        const actual = await vi.importActual<typeof import("../../src/hooks/integrations")>(
          "../../src/hooks/integrations",
        );
        return {
          ...actual,
          detectInstalledClis: () => ["copilot"],
        };
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m) => {
        logs.push(String(m));
      });
      vi.resetModules();
      const { resolveTargetClis } = await import("../../src/hooks/install-prompt");
      const result = await resolveTargetClis(undefined, "uninstall");
      spy.mockRestore();
      vi.doUnmock("../../src/hooks/integrations");
      vi.resetModules();
      expect(result).toEqual(["copilot"]);
      expect(logs.some((l) => l.includes("removing hooks from"))).toBe(true);
      expect(logs.some((l) => l.includes("installing hooks for"))).toBe(false);
    });

    it("uses 'installing hooks for' wording when action=install and one CLI is detected", async () => {
      vi.doMock("../../src/hooks/integrations", async () => {
        const actual = await vi.importActual<typeof import("../../src/hooks/integrations")>(
          "../../src/hooks/integrations",
        );
        return {
          ...actual,
          detectInstalledClis: () => ["copilot"],
        };
      });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m) => {
        logs.push(String(m));
      });
      vi.resetModules();
      const { resolveTargetClis } = await import("../../src/hooks/install-prompt");
      await resolveTargetClis(undefined, "install");
      spy.mockRestore();
      vi.doUnmock("../../src/hooks/integrations");
      vi.resetModules();
      expect(logs.some((l) => l.includes("installing hooks for"))).toBe(true);
    });

    it("non-TTY with multiple CLIs returns all detected (action-agnostic)", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });
      vi.doMock("../../src/hooks/integrations", async () => {
        const actual = await vi.importActual<typeof import("../../src/hooks/integrations")>(
          "../../src/hooks/integrations",
        );
        return {
          ...actual,
          detectInstalledClis: () => ["claude", "codex", "copilot", "cursor"],
        };
      });
      vi.resetModules();
      const { resolveTargetClis } = await import("../../src/hooks/install-prompt");
      const installResult = await resolveTargetClis(undefined, "install");
      const uninstallResult = await resolveTargetClis(undefined, "uninstall");
      vi.doUnmock("../../src/hooks/integrations");
      vi.resetModules();
      expect(installResult).toEqual(["claude", "codex", "copilot", "cursor"]);
      expect(uninstallResult).toEqual(["claude", "codex", "copilot", "cursor"]);
    });
  });

  describe("buildCliMenuOptions", () => {
    it("install action: detected first with aggregate row, then every undetected CLI", async () => {
      const { buildCliMenuOptions } = await import("../../src/hooks/install-prompt");
      const { options, undetected } = buildCliMenuOptions(
        ["claude", "codex"],
        "install",
      );

      // 1 aggregate "all" + 2 detected + 10 undetected
      expect(options).toHaveLength(13);
      expect(undetected).toEqual(["copilot", "cursor", "opencode", "pi", "hermes", "openclaw", "factory", "devin", "antigravity", "goose"]);

      expect(options[0]).toMatchObject({ isAll: true, detected: true, value: ["claude", "codex"] });
      expect(options[0].label).toBe("Install for all 2 detected");

      // Detected rows preserve order and carry detected=true
      expect(options.slice(1, 3)).toEqual([
        { label: "Claude Code",  value: ["claude"], detected: true,  isAll: false },
        { label: "OpenAI Codex", value: ["codex"],  detected: true,  isAll: false },
      ]);

      // Undetected rows carry detected=false
      const undetectedRows = options.slice(3);
      expect(undetectedRows.every((o) => !o.detected && !o.isAll)).toBe(true);
      expect(undetectedRows.map((o) => o.label)).toEqual([
        "GitHub Copilot",
        "Cursor Agent",
        "OpenCode",
        "Pi",
        "Hermes",
        "OpenClaw",
        "Factory Droid",
        "Devin CLI",
        "Antigravity CLI",
        "Goose",
      ]);
    });

    it("uninstall action: only detected rows, no undetected (and verb is 'Remove from')", async () => {
      const { buildCliMenuOptions } = await import("../../src/hooks/install-prompt");
      const { options, undetected } = buildCliMenuOptions(
        ["claude", "codex", "copilot"],
        "uninstall",
      );

      expect(undetected).toEqual([]);
      expect(options).toHaveLength(4); // 1 aggregate + 3 detected
      expect(options[0].label).toBe("Remove from all 3 detected");
      expect(options.every((o) => o.detected)).toBe(true);
    });

    it("install with all 12 detected: no aggregate-row needed beyond the standard one, no undetected section", async () => {
      const { buildCliMenuOptions } = await import("../../src/hooks/install-prompt");
      const { options, undetected } = buildCliMenuOptions(
        ["claude", "codex", "copilot", "cursor", "opencode", "pi", "hermes", "openclaw", "factory", "devin", "antigravity", "goose"],
        "install",
      );

      expect(undetected).toEqual([]);
      expect(options).toHaveLength(13); // aggregate + 12 detected
      expect(options[0].label).toBe("Install for all 12 detected");
    });

    it("install with 1 detected + many undetected: skips aggregate row (1 ≯ 1)", async () => {
      const { buildCliMenuOptions } = await import("../../src/hooks/install-prompt");
      const { options } = buildCliMenuOptions(["claude"], "install");

      // No aggregate when only 1 detected — first row is the detected CLI itself.
      expect(options[0]).toMatchObject({ label: "Claude Code", isAll: false });
      expect(options.filter((o) => o.isAll)).toEqual([]);
    });
  });
});
