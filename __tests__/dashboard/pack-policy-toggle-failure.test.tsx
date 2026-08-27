import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HooksConfigPayload } from "@/app/actions/get-hooks-config";
import type { PackActionResult } from "@/app/actions/pack-actions";

/**
 * A pack-policy toggle that FAILED to save, displayed as if it had saved.
 *
 * `togglePackPolicyAction` reports failure by RESOLVING to `{ ok: false, error }`
 * rather than throwing — deliberately, because none of its failures is
 * exceptional: the pack was removed, `installed.json` is unreadable, or a pack
 * update dropped the policy the open tab still lists. The dashboard flips the
 * row optimistically, then awaited that promise and discarded the result, so a
 * `try`/`catch` caught none of it. The row stayed flipped, the pack summary
 * stayed moved, and the dashboard went on advertising enforcement that was
 * never written — until somebody reloaded and it silently changed back.
 *
 * Every one of those paths is reached from a STALE tab, which is the ordinary
 * state of a dashboard left open, so this is the common failure, not the rare
 * one. These cases drive the real Configure tab and assert on what a person
 * looking at the screen sees: the message, the switch, and the pack's on-count.
 */

const togglePackPolicyAction = vi.fn<(...args: unknown[]) => Promise<PackActionResult>>();
const getHooksConfigAction = vi.fn(async () => payload);

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: Record<string, unknown> & { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/policies",
}));

