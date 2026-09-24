import { describe, it, expect, vi, beforeEach } from "vitest";
import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HooksConfigPayload } from "@/app/actions/get-hooks-config";
import type { HookActivityPayload } from "@/app/actions/get-hook-activity";
import type { HookActivityEntry } from "@/src/hooks/hook-activity-store";

/**
 * The activity tab's wiring of the Jev notices: the pill in the Decision cell
 * and the "Semantic review" line in the detail panel.
 *
 * The components themselves are tested in __tests__/components/jev-notices*.
 * This renders the REAL activity table against Jev rows, so dropping either
 * `<JevPill>` or `<JevNote>` from hooks-client.tsx fails here — and a row
 * without Jev fields, the unconfigured machine, gets neither.
 */

/**
 * This file renders the WHOLE activity client, not a single component, so a
 * click-then-assert costs a real re-render — 1.4s of it on a shared CI runner,
 * against Testing Library's 1s default. That timed out in the `hook-log-file`
 * env config while passing in the other two, which is a runner-speed
 * measurement, not a defect. Five seconds is still far below vitest's own test
 * timeout, so a genuinely missing element still fails the test rather than
 * hanging the suite.
 */
// Testing Library's async budget has to sit BELOW vitest's own, or the two
// race and the wrong one wins. At 5s each — vitest's default is 5s — a single
// `findByText` on a slow runner can consume the whole test budget, so vitest
// kills the test before Testing Library can say which element it could not
// find. That is what this file did on CI while passing locally in 1.8s: three
// jobs reported "Test timed out in 5000ms" and one reported an element missing,
// which were the same slowness surfacing at whichever await got there first.
//
// The test renders, waits for a row, clicks it, and waits for a detail panel —
// several awaits, each allowed 5s — so the test needs room for all of them. The
// click is the part that really needs it: landing before React has attached its
// handlers does nothing at all, and the panel then never opens.
configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });

const NOW = Date.now();

function row(overrides: Partial<HookActivityEntry>): HookActivityEntry {
  return {
    timestamp: NOW - 60_000,
    eventType: "PreToolUse",
    integration: "claude",
    toolName: "Read",
    policyName: null,
    decision: "allow",
    reason: null,
    durationMs: 52,
    sessionId: "sess-jev-dashboard",
    cwd: "/home/tester/repo",
    ...overrides,
  };
}

let entries: HookActivityEntry[] = [];
const activity = (): HookActivityPayload => ({
  entries,
  totalPages: 1,
  page: 1,
  stats: { totalEvents: 0, denyCount: 0, topPolicy: null, topPolicyCount: 0 },
});

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
// that reach the filesystem on import, so none of them may actually run.
vi.mock("@/app/actions/get-hooks-config", () => ({
  getHooksConfigAction: vi.fn(
    async () =>
      ({
        enabledPolicies: [],
        installedScopes: [],
        settingsPath: "/home/tester/.claude/settings.json",
        clis: [
          {
            id: "claude",
            label: "Claude Code",
            installed: true,
            settingsPath: "/home/tester/.claude/settings.json",
            detected: true,
          },
        ],
        policies: [],
        conventionPolicies: [],
        packs: [],
      }) as unknown as HooksConfigPayload,
  ),
}));
vi.mock("@/app/actions/get-hook-activity", () => ({
  getHookActivityAction: vi.fn(async () => activity()),
  searchHookActivityAction: vi.fn(async () => activity()),
}));
vi.mock("@/app/actions/get-active-pauses", () => ({
  getActivePausesAction: vi.fn(async () => []),
}));
vi.mock("@/app/actions/update-hooks-config", () => ({
  toggleCustomPolicyAction: vi.fn(async () => {}),
}));
vi.mock("@/app/actions/pack-actions", () => ({
  togglePackPolicyAction: vi.fn(async () => ({ ok: true })),
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

/** The table row whose Tool cell reads `tool`. */
async function rowFor(tool: string): Promise<HTMLElement> {
  const cell = await screen.findByText(tool);
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`no activity row for ${tool}`);
  return tr;
}

/**
 * Open a row's detail panel, re-querying the row at the moment of the click.
 *
 * The row must NOT be held across an await. This page drives seven mocked
 * server actions — activity, config, pauses, packs and three more — which
 * settle independently, so the table re-renders after `rowFor` has already
 * handed back a node. Clicking a detached node does nothing at all, silently:
 * no error, no state change, and then a five-second wait for a panel that was
 * never going to open. It failed on one CI env config while passing on the
 * other two, which is the signature of that race rather than of a wrong
 * expectation.
 *
 * The open-marker check is what makes the retry safe: clicking a row toggles
 * it, so a blind retry would close the panel it had just opened.
 */
async function openRow(user: ReturnType<typeof userEvent.setup>, tool: string, marker: string) {
  await waitFor(async () => {
    if (screen.queryByText(marker, { exact: false })) return;
    await user.click(await rowFor(tool));
    expect(screen.queryByText(marker, { exact: false })).not.toBeNull();
  });
}

describe("the activity tab with Jev rows", () => {
  beforeEach(() => {
    entries = [];
  });

  it("marks a Jev clear in the Decision cell and explains it in the detail panel", async () => {
    entries = [
      row({
        toolName: "Read",
        evaluator: "jev",
        jevDecision: "allow",
        jevCleared: ["block-read-outside-cwd"],
        jevLatencyMs: 38,
        jevModel: "jev-1.13.0",
        jevMode: "enforce",
      }),
    ];
    const user = userEvent.setup();
    render(<HooksClient initialTab="activity" />);
    expect(within(await rowFor("Read")).getByText("jev cleared")).toBeInTheDocument();
    expect(screen.queryByText("Semantic review:", { exact: false })).toBeNull();

    await openRow(user, "Read", "Semantic review:");
    expect(screen.queryByText("Semantic review:", { exact: false })).not.toBeNull();
    expect(
      screen.getByText("Jev verdict: allow · cleared block-read-outside-cwd · 38 ms · jev-1.13.0"),
    ).toBeInTheDocument();
  });

  it("marks a fallback and says why", async () => {
    entries = [
      row({
        toolName: "Bash",
        decision: "deny",
        policyName: "block-env-files",
        reason: "Reading .env files is blocked",
        evaluator: "jev-fallback",
        jevFallbackReason: "timeout",
        jevLatencyMs: 1500,
        jevMode: "enforce",
      }),
    ];
    const user = userEvent.setup();
    render(<HooksClient initialTab="activity" />);
    expect(within(await rowFor("Bash")).getByText("jev fallback")).toBeInTheDocument();
    await openRow(user, "Bash", "Jev unavailable: timeout");
    expect(
      screen.queryByText("Jev unavailable: timeout · the regex policies decided alone · 1500 ms"),
    ).not.toBeNull();
  });

  it("shows nothing Jev-related for a row written without Jev", async () => {
    entries = [row({ toolName: "Grep" })];
    const user = userEvent.setup();
    render(<HooksClient initialTab="activity" />);
    expect(within(await rowFor("Grep")).queryByText(/^jev /)).toBeNull();
    await openRow(user, "Grep", "event detail");
    expect(screen.queryByText("Semantic review:", { exact: false })).toBeNull();
  });
});
