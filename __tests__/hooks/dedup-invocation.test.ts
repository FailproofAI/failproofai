// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

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
    mkdirSync: vi.fn(),
    __resetMockStore: () => {
      mockStore = {};
    },
  };
});

describe("hooks/dedup-invocation", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const fs = await import("node:fs");
    (fs as unknown as { __resetMockStore: () => void }).__resetMockStore();
  });

  it("returns isDuplicate: false on first invocation", async () => {
    const { isDuplicateInvocation } = await import("../../src/hooks/dedup-invocation");
    const result = isDuplicateInvocation("claude", "PreToolUse", {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(result.isDuplicate).toBe(false);
  });

  it("returns isDuplicate: true when identical invocation occurs within deduplication window", async () => {
    const { isDuplicateInvocation, recordInvocation } = await import("../../src/hooks/dedup-invocation");
    const payload = {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };

    recordInvocation("claude", "PreToolUse", payload, 0);

    const check = isDuplicateInvocation("claude", "PreToolUse", payload);
    expect(check.isDuplicate).toBe(true);
    expect(check.exitCode).toBe(0);
  });

  it("returns isDuplicate: false when tool_input or session differs", async () => {
    const { isDuplicateInvocation, recordInvocation } = await import("../../src/hooks/dedup-invocation");
    const payload1 = {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    const payload2 = {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    };

    recordInvocation("claude", "PreToolUse", payload1, 0);

    const check = isDuplicateInvocation("claude", "PreToolUse", payload2);
    expect(check.isDuplicate).toBe(false);
  });
});
