// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies - must be before imports
vi.mock("fs/promises", () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("@/lib/paths", () => ({
  getClaudeProjectsPath: vi.fn(() => "/mock/.claude/projects"),
}));

vi.mock("@/lib/utils", () => ({
  formatDate: vi.fn((d: Date) => d.toISOString()),
}));

vi.mock("@/lib/runtime-cache", () => ({
  runtimeCache: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
}));

// Default Codex / Copilot / Cursor / OpenCode stubs return no projects — individual tests override via mockResolvedValueOnce.
vi.mock("@/lib/codex-projects", () => ({
  getCodexProjects: vi.fn(async () => []),
}));

vi.mock("@/lib/copilot-projects", () => ({
  getCopilotProjects: vi.fn(async () => []),
}));

vi.mock("@/lib/cursor-projects", () => ({
  getCursorProjects: vi.fn(async () => []),
}));

vi.mock("@/lib/opencode-projects", () => ({
  getOpenCodeProjects: vi.fn(async () => []),
}));

vi.mock("@/lib/pi-projects", () => ({
  getPiProjects: vi.fn(async () => []),
}));

// Mock hermes-projects too — getProjectFolders() calls getHermesProjects(),
// which does real ~/.hermes/state.db I/O; without this the suite is non-hermetic
// and fails on any box with a real gateway DB.
vi.mock("@/lib/hermes-projects", () => ({
  getHermesProjects: vi.fn(async () => []),
}));

// Antigravity reads the real ~/.gemini/antigravity-cli/brain dir; mock it to []
// so a developer's local Antigravity sessions don't leak into these assertions.
vi.mock("@/lib/antigravity-projects", () => ({
  getAntigravityProjects: vi.fn(async () => []),
}));

import { readdir, stat } from "fs/promises";
import { extractSessionId, getProjectFolders, getSessionFiles, type ProjectFolder } from "@/lib/projects";
import { getCodexProjects } from "@/lib/codex-projects";
import { getCopilotProjects } from "@/lib/copilot-projects";
import { getCursorProjects } from "@/lib/cursor-projects";
import { getOpenCodeProjects } from "@/lib/opencode-projects";
import { getPiProjects } from "@/lib/pi-projects";
import { getHermesProjects } from "@/lib/hermes-projects";

const mockGetCodexProjects = vi.mocked(getCodexProjects);
const mockGetCopilotProjects = vi.mocked(getCopilotProjects);
const mockGetCursorProjects = vi.mocked(getCursorProjects);
const mockGetOpenCodeProjects = vi.mocked(getOpenCodeProjects);
const mockGetPiProjects = vi.mocked(getPiProjects);
const mockGetHermesProjects = vi.mocked(getHermesProjects);

const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);

