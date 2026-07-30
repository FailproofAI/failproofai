// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanClaudeSettings } from "../../scripts/postuninstall.mjs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  let mockStore: Record<string, string> = {};
  return {
    ...actual,
    existsSync: vi.fn((path: string) => path in mockStore),
    readFileSync: vi.fn((path: string) => mockStore[path] ?? "{}"),
    writeFileSync: vi.fn((path: string, content: string) => {
      mockStore[path] = content;
    }),
    __resetMockStore: () => {
      mockStore = {};
    },
    __setMockFile: (path: string, content: string) => {
      mockStore[path] = content;
    },
    __getMockFile: (path: string) => mockStore[path],
  };
});

describe("scripts/postuninstall", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const fs = await import("node:fs");
    (fs as unknown as { __resetMockStore: () => void }).__resetMockStore();
  });

  it("returns 0 when settings file does not exist", async () => {
    const count = cleanClaudeSettings("/nonexistent/settings.json");
    expect(count).toBe(0);
  });

  it("removes failproofai hook entries from Claude settings and writes clean file", async () => {
    const fs = await import("node:fs");
    const testPath = "/mock/.claude/settings.json";
    const initialSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "failproofai --hook PreToolUse",
                is_failproofai: true,
              },
            ],
          },
        ],
      },
    };
    (fs as unknown as { __setMockFile: (p: string, c: string) => void }).__setMockFile(
      testPath,
      JSON.stringify(initialSettings),
    );

    const count = cleanClaudeSettings(testPath);
    expect(count).toBe(1);

    const updatedRaw = (fs as unknown as { __getMockFile: (p: string) => string }).__getMockFile(testPath);
    const updated = JSON.parse(updatedRaw);
    expect(updated.hooks).toBeUndefined();
  });
});
