import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HooksConfigPayload } from "@/app/actions/get-hooks-config";

/**
 * Two installed packs may each declare a policy called `block-sudo` — a pack
 * policy name is unique only WITHIN its pack. The dashboard's flat policy list
 * therefore holds two rows with the same name, and everything keyed on the name
 * alone conflates them:
 *
 *   - the optimistic toggle flipped BOTH rows while `togglePackPolicyAction`
 *     wrote only the clicked row's `(packId, name)`, so the untouched pack
 *     showed a change nothing persisted until the next reload undid it;
 *   - `key={policy.name}` made the two rows one React key, which React warns
 *     about and which lets it reuse the first row's element for the second;
 *   - the parameters modal built its config key off the name, so configuring
 *     one pack's `block-sudo` wrote the other's.
 *
 * This file renders the real Configure Policies tab against that exact shape.
 * Every case exercises BOTH rows, or the lower one specifically: a match that
 * resolves by position rather than by identity gets the upper row right and is
 * indistinguishable from a correct one until somebody clicks the other.
 */

// Returns what the real server action returns. `togglePackPolicyAction` reports
// failure by RESOLVING to `{ ok: false, error }`, and the component now reads
// that field, so a stub resolving to `undefined` puts every click below on the
// failure path — error banner, refetch, row reverted — and none of these cases
// would be testing the success path they read as testing.
const togglePackPolicyAction = vi.fn(async () => ({ ok: true, id: "alpha" }));
const updatePolicyParamsAction = vi.fn(async () => {});
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
// that reach the filesystem on import; the test is about the client-side
// identity of a row, so none of them may actually run.
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
  togglePackPolicyAction: (...args: unknown[]) => togglePackPolicyAction(...(args as [])),
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
  updatePolicyParamsAction: (...args: unknown[]) => updatePolicyParamsAction(...(args as [])),
}));

import HooksClient from "@/app/policies/hooks-client";
import { packPolicyParamKey } from "@/src/hooks/policy-evaluator";

/** The description is the only thing that tells the two identical rows apart. */
const ALPHA_DESC = "alpha pack take on sudo";
const BETA_DESC = "beta pack take on sudo";

function makePayload(): HooksConfigPayload {
  const policy = (packId: string, description: string, limit: number) => ({
    name: "block-sudo",
    description,
    category: "safety",
    defaultEnabled: true,
    beta: false,
    enabled: true,
    eventScope: "PreToolUse · Bash",
    packId,
    packVersion: "1.0.0",
    // Parameters, because the params surface is keyed on the policy too: the
    // chip on the row and the modal's inputs both read `currentParams`, and the
    // Save writes back under one pack's key. Distinct values per pack so a row
    // showing the other pack's configuration is visible rather than plausible.
    params: { limit: { type: "number", description: "seconds", default: 0 } },
    currentParams: { limit },
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
    policies: [policy("alpha", ALPHA_DESC, 11), policy("beta", BETA_DESC, 22)],
    conventionPolicies: [],
    packs: [
      {
        id: "alpha",
        version: "1.0.0",
        source: "github:acme/alpha@v1.0.0",
        effect: "enforce" as const,
        policies: [{ name: "block-sudo", description: ALPHA_DESC, category: "safety", enabled: true }],
      },
      {
        id: "beta",
        version: "2.0.0",
        source: "github:acme/beta@v2.0.0",
        effect: "enforce" as const,
        policies: [{ name: "block-sudo", description: BETA_DESC, category: "safety", enabled: true }],
      },
    ],
  };
}

let payload: HooksConfigPayload = makePayload();

/** The toggle for the row whose description names the pack. */
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

describe("two installed packs declaring the same policy name", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    payload = makePayload();
    togglePackPolicyAction.mockClear();
    updatePolicyParamsAction.mockClear();
    getHooksConfigAction.mockClear();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("renders both rows without a duplicate React key", async () => {
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(ALPHA_DESC);
    expect(screen.getByText(BETA_DESC)).toBeInTheDocument();
    // Both rows really are on screen — a duplicate key does not always drop one.
    expect(screen.getAllByText("block-sudo")).toHaveLength(2);

    const keyWarnings = (consoleError.mock.calls as unknown[][]).filter((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("same key")),
    );
    expect(keyWarnings).toEqual([]);
  });

  it("toggling one pack's policy leaves the other pack's row alone", async () => {
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(ALPHA_DESC);

    expect(stateOf(ALPHA_DESC)).toBe("Disable policy");
    expect(stateOf(BETA_DESC)).toBe("Disable policy");

    await user.click(toggleFor(ALPHA_DESC));

    // The clicked row flips, and only that row. Before the fix beta flipped
    // too, advertising a change that was never written for it.
    await waitFor(() => expect(stateOf(ALPHA_DESC)).toBe("Enable policy"));
    expect(stateOf(BETA_DESC)).toBe("Disable policy");

    // The write named alpha alone — that is the identity the optimistic update
    // now matches on.
    expect(togglePackPolicyAction).toHaveBeenCalledTimes(1);
    expect(togglePackPolicyAction).toHaveBeenCalledWith("alpha", "block-sudo", false);
  });

  it("counts one policy off, not two, in the category header", async () => {
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(ALPHA_DESC);
    expect(screen.getByText("2 / 2 enabled")).toBeInTheDocument();

    await user.click(toggleFor(ALPHA_DESC));

    // The header counts the same flat list the rows come from, so the conflated
    // update showed "0 / 2 enabled" — one click reading as two policies off.
    await waitFor(() => expect(screen.getByText("1 / 2 enabled")).toBeInTheDocument());
  });
});

