import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectList from "@/app/components/project-list";
import type { ProjectFolder } from "@/lib/projects";

// Mock next/link to render plain anchor
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// Mock next/navigation for useSearchParams, useRouter, usePathname
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/",
}));

// Mock lucide-react icons to simple spans
vi.mock("lucide-react", () => ({
  Folder: ({ className }: any) => <span data-testid="folder-icon" className={className} />,
  Search: ({ className }: any) => <span data-testid="search-icon" className={className} />,
  X: ({ className }: any) => <span data-testid="x-icon" className={className} />,
  Calendar: ({ className }: any) => <span data-testid="calendar-icon" className={className} />,
  ChevronLeft: ({ className }: any) => <span data-testid="chevron-left" className={className} />,
  ChevronRight: ({ className }: any) => <span data-testid="chevron-right" className={className} />,
  RefreshCw: ({ className }: any) => <span data-testid="refresh-icon" className={className} />,
}));

function makeFolders(count: number): ProjectFolder[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `-home-user-project${i}`,
    path: `/mock/.claude/projects/-home-user-project${i}`,
    isDirectory: true,
    lastModified: new Date(Date.now() - i * 86400000),
    lastModifiedFormatted: `Jun ${15 - i}, 2024`,
    cli: ["claude"],
  }));
}

