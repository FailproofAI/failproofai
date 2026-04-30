// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";

describe("hooks/install-prompt", () => {
  const originalIsTTY = process.stdin.isTTY;
  const originalNoColor = process.env.NO_COLOR;
  const originalArgv = [...process.argv];

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    process.env.NO_COLOR = originalNoColor;
    process.argv = [...originalArgv];
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

  it("returns defaults in NO_COLOR mode even when stdin is a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    process.env.NO_COLOR = "1";
    const setRawMode = vi.fn();
    const resume = vi.fn();
    const pause = vi.fn();
    Object.assign(process.stdin, { setRawMode, resume, pause });

    const { promptPolicySelection } = await import("../../src/hooks/install-prompt");
    const selected = await promptPolicySelection();

    expect(selected).toContain("sanitize-jwt");
    expect(selected).toContain("protect-env-vars");
    expect(selected).toHaveLength(11);
    expect(setRawMode).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
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

    it("NO_COLOR warning output contains no ANSI sequences", async () => {
      process.env.NO_COLOR = "1";
      vi.doMock("../../src/hooks/integrations", async () => {
        const actual = await vi.importActual<typeof import("../../src/hooks/integrations")>(
          "../../src/hooks/integrations",
        );
        return {
          ...actual,
          detectInstalledClis: () => [],
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
      expect(logs[0]).toMatchInlineSnapshot(
        "\"Warning: no agent CLI binary found in PATH (claude, codex, copilot, cursor-agent). Defaulting to Claude Code; hooks will activate when an agent is installed.\"",
      );
      expect(logs[0]).not.toContain("\\u001b[");
    });
  });
});
