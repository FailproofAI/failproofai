import { describe, it, expect, vi, beforeEach } from "vitest";
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

// Mock lucide-react icons to simple spans.
// NOTE: this is a closed whitelist — an icon imported by the component but
// missing here resolves to `undefined` and React throws "Element type is
// invalid", failing EVERY test in this file with an error that points at the
// component rather than at this mock. Add new icons here.
vi.mock("lucide-react", () => ({
  Folder: ({ className }: any) => <span data-testid="folder-icon" className={className} />,
  Search: ({ className }: any) => <span data-testid="search-icon" className={className} />,
  X: ({ className }: any) => <span data-testid="x-icon" className={className} />,
  Calendar: ({ className }: any) => <span data-testid="calendar-icon" className={className} />,
  ChevronLeft: ({ className }: any) => <span data-testid="chevron-left" className={className} />,
  ChevronRight: ({ className }: any) => <span data-testid="chevron-right" className={className} />,
  ChevronDown: ({ className }: any) => <span data-testid="chevron-down" className={className} />,
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
      "Hermes",
      "OpenClaw",
      "Factory Droid",
      "Devin CLI",
      "Antigravity CLI",
      "Goose",
      "grok CLI",
      "Qwen Code",
      "Ori",
      "Cline",
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

// Gateway CLIs (Hermes, OpenClaw) are user-scoped and have no working directory
// to group by, so they render as a folder tree over their synthetic path.
// Filesystem-backed projects must keep rendering as flat rows.
describe("ProjectList — gateway folder tree", () => {
  // Collapsed folders persist to localStorage by design, and jsdom shares one
  // storage across every test in this file — so without this, a test that
  // collapses a node leaves the next one starting collapsed.
  beforeEach(() => {
    window.localStorage.clear();
  });

  function gatewayFolders(): ProjectFolder[] {
    return [
      {
        name: "hermes-default-slack",
        path: "hermes:default:slack",
        isDirectory: true,
        lastModified: new Date("2026-07-20T00:00:00Z"),
        lastModifiedFormatted: "Jul 20, 2026",
        cli: ["hermes"],
        sessionCount: 3,
      },
      {
        name: "hermes-bangalore-weather-telegram",
        path: "hermes:bangalore-weather:telegram",
        isDirectory: true,
        lastModified: new Date("2026-07-21T00:00:00Z"),
        lastModifiedFormatted: "Jul 21, 2026",
        cli: ["hermes"],
        sessionCount: 8,
      },
      {
        name: "-home-u-app",
        path: "/home/u/app",
        isDirectory: true,
        lastModified: new Date("2026-07-19T00:00:00Z"),
        lastModifiedFormatted: "Jul 19, 2026",
        cli: ["claude"],
      },
    ];
  }

  it("renders one folder row per profile and a leaf per channel", () => {
    render(<ProjectList folders={gatewayFolders()} />);
    expect(screen.getByRole("button", { name: "Collapse hermes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse default" })).toBeInTheDocument();
    // A hyphenated profile stays ONE segment — not "bangalore/weather".
    expect(screen.getByRole("button", { name: "Collapse bangalore-weather" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "slack" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "telegram" })).toBeInTheDocument();
  });

  it("links leaves to the unchanged /project/<name> route", () => {
    render(<ProjectList folders={gatewayFolders()} />);
    expect(screen.getByRole("link", { name: "slack" })).toHaveAttribute(
      "href",
      "/project/hermes-default-slack",
    );
  });

  it("keeps filesystem projects as flat rows alongside the tree", () => {
    render(<ProjectList folders={gatewayFolders()} />);
    expect(screen.getByRole("link", { name: "/home/u/app" })).toHaveAttribute(
      "href",
      "/project/-home-u-app",
    );
  });

  it("rolls session counts up onto folder rows", () => {
    render(<ProjectList folders={gatewayFolders()} />);
    expect(screen.getByText("11 sessions")).toBeInTheDocument(); // 3 + 8 at the hermes root
    expect(screen.getByText("3 sessions")).toBeInTheDocument(); // default
    expect(screen.getByText("8 sessions")).toBeInTheDocument(); // bangalore-weather
  });

  it("is expanded by default and collapses a subtree on click", async () => {
    const user = userEvent.setup();
    render(<ProjectList folders={gatewayFolders()} />);
    expect(screen.getByRole("link", { name: "slack" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse hermes" }));

    expect(screen.queryByRole("link", { name: "slack" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "telegram" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand hermes" })).toBeInTheDocument();
    // The flat project is untouched by a gateway collapse.
    expect(screen.getByRole("link", { name: "/home/u/app" })).toBeInTheDocument();
  });

  it("collapses only the clicked branch, leaving siblings open", async () => {
    const user = userEvent.setup();
    render(<ProjectList folders={gatewayFolders()} />);
    await user.click(screen.getByRole("button", { name: "Collapse default" }));
    expect(screen.queryByRole("link", { name: "slack" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "telegram" })).toBeInTheDocument();
  });

  it("force-expands so a search match is never hidden inside a collapsed folder", async () => {
    const user = userEvent.setup();
    render(<ProjectList folders={gatewayFolders()} />);
    await user.click(screen.getByRole("button", { name: "Collapse hermes" }));
    expect(screen.queryByRole("link", { name: "slack" })).not.toBeInTheDocument();

    const input = screen.getByPlaceholderText("Enter keyword and press Enter");
    await user.type(input, "slack{Enter}");

    expect(screen.getByRole("link", { name: "slack" })).toBeInTheDocument();
  });

  it("still counts PROJECTS, not tree rows, in the results summary", () => {
    render(<ProjectList folders={gatewayFolders()} />);
    expect(screen.getByText(/Showing 1-3 of 3 projects/)).toBeInTheDocument();
  });

  it("shows no expand/collapse control when there are no gateway projects", () => {
    render(<ProjectList folders={makeFolders(2)} />);
    expect(screen.queryByRole("button", { name: /Collapse all|Expand all/ })).not.toBeInTheDocument();
  });

  // ── Regressions caught by the adversarial review of this feature ──

  it("rolls up the TRUE session total even when a profile spans a page boundary", () => {
    // The tree used to be built from the paginated slice, so one profile's
    // channels straddling page 25 rendered the root twice, each time summing
    // only that page's leaves — the real total appeared nowhere.
    const many: ProjectFolder[] = [
      ...makeFolders(24), // newest, fill page 1
      {
        name: "hermes-default-slack",
        path: "hermes:default:slack",
        isDirectory: true,
        lastModified: new Date("2020-01-03T00:00:00Z"),
        cli: ["hermes"],
        sessionCount: 10,
      },
      {
        name: "hermes-default-cron",
        path: "hermes:default:cron",
        isDirectory: true,
        lastModified: new Date("2020-01-02T00:00:00Z"),
        cli: ["hermes"],
        sessionCount: 20,
      },
      {
        name: "hermes-default-cli",
        path: "hermes:default:cli",
        isDirectory: true,
        lastModified: new Date("2020-01-01T00:00:00Z"),
        cli: ["hermes"],
        sessionCount: 30,
      },
    ];
    render(<ProjectList folders={many} />);
    // One `hermes` root, reporting all 60 — not 10 here and 50 on page 2.
    expect(screen.getAllByRole("button", { name: "Collapse hermes" })).toHaveLength(1);
    expect(screen.getAllByText("60 sessions")).toHaveLength(2); // root + profile
  });

  it("still reports a project range, counting projects rather than tree rows", () => {
    // 24 filesystem projects + 3 hermes channels = 27 projects, but only 25
    // top-level rows (the 3 channels fold into one `hermes` entry).
    const many: ProjectFolder[] = [
      ...makeFolders(24),
      ...["slack", "cron", "cli"].map((source, i) => ({
        name: `hermes-default-${source}`,
        path: `hermes:default:${source}`,
        isDirectory: true,
        lastModified: new Date(2020, 0, i + 1),
        cli: ["hermes" as const],
        sessionCount: 1,
      })),
    ];
    render(<ProjectList folders={many} />);
    expect(screen.getByText(/Showing 1-27 of 27 projects/)).toBeInTheDocument();
  });

  it("keeps collapse state for folders outside the current filter when using Collapse all", async () => {
    // `toggleAll` used to REPLACE the persisted set with the current view's
    // keys, silently dropping collapses made under another filter or page.
    const user = userEvent.setup();
    const folders: ProjectFolder[] = [
      {
        name: "hermes-default-slack",
        path: "hermes:default:slack",
        isDirectory: true,
        lastModified: new Date("2026-07-20T00:00:00Z"),
        cli: ["hermes"],
        sessionCount: 1,
      },
      {
        name: "openclaw-bot-telegram",
        path: "openclaw:bot:telegram",
        isDirectory: true,
        lastModified: new Date("2026-07-19T00:00:00Z"),
        cli: ["openclaw"],
        sessionCount: 1,
      },
    ];
    render(<ProjectList folders={folders} />);

    await user.click(screen.getByRole("button", { name: "Collapse hermes" }));
    expect(JSON.parse(window.localStorage.getItem("failproofai.projects.collapsed")!)).toEqual([
      "hermes",
    ]);

    await user.selectOptions(screen.getByLabelText("Filter by CLI"), "openclaw");
    await user.click(screen.getByRole("button", { name: /Collapse all/ }));

    const stored: string[] = JSON.parse(
      window.localStorage.getItem("failproofai.projects.collapsed")!,
    );
    expect(stored).toContain("hermes"); // the off-filter collapse survives
    expect(stored).toContain("openclaw");
  });

  it("flips the bulk toggle label once everything on screen is collapsed", async () => {
    // The label was computed over every collapsible key in the page's tree,
    // including ones hidden inside an already-collapsed parent — so it kept
    // saying "Collapse all" while clicking it changed nothing visible.
    const user = userEvent.setup();
    render(<ProjectList folders={gatewayFolders()} />);
    await user.click(screen.getByRole("button", { name: "Collapse hermes" }));
    expect(screen.getByRole("button", { name: /Expand all/ })).toBeInTheDocument();
  });

  it("makes folder toggles inert during a search instead of silently flipping saved state", async () => {
    // Search force-expands, so a toggle could only flip hidden state: no visual
    // feedback, and the collapse silently inverted once the search cleared.
    const user = userEvent.setup();
    render(<ProjectList folders={gatewayFolders()} />);
    await user.click(screen.getByRole("button", { name: "Collapse hermes" }));

    await user.type(
      screen.getByPlaceholderText("Enter keyword and press Enter"),
      "hermes{Enter}",
    );
    // Force-expanded, and no longer offering a button to click.
    expect(screen.getByRole("link", { name: "slack" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Collapse hermes|Expand hermes/ })).not.toBeInTheDocument();

    // The saved collapse is untouched by the search.
    expect(JSON.parse(window.localStorage.getItem("failproofai.projects.collapsed")!)).toEqual([
      "hermes",
    ]);
  });

  // The folder icon lives in its own <td>, so indenting only the name cell left
  // every child's icon at the same x as its parent's — the rows read as a flat
  // list with ragged text instead of a hierarchy. Icon and label must shift
  // together, and each level must start further right than the one above it.
  it("indents the icon and the label together, one step per depth", () => {
    const folders: ProjectFolder[] = [
      {
        name: "hermes-default-slack",
        path: "hermes:default:slack",
        isDirectory: true,
        lastModified: new Date("2026-07-20T00:00:00Z"),
        lastModifiedFormatted: "Jul 20, 2026",
        cli: ["hermes"],
        sessionCount: 3,
      },
    ];
    const { container } = render(<ProjectList folders={folders} />);

    // hermes (depth 0) → default (depth 1) → slack (depth 2)
    const padOf = (text: string) => {
      const row = [...container.querySelectorAll("tr")].find((r) => r.textContent?.includes(text))!;
      const cells = [...row.querySelectorAll("td")];
      const iconPad = (cells[0].firstElementChild as HTMLElement).style.paddingLeft;
      const namePad = (cells[1].firstElementChild as HTMLElement).style.paddingLeft;
      // Icon and name must agree, or the row splits into two ragged columns.
      expect(iconPad).toBe(namePad);
      return parseFloat(iconPad || "0");
    };

    const root = padOf("hermes");
    const profile = padOf("default");
    const channel = padOf("slack");

    expect(root).toBe(0);
    expect(profile).toBeGreaterThan(root);
    expect(channel).toBeGreaterThan(profile);
  });
});