describe("the pack summary each duplicate row belongs to", () => {
  beforeEach(() => {
    payload = makePayload();
    togglePackPolicyAction.mockClear();
    updatePolicyParamsAction.mockClear();
    getHooksConfigAction.mockClear();
  });

  /** A pack's block in the Policy packs section, found by its Remove button. */
  const packBlock = (id: string) =>
    screen.getByLabelText(`Remove ${id}`).closest("div")!.parentElement!;

  /**
   * `handleToggle` writes TWO optimistic updates — the flat policy list and the
   * pack's own selection, which the Policy packs section renders as "n of m
   * on". Nothing covered the second one, so the guard that scopes it to the
   * clicked pack could be dropped and every other assertion in this file would
   * still pass while both packs' summaries moved on one click.
   */
  it("moves only the clicked pack's on-count", async () => {
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(ALPHA_DESC);
    expect(packBlock("alpha").textContent).toContain("1 of 1 on");
    expect(packBlock("beta").textContent).toContain("1 of 1 on");

    await user.click(toggleFor(ALPHA_DESC));

    await waitFor(() => expect(packBlock("alpha").textContent).toContain("0 of 1 on"));
    expect(packBlock("beta").textContent).toContain("1 of 1 on");
  });
});

describe("the second duplicate row is not the first one", () => {
  beforeEach(() => {
    payload = makePayload();
    togglePackPolicyAction.mockClear();
    updatePolicyParamsAction.mockClear();
    getHooksConfigAction.mockClear();
  });

  /**
   * The suite above only ever clicks the FIRST of the two rows. A match that
   * resolves by position rather than by identity — `findIndex`, "the first row
   * with this name" — passes every one of those assertions and still writes the
   * wrong pack the moment somebody clicks the lower row, which is the row a
   * third-party pack's policy usually is.
   */
  it("toggling the LOWER row writes that pack, not the first with the name", async () => {
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(BETA_DESC);

    await user.click(toggleFor(BETA_DESC));

    await waitFor(() => expect(stateOf(BETA_DESC)).toBe("Enable policy"));
    expect(stateOf(ALPHA_DESC)).toBe("Disable policy");
    expect(togglePackPolicyAction).toHaveBeenCalledWith("beta", "block-sudo", false);
  });

  it("turning both off in turn is two writes, one per pack", async () => {
    // The optimistic state accumulates across clicks. A match that widened only
    // on the second pass — or a `packs` update that rewrote the wrong pack's
    // selection — shows up here and nowhere above.
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(ALPHA_DESC);

    await user.click(toggleFor(ALPHA_DESC));
    await waitFor(() => expect(stateOf(ALPHA_DESC)).toBe("Enable policy"));
    await user.click(toggleFor(BETA_DESC));
    await waitFor(() => expect(stateOf(BETA_DESC)).toBe("Enable policy"));

    expect(togglePackPolicyAction.mock.calls).toEqual([
      ["alpha", "block-sudo", false],
      ["beta", "block-sudo", false],
    ]);
  });
});

describe("each duplicate row configures its OWN pack", () => {
  beforeEach(() => {
    payload = makePayload();
    togglePackPolicyAction.mockClear();
    updatePolicyParamsAction.mockClear();
    getHooksConfigAction.mockClear();
  });

  /** The gear that opens the parameters modal — the row's second button. */
  function configureFor(description: string): HTMLElement {
    const row = screen.getByText(description).closest("div.flex.items-start");
    if (!row) throw new Error(`no policy row found for ${description}`);
    const buttons = row.querySelectorAll("button");
    const gear = buttons[1];
    if (!gear) throw new Error(`no configure button in the row for ${description}`);
    return gear as HTMLElement;
  }

  /**
   * The write side, driven through the real component rather than mirrored.
   * `handleSaveParams` builds the key off `configuringPolicy.packId`, and the
   * node-side test can only assert on the SOURCE of that expression, because it
   * lives in a client component. Two identically named rows are exactly where a
   * key built from the name alone stops being distinguishable.
   *
   * Both rows, because one of them proves nothing on its own: a save that
   * always reached for the first row carrying this name writes alpha's key and
   * alpha's value, and the alpha case alone would call that correct.
   */
  it.each([
    ["alpha", ALPHA_DESC, 11],
    ["beta", BETA_DESC, 22],
  ] as const)("configuring the %s row saves that pack's key and value", async (packId, description, limit) => {
    const user = userEvent.setup();
    render(<HooksClient initialTab="policies" />);
    await screen.findByText(description);

    // The chip is the same `currentParams` the modal seeds from, so read it
    // first: it says which pack's configuration this row believes is its own.
    const row = screen.getByText(description).closest("div.flex.items-start")!;
    expect(row.textContent).toContain(String(limit));

    await user.click(configureFor(description));
    await user.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => expect(updatePolicyParamsAction).toHaveBeenCalledTimes(1));
    expect(updatePolicyParamsAction).toHaveBeenCalledWith(
      packPolicyParamKey(packId, "block-sudo"),
      { limit },
    );
  });
});
