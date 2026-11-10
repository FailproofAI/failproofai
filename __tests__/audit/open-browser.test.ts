// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { openUrl } from "../../src/audit/open-browser";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

describe("openUrl", () => {
  it.each(["&", "|", "^"])("opens a Windows URL containing %s without cmd.exe", (character) => {
    const url = `https://cloud.example/cli/authorize?r=a${character}b`;
    openUrl(url, "win32");
    expect(spawn).toHaveBeenLastCalledWith(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", url],
      { stdio: "ignore", detached: true },
    );
  });
});
