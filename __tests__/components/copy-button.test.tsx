import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyButton } from "@/app/components/copy-button";

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Copy: (props: any) => <span data-testid="copy-icon" {...props} />,
  Check: (props: any) => <span data-testid="check-icon" {...props} />,
}));

describe("CopyButton", () => {
  const originalExecCommand = document.execCommand;

  beforeEach(() => {
    // jsdom doesn't provide navigator.clipboard by default
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.execCommand = originalExecCommand;
  });

  it("renders copy icon by default", () => {
    render(<CopyButton text="hello" />);
    expect(screen.getByTestId("copy-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("check-icon")).not.toBeInTheDocument();
  });

  it("copies text to clipboard on click and shows check icon", async () => {
    const user = userEvent.setup();
    render(<CopyButton text="session-id-123" />);

    expect(screen.getByTestId("copy-icon")).toBeInTheDocument();

    await user.click(screen.getByTitle("Copy to clipboard"));

    await waitFor(() => {
      expect(screen.getByTestId("check-icon")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("copy-icon")).not.toBeInTheDocument();
  });

  it("reverts to copy icon after 2 seconds", async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<CopyButton text="test" />);
    await user.click(screen.getByTitle("Copy to clipboard"));

    expect(screen.getByTestId("check-icon")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByTestId("copy-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("check-icon")).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it("keeps the checkmark for the full 2s window after the last of two rapid clicks", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<CopyButton text="test" />);
    const button = screen.getByTitle("Copy to clipboard");

    // Click at t=0 (timer A would revert at t=2.0s)
    await user.click(button);
    expect(screen.getByTestId("check-icon")).toBeInTheDocument();

    // Click again at t=1.5s — should reset the window (arm timer B, clear timer A)
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await user.click(button);
    expect(screen.getByTestId("check-icon")).toBeInTheDocument();

    // t=2.0s: stale timer A must NOT flip the icon back early
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId("check-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("copy-icon")).not.toBeInTheDocument();

    // t=3.5s (2.0s after the LAST click at t=1.5s): timer B reverts it
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId("copy-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("check-icon")).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it("clears the armed revert timer on unmount", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<CopyButton text="test" />);
    await user.click(screen.getByTitle("Copy to clipboard"));
    expect(screen.getByTestId("check-icon")).toBeInTheDocument();

    // The click armed the 2s revert timer — it is pending mid-window.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(vi.getTimerCount()).toBe(1);

    // Unmounting before the timer fires must clear it, so nothing is left
    // pending to call `setCopied` on the gone component. This is the
    // load-bearing assertion: it bites without the useEffect cleanup.
    unmount();
    expect(vi.getTimerCount()).toBe(0);

    // Secondary: advancing past the original window logs no error (e.g. a
    // "state update on unmounted component" warning), belt-and-suspenders.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(errorSpy).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("applies custom className", () => {
    render(<CopyButton text="test" className="custom-class" />);
    const button = screen.getByTitle("Copy to clipboard");
    expect(button.className).toContain("custom-class");
  });

  it("falls back to execCommand when navigator.clipboard is unavailable", async () => {
    // jsdom doesn't define execCommand — mock it directly
    const execCommandMock = vi.fn().mockReturnValue(true);
    document.execCommand = execCommandMock;

    // userEvent.setup() installs its own clipboard stub on navigator,
    // so we must remove clipboard AFTER setup
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    render(<CopyButton text="fallback-text" />);

    await user.click(screen.getByTitle("Copy to clipboard"));

    await waitFor(() => {
      expect(screen.getByTestId("check-icon")).toBeInTheDocument();
    });
    expect(execCommandMock).toHaveBeenCalledWith("copy");
  });

  it("does not show check icon when both copy methods fail", async () => {
    // execCommand also fails
    document.execCommand = vi.fn().mockReturnValue(false);
    // Suppress expected console.error
    vi.spyOn(console, "error").mockImplementation(() => {});

    // userEvent.setup() installs its own clipboard stub, so override after
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("Not allowed")),
      },
      writable: true,
      configurable: true,
    });

    render(<CopyButton text="fail-text" />);

    await user.click(screen.getByTitle("Copy to clipboard"));

    // Wait a tick for the async handler to settle
    await waitFor(() => {
      expect(screen.getByTestId("copy-icon")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("check-icon")).not.toBeInTheDocument();
  });
});