vi.mock("@/contexts/PostHogContext", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock("@/contexts/AutoRefreshContext", () => ({
  useAutoRefresh: () => ({ intervalSec: 0, setIntervalSec: vi.fn() }),
}));

// Every server action the component imports. These are "use server" modules
// that reach the filesystem on import; only the toggle and the refetch matter
// here, so none of the others may actually run.
vi.mock("@/app/actions/get-hooks-config", () => ({
  getHooksConfigAction: () => getHooksConfigAction(),
}));
vi.mock("@/app/actions/get-hook-activity", () => ({
  getHookActivityAction: vi.fn(async () => ({ events: [], stats: {}, total: 0 })),
  searchHookActivityAction: vi.fn(async () => ({ events: [], stats: {}, total: 0 })),
}));
vi.mock("@/app/actions/get-active-pauses", () => ({
  getActivePausesAction: vi.fn(async () => []),
}));
vi.mock("@/app/actions/update-hooks-config", () => ({
  toggleCustomPolicyAction: vi.fn(async () => {}),
}));
vi.mock("@/app/actions/pack-actions", () => ({
  togglePackPolicyAction: (...args: unknown[]) => togglePackPolicyAction(...args),
  addBundledPackWebAction: vi.fn(async () => ({ ok: true })),
  addPackWebAction: vi.fn(async () => ({ ok: true })),
  previewPackWebAction: vi.fn(async () => ({ ok: true })),
  removePackWebAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/actions/install-hooks-web", () => ({
  installHooksWebAction: vi.fn(async () => {}),
  removeHooksWebAction: vi.fn(async () => {}),
}));
vi.mock("@/app/actions/update-policy-params", () => ({
  updatePolicyParamsAction: vi.fn(async () => {}),
}));

import HooksClient from "@/app/policies/hooks-client";

const SUDO_DESC = "block sudo in the agent shell";
const PUSH_DESC = "block force pushes to main";

/**
 * TWO policies in the pack, both on. One is what gets clicked; the other exists
 * so the pack's summary and the category header read "2 of 2" rather than
 * "1 of 1" — with a single policy, a count that failed to revert and a count
 * that reverted to the same number are the same string on screen.
 */
function makePayload(): HooksConfigPayload {
  const policy = (name: string, description: string) => ({
    name,
    description,
    category: "safety",
    defaultEnabled: true,
    beta: false,
    enabled: true,
    eventScope: "PreToolUse · Bash",
    packId: "ops",
    packVersion: "1.0.0",
  });
  return {
    enabledPolicies: [],
    installedScopes: [],
    settingsPath: "/home/tester/.claude/settings.json",
    // handleToggle refuses to write anything unless a CLI is installed.
    clis: [
      {
        id: "claude",
        label: "Claude Code",
        installed: true,
        settingsPath: "/home/tester/.claude/settings.json",
        detected: true,
      },
    ],
    policies: [policy("block-sudo", SUDO_DESC), policy("block-force-push", PUSH_DESC)],
    conventionPolicies: [],
    packs: [
      {
        id: "ops",
        version: "1.0.0",
        source: "github:acme/ops@v1.0.0",
        effect: "enforce" as const,
        policies: [
          { name: "block-sudo", description: SUDO_DESC, category: "safety", enabled: true },
          { name: "block-force-push", description: PUSH_DESC, category: "safety", enabled: true },
        ],
      },
    ],
  };
}

/**
 * What the SERVER still says, returned by every refetch. The optimistic update
 * builds new objects and never touches this, so it stays the truth the failed
 * write left on disk — which is exactly what a revert has to land back on.
 */
let payload: HooksConfigPayload = makePayload();

/** The toggle for the row whose description names the policy. */
function toggleFor(description: string): HTMLElement {
  const row = screen.getByText(description).closest("div.flex.items-start");
  if (!row) throw new Error(`no policy row found for ${description}`);
  const button = row.querySelector("button");
  if (!button) throw new Error(`no toggle found in the row for ${description}`);
  return button;
}

/** PolicyToggle's aria-label is the row's on/off state, read back. */
function stateOf(description: string): string {
  return toggleFor(description).getAttribute("aria-label") ?? "";
}

/** The pack's block in the Policy packs section, found by its Remove button. */
function packBlock(id: string): HTMLElement {
  return screen.getByLabelText(`Remove ${id}`).closest("div")!.parentElement!;
}

/**
 * Move the SERVER's copy on, the way a second operator would while this tab sat
 * open. Every case below reverts back onto whatever `payload` holds at the
 * moment of the refetch, so this is what makes "reloaded" and "rolled back by
 * hand" two different screens instead of one.
 */
function serverTurnsOff(name: string): void {
  payload = {
    ...payload,
    policies: payload.policies.map((p) => (p.name === name ? { ...p, enabled: false } : p)),
    packs: payload.packs.map((pack) => ({
      ...pack,
      policies: pack.policies.map((p) => (p.name === name ? { ...p, enabled: false } : p)),
    })),
  };
}

describe("a pack-policy toggle the server refused", () => {
  beforeEach(() => {
    payload = makePayload();
    togglePackPolicyAction.mockReset();
    getHooksConfigAction.mockClear();
  });

  /**
   * The headline defect. `{ ok: false }` is a normal resolution, so the click
   * looked successful: the switch read "on", no message appeared anywhere, and
   * the policy was not running. The reason has to reach the screen too — these
   * are the loader's own words about a specific pack, and they are the whole
   * difference between a fixable problem and a mysterious one.
   */
  it("shows the action's own reason and puts the switch back", async () => {
    togglePackPolicyAction.mockResolvedValue({ ok: false, error: "no installed pack with id ops" });
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(SUDO_DESC);
    expect(stateOf(SUDO_DESC)).toBe("Disable policy");

    await user.click(toggleFor(SUDO_DESC));

    expect(await screen.findByText("no installed pack with id ops")).toBeInTheDocument();
    // Back to on, because that is what the manifest still says. Left flipped,
    // the row claimed an enforcement change that no file on the machine has.
    await waitFor(() => expect(stateOf(SUDO_DESC)).toBe("Disable policy"));
  });

  /**
   * Every other case in this file has the server agreeing with the pre-click
   * screen, so a revert that REFETCHES and a revert that flips the row back by
   * hand produce the identical DOM and no assertion can tell them apart — the
   * untouched row's `toBe("Disable policy")` that used to sit above could not
   * fail under any implementation at all.
   *
   * Here the server has moved on: somebody turned `block-force-push` off while
   * this tab sat open, which is the SAME staleness that makes the write fail in
   * the first place. Now only a refetch lands on the truth. A hand-rollback
   * leaves the second row reading "on" against a disk that says off, and the
   * dashboard goes on advertising a policy nothing is running — the exact
   * defect this file exists for, one row over.
   */
  it("lands the rows on what the server says, not on what the tab remembered", async () => {
    togglePackPolicyAction.mockResolvedValue({ ok: false, error: "no installed pack with id ops" });
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(SUDO_DESC);
    expect(stateOf(PUSH_DESC)).toBe("Disable policy");

    serverTurnsOff("block-force-push");
    await user.click(toggleFor(SUDO_DESC));

    await screen.findByText("no installed pack with id ops");
    // The clicked row: back to on, because the refused write changed nothing.
    await waitFor(() => expect(stateOf(SUDO_DESC)).toBe("Disable policy"));
    // The untouched row: OFF, because that is what the machine now holds.
    await waitFor(() => expect(stateOf(PUSH_DESC)).toBe("Enable policy"));
    // Both counters follow the same refetch, so they have to agree with it.
    expect(screen.getByText("1 / 2 enabled")).toBeInTheDocument();
    expect(packBlock("ops").textContent).toContain("1 of 2 on");
  });

  /**
   * The category header counts the same flat list the rows come from, so it is
   * a second display of the same lie and reverts from the same refetch. Pinned
   * separately from the row: an optimistic update rolled back by hand, rather
   * than by reloading, is exactly the kind of fix that restores one and not the
   * other.
   */
  it("puts the category count back", async () => {
    togglePackPolicyAction.mockResolvedValue({ ok: false, error: "no installed pack with id ops" });
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(SUDO_DESC);
    expect(screen.getByText("2 / 2 enabled")).toBeInTheDocument();

    await user.click(toggleFor(SUDO_DESC));

    await screen.findByText("no installed pack with id ops");
    await waitFor(() => expect(screen.getByText("2 / 2 enabled")).toBeInTheDocument());
  });

  /**
   * `handleToggle` writes TWO optimistic updates — the flat policy list and the
   * pack's own selection, which the Policy packs section renders as "n of m
   * on". A revert that missed the second one leaves the pack summary reading
   * one fewer policy enforcing than the rows directly above it do, and the two
   * disagree until the next reload.
   */
  it("puts the pack's on-count back", async () => {
    togglePackPolicyAction.mockResolvedValue({ ok: false, error: "no installed pack with id ops" });
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(SUDO_DESC);
    expect(packBlock("ops").textContent).toContain("2 of 2 on");

    await user.click(toggleFor(SUDO_DESC));

    await screen.findByText("no installed pack with id ops");
    await waitFor(() => expect(packBlock("ops").textContent).toContain("2 of 2 on"));
  });

  /**
   * `{ ok: false }` with no `error` — the shape is typed with `error` optional,
   * so nothing stops a future branch returning it. Without the fallback message
   * the banner renders nothing at all: `setActionError(undefined)` is falsy, and
   * the row would revert under the person's cursor with no word about why.
   */
  it("still says something when the refusal carries no reason", async () => {
    togglePackPolicyAction.mockResolvedValue({ ok: false });
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(SUDO_DESC);

    await user.click(toggleFor(SUDO_DESC));

    expect(await screen.findByText("Failed to save policy change.")).toBeInTheDocument();
    await waitFor(() => expect(stateOf(SUDO_DESC)).toBe("Disable policy"));
  });

  /**
   * A throw is the OTHER failure channel — a dead dev server, a serialization
   * error crossing the action boundary — and it was the only one handled. Reading
   * `result.ok` sits inside the same `try`, so a mistake there (an early return,
   * a moved `catch`) could strand the throw case; it has to keep reverting and
   * keep naming itself.
   */
  it("keeps handling a thrown action the way it always did", async () => {
    togglePackPolicyAction.mockRejectedValue(new Error("connection refused"));
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(SUDO_DESC);

    await user.click(toggleFor(SUDO_DESC));

    expect(await screen.findByText("Failed to save policy change.")).toBeInTheDocument();
    await waitFor(() => expect(stateOf(SUDO_DESC)).toBe("Disable policy"));
    expect(packBlock("ops").textContent).toContain("2 of 2 on");
  });

  /**
   * The success path, unchanged. Checking the result is only worth having if
   * `{ ok: true }` still leaves the optimistic flip standing — a check that
   * reverted or refetched on every click would undo the point of the optimistic
   * update and make the switch flicker back and forth on a healthy machine.
   */
  it("leaves a successful toggle flipped, with no message", async () => {
    togglePackPolicyAction.mockResolvedValue({ ok: true, id: "ops" });
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(SUDO_DESC);

    await user.click(toggleFor(SUDO_DESC));

    await waitFor(() => expect(stateOf(SUDO_DESC)).toBe("Enable policy"));
    expect(packBlock("ops").textContent).toContain("1 of 2 on");
    expect(screen.getByText("1 / 2 enabled")).toBeInTheDocument();
    expect(screen.queryByText("Failed to save policy change.")).not.toBeInTheDocument();

    // The revert is a refetch, and a refetch lands a turn later than the click.
    // Settle first: an unconditional reload would put this row back to on right
    // here, and every assertion above would already have passed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stateOf(SUDO_DESC)).toBe("Enable policy");
    expect(packBlock("ops").textContent).toContain("1 of 2 on");
  });
});