describe("ProjectList", () => {
  it("renders project folders in table", () => {
    const folders = makeFolders(3);
    render(<ProjectList folders={folders} />);
    expect(screen.getByText("Agent Root")).toBeInTheDocument();
    expect(screen.getByText("/home/user/project0")).toBeInTheDocument();
    expect(screen.getByText("/home/user/project1")).toBeInTheDocument();
    expect(screen.getByText("/home/user/project2")).toBeInTheDocument();
  });

  it("decodes folder names for display", () => {
    const folders: ProjectFolder[] = [
      {
        name: "C--code-myapp",
        path: "/mock/C--code-myapp",
        isDirectory: true,
        lastModified: new Date(),
        lastModifiedFormatted: "Jun 15, 2024",
        cli: ["claude"],
      },
    ];
    render(<ProjectList folders={folders} />);
    expect(screen.getByText("C:/code/myapp")).toBeInTheDocument();
  });

  // Helper: find badges (span elements with title="Agent CLI: X") to disambiguate
  // from the new CLI filter dropdown's <option> elements (which share the same text).
  function badgeNodes(label: string): Element[] {
    return Array.from(document.querySelectorAll(`span[title="Agent CLI: ${label}"]`));
  }

  it("renders a Claude Code badge for cli=['claude']", () => {
    const folders = makeFolders(1);
    render(<ProjectList folders={folders} />);
    expect(badgeNodes("Claude Code")).toHaveLength(1);
    expect(badgeNodes("OpenAI Codex")).toHaveLength(0);
    expect(badgeNodes("GitHub Copilot")).toHaveLength(0);
  });

  it("renders an OpenAI Codex badge for cli=['codex']", () => {
    const folders: ProjectFolder[] = [
      {
        name: "-home-u-codex",
        path: "/home/u/codex",
        isDirectory: true,
        lastModified: new Date(),
        lastModifiedFormatted: "Jun 15, 2024",
        cli: ["codex"],
      },
    ];
    render(<ProjectList folders={folders} />);
    expect(badgeNodes("OpenAI Codex")).toHaveLength(1);
    expect(badgeNodes("Claude Code")).toHaveLength(0);
  });

  it("renders both badges when cli=['claude','codex']", () => {
    const folders: ProjectFolder[] = [
      {
        name: "-home-u-shared",
        path: "/mock/.claude/projects/-home-u-shared",
        isDirectory: true,
        lastModified: new Date(),
        lastModifiedFormatted: "Jun 15, 2024",
        cli: ["claude", "codex"],
      },
    ];
    render(<ProjectList folders={folders} />);
    expect(badgeNodes("Claude Code")).toHaveLength(1);
    expect(badgeNodes("OpenAI Codex")).toHaveLength(1);
  });

  it("renders a GitHub Copilot badge for cli=['copilot']", () => {
    const folders: ProjectFolder[] = [
      {
        name: "-home-u-copilot",
        path: "/home/u/copilot",
        isDirectory: true,
        lastModified: new Date(),
        lastModifiedFormatted: "Jun 15, 2024",
        cli: ["copilot"],
      },
    ];
    render(<ProjectList folders={folders} />);
    expect(badgeNodes("GitHub Copilot")).toHaveLength(1);
  });

  it("renders a Cursor Agent badge for cli=['cursor']", () => {
    const folders: ProjectFolder[] = [
      {
        name: "-home-u-cursor",
        path: "/home/u/cursor",
        isDirectory: true,
        lastModified: new Date(),
        lastModifiedFormatted: "Jun 15, 2024",
        cli: ["cursor"],
      },
    ];
    render(<ProjectList folders={folders} />);
    expect(badgeNodes("Cursor Agent")).toHaveLength(1);
  });

  it("renders all four badges when cli=['claude','codex','copilot','cursor']", () => {
    const folders: ProjectFolder[] = [
      {
        name: "-home-u-quad",
        path: "/home/u/quad",
        isDirectory: true,
        lastModified: new Date(),
        lastModifiedFormatted: "Jun 15, 2024",
        cli: ["claude", "codex", "copilot", "cursor"],
      },
    ];
    render(<ProjectList folders={folders} />);
    expect(badgeNodes("Claude Code")).toHaveLength(1);
    expect(badgeNodes("OpenAI Codex")).toHaveLength(1);
    expect(badgeNodes("GitHub Copilot")).toHaveLength(1);
    expect(badgeNodes("Cursor Agent")).toHaveLength(1);
  });

  it("renders an OpenCode badge for cli=['opencode']", () => {
    const folders: ProjectFolder[] = [
      {
        name: "-home-u-opencode",
        path: "/home/u/opencode",
        isDirectory: true,
        lastModified: new Date(),
        lastModifiedFormatted: "Jun 15, 2024",
        cli: ["opencode"],
      },
    ];
    render(<ProjectList folders={folders} />);
    expect(badgeNodes("OpenCode")).toHaveLength(1);
  });

  it("renders a Pi badge for cli=['pi']", () => {
    const folders: ProjectFolder[] = [
      {
        name: "-home-u-pi",
        path: "/home/u/pi",
        isDirectory: true,
        lastModified: new Date(),
        lastModifiedFormatted: "Jun 15, 2024",
        cli: ["pi"],
      },
    ];
    render(<ProjectList folders={folders} />);
    expect(badgeNodes("Pi")).toHaveLength(1);
  });

  it("renders all six badges when cli=['claude','codex','copilot','cursor','opencode','pi']", () => {
    const folders: ProjectFolder[] = [
      {
        name: "-home-u-six",
        path: "/home/u/six",
        isDirectory: true,
        lastModified: new Date(),
        lastModifiedFormatted: "Jun 15, 2024",
        cli: ["claude", "codex", "copilot", "cursor", "opencode", "pi"],
      },
    ];
    render(<ProjectList folders={folders} />);
    expect(badgeNodes("Claude Code")).toHaveLength(1);
    expect(badgeNodes("OpenAI Codex")).toHaveLength(1);
    expect(badgeNodes("GitHub Copilot")).toHaveLength(1);
    expect(badgeNodes("Cursor Agent")).toHaveLength(1);
    expect(badgeNodes("OpenCode")).toHaveLength(1);
    expect(badgeNodes("Pi")).toHaveLength(1);
  });

  it("links to /project/[name]", () => {
    const folders = makeFolders(1);
    render(<ProjectList folders={folders} />);
    const link = screen.getByText("/home/user/project0").closest("a");
    expect(link).toHaveAttribute("href", expect.stringContaining("/project/"));
  });

  it("shows empty state when no folders", () => {
    render(<ProjectList folders={[]} />);
    expect(screen.getByText("No projects found")).toBeInTheDocument();
  });

  it("keyword filtering with / to - normalization", async () => {
    const user = userEvent.setup();
    const folders = makeFolders(3);
    render(<ProjectList folders={folders} />);

    const input = screen.getByPlaceholderText("Enter keyword and press Enter");
    await user.type(input, "/home/user/project0{Enter}");

    expect(screen.getByText(/Showing 1-1 of 1 projects/)).toBeInTheDocument();
  });

  it("pagination (25 per page)", () => {
    const folders = makeFolders(30);
    render(<ProjectList folders={folders} />);
    expect(screen.getByText(/Showing 1-25 of 30 projects/)).toBeInTheDocument();
  });

  it("CLI filter dropdown shows All CLIs + each known CLI label", () => {
    render(<ProjectList folders={[]} />);
    const select = screen.getByLabelText("Filter by CLI") as HTMLSelectElement;
    const optionLabels = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionLabels).toEqual([
      "All CLIs",
      "Claude Code",
      "OpenAI Codex",
      "GitHub Copilot",
      "Cursor Agent",
      "OpenCode",
      "Pi",
      "Gemini CLI",
      "Hermes",
    ]);
  });

  it("CLI filter narrows the visible rows to the chosen CLI", async () => {
    const user = userEvent.setup();
    const mixed: ProjectFolder[] = [
      {
        name: "-home-u-claude-only",
        path: "/home/u/claude-only",
        isDirectory: true,
        lastModified: new Date("2026-04-01T00:00:00Z"),
        lastModifiedFormatted: "Apr 1",
        cli: ["claude"],
      },
      {
        name: "-home-u-codex-only",
        path: "/home/u/codex-only",
        isDirectory: true,
        lastModified: new Date("2026-04-02T00:00:00Z"),
        lastModifiedFormatted: "Apr 2",
        cli: ["codex"],
      },
      {
        name: "-home-u-copilot-only",
        path: "/home/u/copilot-only",
        isDirectory: true,
        lastModified: new Date("2026-04-03T00:00:00Z"),
        lastModifiedFormatted: "Apr 3",
        cli: ["copilot"],
      },
    ];
    render(<ProjectList folders={mixed} />);
    expect(screen.getByText(/Showing 1-3 of 3 projects/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by CLI"), "copilot");
    expect(screen.getByText(/Showing 1-1 of 1 projects/)).toBeInTheDocument();
    expect(screen.queryByText("/home/u/claude-only")).not.toBeInTheDocument();
    expect(screen.queryByText("/home/u/codex-only")).not.toBeInTheDocument();
    expect(screen.getByText("/home/u/copilot-only")).toBeInTheDocument();
  });

  it("CLI filter set to 'All CLIs' (empty value) shows all rows", async () => {
    const user = userEvent.setup();
    const mixed: ProjectFolder[] = [
      {
        name: "-home-u-claude",
        path: "/home/u/claude",
        isDirectory: true,
        lastModified: new Date(),
        cli: ["claude"],
      },
      {
        name: "-home-u-codex",
        path: "/home/u/codex",
        isDirectory: true,
        lastModified: new Date(),
        cli: ["codex"],
      },
    ];
    render(<ProjectList folders={mixed} />);
    const select = screen.getByLabelText("Filter by CLI");
    await user.selectOptions(select, "claude");
    expect(screen.getByText(/Showing 1-1 of 1 projects/)).toBeInTheDocument();
    await user.selectOptions(select, "");
    expect(screen.getByText(/Showing 1-2 of 2 projects/)).toBeInTheDocument();
  });

  it("CLI filter matches multi-CLI rows", async () => {
    const user = userEvent.setup();
    const folders: ProjectFolder[] = [
      {
        name: "-home-u-shared",
        path: "/home/u/shared",
        isDirectory: true,
        lastModified: new Date(),
        cli: ["claude", "copilot"],
      },
      {
        name: "-home-u-codex-only",
        path: "/home/u/codex-only",
        isDirectory: true,
        lastModified: new Date(),
        cli: ["codex"],
      },
    ];
    render(<ProjectList folders={folders} />);
    await user.selectOptions(screen.getByLabelText("Filter by CLI"), "copilot");
    // shared has copilot in its cli array; codex-only does not.
    // Path renders both as a link (Agent Root col) and plain text (Path col), hence getAllByText.
    expect(screen.getAllByText("/home/u/shared").length).toBeGreaterThan(0);
    expect(screen.queryByText("/home/u/codex-only")).not.toBeInTheDocument();
  });
});
