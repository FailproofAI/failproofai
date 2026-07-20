import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SessionHooksPanel from "@/app/components/session-hooks-panel";

const mocks = vi.hoisted(() => ({
  searchHookActivityAction: vi.fn(),
  ChevronDown: (props: any) => <svg data-testid="chevron-icon" {...props} />,
  ShieldCheck: () => <span data-testid="shield-check" />,
  ShieldX: () => <span data-testid="shield-x" />,
  ShieldAlert: () => <span data-testid="shield-alert" />,
  Shield: () => <span data-testid="shield" />,
  Copy: (props: any) => <span data-testid="copy-icon" {...props} />,
  Check: (props: any) => <span data-testid="check-icon" {...props} />,
  ChevronLeft: () => <span data-testid="chevron-left" />,
  ChevronRight: () => <span data-testid="chevron-right" />,
}));

vi.mock("@/app/actions/get-hook-activity", () => ({
  searchHookActivityAction: mocks.searchHookActivityAction,
}));

vi.mock("lucide-react", () => ({
  ChevronDown: mocks.ChevronDown,
  ShieldCheck: mocks.ShieldCheck,
  ShieldX: mocks.ShieldX,
  ShieldAlert: mocks.ShieldAlert,
  Shield: mocks.Shield,
  Copy: mocks.Copy,
  Check: mocks.Check,
}));

vi.mock("@/contexts/AutoRefreshContext", () => ({
  useAutoRefresh: () => ({ intervalSec: 0 }),
}));

vi.mock("@/lib/format-duration", () => ({
  formatRelativeTime: () => "just now",
}));

const mockEntry = {
  timestamp: Date.now(),
  eventType: "PreToolUse",
  integration: "claude",
  toolName: "Read",
  policyName: "test-policy",
  policyNames: ["test-policy"],
  decision: "allow" as const,
  reason: "ok",
  durationMs: 42,
  sessionId: "sess_123",
  permissionMode: "default",
};

const defaultPayload = {
  entries: [mockEntry],
  totalPages: 1,
  page: 1,
  stats: { totalEvents: 1, denyCount: 0, topPolicy: null, topPolicyCount: 0 },
};

describe("SessionHooksPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchHookActivityAction.mockResolvedValue(defaultPayload);
  });

  it("renders expand row button with correct aria attributes", () => {
    render(<SessionHooksPanel sessionId="sess_123" initialData={defaultPayload} />);
    const btn = screen.getByRole("button", { name: /expand hook event details/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles aria-expanded on Space key press", async () => {
    const user = userEvent.setup();
    render(<SessionHooksPanel sessionId="sess_123" initialData={defaultPayload} />);
    const btn = screen.getByRole("button", { name: /expand hook event details/i });
    btn.focus();
    await user.keyboard(" ");
    expect(btn).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles aria-expanded on Enter key press", async () => {
    const user = userEvent.setup();
    render(<SessionHooksPanel sessionId="sess_123" initialData={defaultPayload} />);
    const btn = screen.getByRole("button", { name: /expand hook event details/i });
    btn.focus();
    await user.keyboard("{Enter}");
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });

  it("toggles aria-expanded on button click", async () => {
    const user = userEvent.setup();
    render(<SessionHooksPanel sessionId="sess_123" initialData={defaultPayload} />);
    const btn = screen.getByRole("button", { name: /expand hook event details/i });
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
  });
});
