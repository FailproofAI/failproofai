import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SessionsList from "@/app/components/sessions-list";
import type { SessionFile } from "@/lib/projects";

// Mock next/link
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

// Mock lucide-react
vi.mock("lucide-react", () => ({
  File: ({ className }: any) => <span data-testid="file-icon" className={className} />,
  Search: ({ className }: any) => <span data-testid="search-icon" className={className} />,
  Calendar: ({ className }: any) => <span data-testid="calendar-icon" className={className} />,
  ChevronLeft: ({ className }: any) => <span data-testid="chevron-left" className={className} />,
  ChevronRight: ({ className }: any) => <span data-testid="chevron-right" className={className} />,
  RefreshCw: ({ className }: any) => <span data-testid="refresh-icon" className={className} />,
  Copy: ({ className }: any) => <span data-testid="copy-icon" className={className} />,
  Check: ({ className }: any) => <span data-testid="check-icon" className={className} />,
}));

function makeFiles(count: number): SessionFile[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `${String(i).padStart(8, "0")}-1111-2222-3333-444444444444`;
    return {
      name: `${id}.jsonl`,
      path: `/mock/path/${id}.jsonl`,
      lastModified: new Date(Date.now() - i * 86400000),
      lastModifiedFormatted: `Jun ${15 - i}, 2024`,
      sessionId: id,
    };
  });
}

describe("SessionsList", () => {
  it("renders sessions in table", () => {
    const files = makeFiles(3);
    render(<SessionsList files={files} projectName="test-project" />);
    expect(screen.getAllByText(/session id/i).length).toBeGreaterThan(0);
    expect(screen.getByText(files[0].sessionId!)).toBeInTheDocument();
  });

  it("session ID substring filter (case-insensitive)", async () => {
    const user = userEvent.setup();
    const files = makeFiles(3);
    render(<SessionsList files={files} projectName="test-project" />);

    const input = screen.getByLabelText("Filter by session ID");
    await user.type(input, "00000000");

    expect(screen.getByText(/showing.*of.*session/i)).toBeInTheDocument();
  });

  it("date preset filtering", async () => {
    const user = userEvent.setup();
    const files: SessionFile[] = [
      {
        name: "old.jsonl",
        path: "/old.jsonl",
        lastModified: new Date("2020-01-01T00:00:00Z"),
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      },
      {
        name: "new.jsonl",
        path: "/new.jsonl",
        lastModified: new Date(), // now
        sessionId: "11111111-2222-3333-4444-555555555555",
      },
    ];
    render(<SessionsList files={files} projectName="test-project" />);

    await user.click(screen.getByText("Last Hour"));

    expect(screen.getByText(/showing.*of.*1.*session/i)).toBeInTheDocument();
  });

  it("shows empty state", () => {
    render(<SessionsList files={[]} projectName="test-project" />);
    expect(screen.getByText(/no sessions found/i)).toBeInTheDocument();
  });
});
