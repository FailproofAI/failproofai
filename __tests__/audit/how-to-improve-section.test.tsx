/**
 * The audit dashboard prescribes policies and offers copy buttons that hand the
 * user a shell command. Those commands must be ones the CLI actually accepts.
 *
 * `policy` and `policies` are DIFFERENT commands, not aliases:
 *   failproofai policy add <one-name>          — exactly one, rejects a second
 *   failproofai policies --install <names...>  — takes a list
 *
 * The "install all" button used to emit `policy add a b c`, which errors on
 * paste with "`policy add` takes exactly one policy name (got N)". Since the
 * section only renders when there are gaps to close, the multi-policy case is
 * the normal one — so the broken command was what most users copied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock("@/contexts/PostHogContext", () => ({
  usePostHog: () => ({ capture: captureMock }),
}));

import { HowToImproveSection } from "@/app/audit/_components/how-to-improve-section";
import type { AuditResult } from "@/src/audit/types";

// Declare the parameter so `mock.calls[n][0]` is typed as the copied string.
const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  writeText.mockClear();
  captureMock.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => cleanup());

/** An audit result with `names` flagged as disabled builtins that got hits. */
function resultWith(names: string[]): AuditResult {
  return {
    results: names.map((name, i) => ({
      name,
      source: "builtin",
      enabledInConfig: false,
      hits: names.length - i, // distinct, so ordering is deterministic
    })),
    enabledBuiltinNames: [],
  } as unknown as AuditResult;
}

const renderSection = (names: string[]) =>
  render(<HowToImproveSection result={resultWith(names)} projected={80} projectedGrade="B" />);

describe("audit dashboard — install commands", () => {
  it("uses the plural `policies --install` for multiple policies", async () => {
    renderSection(["block-sudo", "block-env-files", "block-rm-rf"]);
    fireEvent.click(screen.getByLabelText("Copy install-all command"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const cmd = writeText.mock.calls[0]![0];
    expect(cmd).toBe("failproofai policies --install block-sudo block-env-files block-rm-rf");
  });

  // The regression itself: `policy add` with more than one name is rejected by
  // the CLI, so the install-all button must never produce that shape.
  it("never emits `policy add` with more than one name", async () => {
    renderSection(["block-sudo", "block-env-files"]);
    fireEvent.click(screen.getByLabelText("Copy install-all command"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const cmd = writeText.mock.calls[0]![0];
    const singular = cmd.match(/\bfailproofai policy add ((?:[\w-]+\s*)+)/);
    if (singular) {
      expect(singular[1]!.trim().split(/\s+/)).toHaveLength(1);
    }
  });

  it("still emits a runnable command for a single policy", async () => {
    renderSection(["block-sudo"]);
    fireEvent.click(screen.getByLabelText("Copy install-all command"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const cmd = writeText.mock.calls[0]![0];
    expect(cmd).toBe("failproofai policies --install block-sudo");
  });

  // The per-row buttons are the one place `policy add` is correct — they act on
  // exactly one policy each.
  it("per-policy rows use the singular `policy add` with exactly one name", async () => {
    renderSection(["block-sudo", "block-env-files"]);
    const rowButtons = screen.getAllByLabelText(/^Copy install command/);
    expect(rowButtons.length).toBeGreaterThan(0);

    fireEvent.click(rowButtons[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    const cmd = writeText.mock.calls[0]![0];
    expect(cmd).toMatch(/^failproofai policy add [\w-]+$/);
  });
});