describe("extractSessionId", () => {
  it("extracts UUID from a valid .jsonl filename", () => {
    expect(extractSessionId("a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl")).toBe(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    );
  });

  it("returns undefined for non-UUID filenames", () => {
    expect(extractSessionId("not-a-uuid.jsonl")).toBeUndefined();
    expect(extractSessionId("readme.txt")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    const result = extractSessionId("A1B2C3D4-E5F6-7890-ABCD-EF1234567890.jsonl");
    expect(result).toBe("A1B2C3D4-E5F6-7890-ABCD-EF1234567890");
  });
});

describe("getProjectFolders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when directory doesn't exist", async () => {
    mockStat.mockRejectedValueOnce(new Error("ENOENT"));
    const result = await getProjectFolders();
    expect(result).toEqual([]);
  });

  it("returns empty array when path is not a directory", async () => {
    mockStat.mockResolvedValueOnce({
      isDirectory: () => false,
    } as any);
    const result = await getProjectFolders();
    expect(result).toEqual([]);
  });

  it("returns only directories (not files)", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "project-a", isDirectory: () => true, isFile: () => false } as any,
      { name: "file.txt", isDirectory: () => false, isFile: () => true } as any,
      { name: "project-b", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    // Stat calls for each directory
    mockStat
      .mockResolvedValueOnce({ mtime: new Date("2024-06-10T00:00:00Z") } as any)
      .mockResolvedValueOnce({ mtime: new Date("2024-06-15T00:00:00Z") } as any);

    const result = await getProjectFolders();
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.name)).toContain("project-a");
    expect(result.map((f) => f.name)).toContain("project-b");
  });

  it("sorts newest-first by mtime", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "old", isDirectory: () => true, isFile: () => false } as any,
      { name: "new", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat
      .mockResolvedValueOnce({ mtime: new Date("2024-01-01T00:00:00Z") } as any)
      .mockResolvedValueOnce({ mtime: new Date("2024-06-15T00:00:00Z") } as any);

    const result = await getProjectFolders();
    expect(result[0].name).toBe("new");
    expect(result[1].name).toBe("old");
  });

  it("uses fallback Date(0) when individual stat fails", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "broken", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockRejectedValueOnce(new Error("EACCES"));

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].lastModified.getTime()).toBe(0);
  });

  it("tags Claude folders with cli=['claude']", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-proj", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: new Date("2024-06-15T00:00:00Z") } as any);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["claude"]);
  });

  it("merges a Codex project with the same encoded name into one row with both badges", async () => {
    const claudeMtime = new Date("2024-01-01T00:00:00Z");
    const codexMtime = new Date("2026-06-15T00:00:00Z");
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-proj", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: claudeMtime } as any);
    mockGetCodexProjects.mockResolvedValueOnce([
      {
        name: "-home-u-proj",
        path: "/home/u/proj",
        isDirectory: true,
        lastModified: codexMtime,
        lastModifiedFormatted: codexMtime.toISOString(),
        cli: ["codex"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("-home-u-proj");
    expect(result[0].cli).toEqual(["claude", "codex"]);
    // Newer mtime wins
    expect(result[0].lastModified.getTime()).toBe(codexMtime.getTime());
    // Claude's path is preserved
    expect(result[0].path).toBe("/mock/.claude/projects/-home-u-proj");
  });

  it("includes Codex-only projects (no matching Claude folder)", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([] as any);
    mockGetCodexProjects.mockResolvedValueOnce([
      {
        name: "-home-u-codex-only",
        path: "/home/u/codex-only",
        isDirectory: true,
        lastModified: new Date("2026-06-15T00:00:00Z"),
        lastModifiedFormatted: "2026-06-15T00:00:00.000Z",
        cli: ["codex"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["codex"]);
    expect(result[0].path).toBe("/home/u/codex-only");
  });

  it("merges a Copilot project with the same encoded name into one row with both badges", async () => {
    const claudeMtime = new Date("2024-01-01T00:00:00Z");
    const copilotMtime = new Date("2026-06-15T00:00:00Z");
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-proj", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: claudeMtime } as any);
    mockGetCopilotProjects.mockResolvedValueOnce([
      {
        name: "-home-u-proj",
        path: "/home/u/proj",
        isDirectory: true,
        lastModified: copilotMtime,
        lastModifiedFormatted: copilotMtime.toISOString(),
        cli: ["copilot"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("-home-u-proj");
    expect(result[0].cli).toEqual(["claude", "copilot"]);
    // Newer mtime wins
    expect(result[0].lastModified.getTime()).toBe(copilotMtime.getTime());
    // Claude's path is preserved (it's the primary store)
    expect(result[0].path).toBe("/mock/.claude/projects/-home-u-proj");
  });

  it("merges Claude + Codex + Copilot rows that share an encoded name", async () => {
    const claudeMtime = new Date("2024-01-01T00:00:00Z");
    const codexMtime = new Date("2025-01-01T00:00:00Z");
    const copilotMtime = new Date("2026-06-15T00:00:00Z");
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-shared", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: claudeMtime } as any);
    mockGetCodexProjects.mockResolvedValueOnce([
      {
        name: "-home-u-shared",
        path: "/home/u/shared",
        isDirectory: true,
        lastModified: codexMtime,
        lastModifiedFormatted: codexMtime.toISOString(),
        cli: ["codex"],
      } satisfies ProjectFolder,
    ]);
    mockGetCopilotProjects.mockResolvedValueOnce([
      {
        name: "-home-u-shared",
        path: "/home/u/shared",
        isDirectory: true,
        lastModified: copilotMtime,
        lastModifiedFormatted: copilotMtime.toISOString(),
        cli: ["copilot"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["claude", "codex", "copilot"]);
    expect(result[0].lastModified.getTime()).toBe(copilotMtime.getTime());
  });

  it("merges Claude + Codex + Copilot + Cursor rows that share an encoded name", async () => {
    const claudeMtime = new Date("2024-01-01T00:00:00Z");
    const codexMtime = new Date("2025-01-01T00:00:00Z");
    const copilotMtime = new Date("2026-03-15T00:00:00Z");
    const cursorMtime = new Date("2026-06-15T00:00:00Z");
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-quad", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: claudeMtime } as any);
    mockGetCodexProjects.mockResolvedValueOnce([
      {
        name: "-home-u-quad",
        path: "/home/u/quad",
        isDirectory: true,
        lastModified: codexMtime,
        lastModifiedFormatted: codexMtime.toISOString(),
        cli: ["codex"],
      } satisfies ProjectFolder,
    ]);
    mockGetCopilotProjects.mockResolvedValueOnce([
      {
        name: "-home-u-quad",
        path: "/home/u/quad",
        isDirectory: true,
        lastModified: copilotMtime,
        lastModifiedFormatted: copilotMtime.toISOString(),
        cli: ["copilot"],
      } satisfies ProjectFolder,
    ]);
    mockGetCursorProjects.mockResolvedValueOnce([
      {
        name: "-home-u-quad",
        path: "/home/u/quad",
        isDirectory: true,
        lastModified: cursorMtime,
        lastModifiedFormatted: cursorMtime.toISOString(),
        cli: ["cursor"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["claude", "codex", "copilot", "cursor"]);
    // Newest mtime wins (cursor in this case).
    expect(result[0].lastModified.getTime()).toBe(cursorMtime.getTime());
  });

  it("includes Cursor-only projects (no matching Claude/Codex/Copilot folder)", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([] as any);
    mockGetCursorProjects.mockResolvedValueOnce([
      {
        name: "-home-u-cursor-only",
        path: "/home/u/cursor-only",
        isDirectory: true,
        lastModified: new Date("2026-06-15T00:00:00Z"),
        lastModifiedFormatted: "2026-06-15T00:00:00.000Z",
        cli: ["cursor"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["cursor"]);
    expect(result[0].path).toBe("/home/u/cursor-only");
  });

  it("merges Claude + Codex + Copilot + Cursor + Pi rows that share an encoded name", async () => {
    const claudeMtime = new Date("2024-01-01T00:00:00Z");
    const codexMtime = new Date("2025-01-01T00:00:00Z");
    const copilotMtime = new Date("2026-01-15T00:00:00Z");
    const cursorMtime = new Date("2026-04-15T00:00:00Z");
    const piMtime = new Date("2026-07-15T00:00:00Z");
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-five", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: claudeMtime } as any);
    mockGetCodexProjects.mockResolvedValueOnce([
      {
        name: "-home-u-five",
        path: "/home/u/five",
        isDirectory: true,
        lastModified: codexMtime,
        lastModifiedFormatted: codexMtime.toISOString(),
        cli: ["codex"],
      } satisfies ProjectFolder,
    ]);
    mockGetCopilotProjects.mockResolvedValueOnce([
      {
        name: "-home-u-five",
        path: "/home/u/five",
        isDirectory: true,
        lastModified: copilotMtime,
        lastModifiedFormatted: copilotMtime.toISOString(),
        cli: ["copilot"],
      } satisfies ProjectFolder,
    ]);
    mockGetCursorProjects.mockResolvedValueOnce([
      {
        name: "-home-u-five",
        path: "/home/u/five",
        isDirectory: true,
        lastModified: cursorMtime,
        lastModifiedFormatted: cursorMtime.toISOString(),
        cli: ["cursor"],
      } satisfies ProjectFolder,
    ]);
    mockGetPiProjects.mockResolvedValueOnce([
      {
        name: "-home-u-five",
        path: "/home/u/five",
        isDirectory: true,
        lastModified: piMtime,
        lastModifiedFormatted: piMtime.toISOString(),
        cli: ["pi"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["claude", "codex", "copilot", "cursor", "pi"]);
    // Newest mtime wins (Pi in this case).
    expect(result[0].lastModified.getTime()).toBe(piMtime.getTime());
  });

  it("merges Claude + Codex + Copilot + Cursor + OpenCode + Pi rows that share an encoded name (6-CLI parity)", async () => {
    const claudeMtime = new Date("2024-01-01T00:00:00Z");
    const codexMtime = new Date("2025-01-01T00:00:00Z");
    const copilotMtime = new Date("2026-01-15T00:00:00Z");
    const cursorMtime = new Date("2026-03-15T00:00:00Z");
    const opencodeMtime = new Date("2026-05-15T00:00:00Z");
    const piMtime = new Date("2026-08-15T00:00:00Z");
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-six", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: claudeMtime } as any);
    mockGetCodexProjects.mockResolvedValueOnce([
      {
        name: "-home-u-six",
        path: "/home/u/six",
        isDirectory: true,
        lastModified: codexMtime,
        lastModifiedFormatted: codexMtime.toISOString(),
        cli: ["codex"],
      } satisfies ProjectFolder,
    ]);
    mockGetCopilotProjects.mockResolvedValueOnce([
      {
        name: "-home-u-six",
        path: "/home/u/six",
        isDirectory: true,
        lastModified: copilotMtime,
        lastModifiedFormatted: copilotMtime.toISOString(),
        cli: ["copilot"],
      } satisfies ProjectFolder,
    ]);
    mockGetCursorProjects.mockResolvedValueOnce([
      {
        name: "-home-u-six",
        path: "/home/u/six",
        isDirectory: true,
        lastModified: cursorMtime,
        lastModifiedFormatted: cursorMtime.toISOString(),
        cli: ["cursor"],
      } satisfies ProjectFolder,
    ]);
    mockGetOpenCodeProjects.mockResolvedValueOnce([
      {
        name: "-home-u-six",
        path: "/home/u/six",
        isDirectory: true,
        lastModified: opencodeMtime,
        lastModifiedFormatted: opencodeMtime.toISOString(),
        cli: ["opencode"],
      } satisfies ProjectFolder,
    ]);
    mockGetPiProjects.mockResolvedValueOnce([
      {
        name: "-home-u-six",
        path: "/home/u/six",
        isDirectory: true,
        lastModified: piMtime,
        lastModifiedFormatted: piMtime.toISOString(),
        cli: ["pi"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    // Canonical merge order in mergeProjectFolders is the source-iteration order
    // in lib/projects.ts: claude → codex → copilot → cursor → opencode → pi.
    expect(result[0].cli).toEqual(["claude", "codex", "copilot", "cursor", "opencode", "pi"]);
    // Newest mtime wins (Pi in this case).
    expect(result[0].lastModified.getTime()).toBe(piMtime.getTime());
    // Claude's path is preserved as the primary store.
    expect(result[0].path).toBe("/mock/.claude/projects/-home-u-six");
  });

  it("includes OpenCode-only projects (no matching Claude/Codex/Copilot/Cursor/Pi folder)", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([] as any);
    mockGetOpenCodeProjects.mockResolvedValueOnce([
      {
        name: "-home-u-opencode-only",
        path: "/home/u/opencode-only",
        isDirectory: true,
        lastModified: new Date("2026-05-15T00:00:00Z"),
        lastModifiedFormatted: "2026-05-15T00:00:00.000Z",
        cli: ["opencode"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["opencode"]);
    expect(result[0].path).toBe("/home/u/opencode-only");
  });

  it("includes Pi-only projects (no matching Claude/Codex/Copilot/Cursor folder)", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([] as any);
    mockGetPiProjects.mockResolvedValueOnce([
      {
        name: "-home-u-pi-only",
        path: "/home/u/pi-only",
        isDirectory: true,
        lastModified: new Date("2026-07-15T00:00:00Z"),
        lastModifiedFormatted: "2026-07-15T00:00:00.000Z",
        cli: ["pi"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["pi"]);
    expect(result[0].path).toBe("/home/u/pi-only");
  });

  it("falls back gracefully when getPiProjects rejects", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-claude", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: new Date("2026-04-01T00:00:00Z") } as any);
    mockGetPiProjects.mockRejectedValueOnce(new Error("scan failed"));

    const result = await getProjectFolders();
    // Claude row still surfaces even though Pi scan blew up.
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["claude"]);
  });

  it("surfaces a standalone Hermes project", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([] as any);
    mockGetHermesProjects.mockResolvedValueOnce([
      {
        name: "hermes-slack",
        path: "hermes:slack",
        isDirectory: true,
        lastModified: new Date("2026-08-16T00:00:00Z"),
        lastModifiedFormatted: "2026-08-16T00:00:00.000Z",
        cli: ["hermes"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["hermes"]);
    expect(result[0].path).toBe("hermes:slack");
  });

  it("falls back gracefully when getCursorProjects rejects", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-claude", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: new Date("2026-04-01T00:00:00Z") } as any);
    mockGetCursorProjects.mockRejectedValueOnce(new Error("scan failed"));

    const result = await getProjectFolders();
    // Claude row still surfaces even though Cursor scan blew up.
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["claude"]);
  });

  it("includes Copilot-only projects (no matching Claude or Codex folder)", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([] as any);
    mockGetCopilotProjects.mockResolvedValueOnce([
      {
        name: "-home-u-copilot-only",
        path: "/home/u/copilot-only",
        isDirectory: true,
        lastModified: new Date("2026-06-15T00:00:00Z"),
        lastModifiedFormatted: "2026-06-15T00:00:00.000Z",
        cli: ["copilot"],
      } satisfies ProjectFolder,
    ]);

    const result = await getProjectFolders();
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["copilot"]);
    expect(result[0].path).toBe("/home/u/copilot-only");
  });

  it("falls back gracefully when getCopilotProjects rejects", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      { name: "-home-u-claude", isDirectory: () => true, isFile: () => false } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: new Date("2026-04-01T00:00:00Z") } as any);
    mockGetCopilotProjects.mockRejectedValueOnce(new Error("scan failed"));

    const result = await getProjectFolders();
    // Claude row still surfaces even though Copilot scan blew up.
    expect(result).toHaveLength(1);
    expect(result[0].cli).toEqual(["claude"]);
  });
});

describe("getSessionFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only .jsonl files with valid UUID in name", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      {
        name: "a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl",
        isFile: () => true,
        isDirectory: () => false,
      } as any,
      { name: "not-uuid.jsonl", isFile: () => true, isDirectory: () => false } as any,
      { name: "readme.txt", isFile: () => true, isDirectory: () => false } as any,
      { name: "subfolder", isFile: () => false, isDirectory: () => true } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: new Date("2024-06-15T00:00:00Z") } as any);

    const result = await getSessionFiles("/some/path");
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("extracts sessionId into result", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      {
        name: "11111111-2222-3333-4444-555555555555.jsonl",
        isFile: () => true,
        isDirectory: () => false,
      } as any,
    ] as any);
    mockStat.mockResolvedValueOnce({ mtime: new Date("2024-06-15T00:00:00Z") } as any);

    const result = await getSessionFiles("/some/path");
    expect(result[0].sessionId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("sorts newest-first", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as any);
    mockReaddir.mockResolvedValueOnce([
      {
        name: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
        isFile: () => true,
        isDirectory: () => false,
      } as any,
      {
        name: "11111111-2222-3333-4444-555555555555.jsonl",
        isFile: () => true,
        isDirectory: () => false,
      } as any,
    ] as any);
    mockStat
      .mockResolvedValueOnce({ mtime: new Date("2024-01-01T00:00:00Z") } as any)
      .mockResolvedValueOnce({ mtime: new Date("2024-06-15T00:00:00Z") } as any);

    const result = await getSessionFiles("/some/path");
    expect(result[0].lastModified.getTime()).toBeGreaterThan(
      result[1].lastModified.getTime()
    );
  });

  it("returns empty array for missing directory", async () => {
    mockStat.mockRejectedValueOnce(new Error("ENOENT"));
    const result = await getSessionFiles("/nonexistent");
    expect(result).toEqual([]);
  });
});
