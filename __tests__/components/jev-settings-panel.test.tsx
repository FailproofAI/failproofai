/**
 * The /settings Jev panel.
 *
 * The properties worth pinning are the ones that decide whether a person can
 * tell what their machine is doing, plus the one that decides whether the token
 * is safe: the field is write-only, the saved value is never rendered, and
 * leaving it blank means "keep what is stored" rather than "clear it".
 *
 * The server actions are mocked. What they do with the file is covered in
 * `__tests__/actions/update-jev-config.test.ts`, against the real loader.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { getViewMock, saveMock, removeMock, modeMock, toastMock } = vi.hoisted(() => ({
  getViewMock: vi.fn(),
  saveMock: vi.fn(),
  removeMock: vi.fn(),
  modeMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@/app/actions/get-jev-config", () => ({ getJevSettingsAction: getViewMock }));
vi.mock("@/app/actions/update-jev-config", () => ({
  saveJevConfigAction: saveMock,
  removeJevConfigAction: removeMock,
  setJevModeAction: modeMock,
}));
vi.mock("@/app/components/toast", () => ({ toast: toastMock }));

import JevPanel from "@/app/settings/jev-panel";
import type { JevSettingsView } from "@/app/actions/get-jev-config";

/** A token no provider issued. It must never appear in the DOM. */
const TOKEN = "jevtoken-0123456789-3f2a";

function view(over: Partial<JevSettingsView> = {}): JevSettingsView {
  return {
    status: "absent",
    on: false,
    // This machine's FailproofAI Cloud connection, from credentials.json.
    cloud: { connected: false, org: null, host: null, jev: "no" },
    path: "/tmp/fpai/jev.json",
    permissions: null,
    provider: null,
    baseUrl: "",
    // The server never sends the stored query string; this says whether there
    // was one, so the field can admit it is showing less than the file holds.
    baseUrlQueryWithheld: false,
    accountId: "",
    // A view, not a form value: the panel is handed what it may SAY about the
    // stored model, never the stored string.
    model: { kind: "default" },
    endpoint: null,
    mode: "enforce",
    timeoutMs: null,
    token: null,
    problem: null,
    fix: null,
    stats: null,
    // What Jev may clear. Null is the off state, and also what the server sends
    // when it could not read the policy set.
    reviewable: null,
    ...over,
  };
}

function configured(over: Partial<JevSettingsView> = {}): JevSettingsView {
  return view({
    status: "ok",
    on: true,
    provider: "typesafe",
    permissions: "0600",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    token: { source: "file" },
    timeoutMs: 3000,
    ...over,
  });
}

/**
 * Render the way the real page does: the SERVER seeds `initial`, and the panel
 * refreshes from the same action on mount. A client-only render would test a
 * first frame no user ever sees.
 */
function renderPanel(initial: JevSettingsView | null) {
  getViewMock.mockResolvedValue(initial ?? view());
  return render(<JevPanel initial={initial} />);
}

beforeEach(() => {
  getViewMock.mockReset().mockResolvedValue(view());
  saveMock.mockReset();
  removeMock.mockReset();
  modeMock.mockReset();
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("what it says about the machine", () => {
  it("says Jev is off, and that the regex path is unchanged", async () => {
    renderPanel(view());
    expect(screen.getByText(/off\. hooks run the regex policies/i)).toBeInTheDocument();
    // Nothing to turn off, so no destructive control is offered.
    expect(screen.queryByRole("button", { name: /turn jev off/i })).toBeNull();
    expect(screen.getByRole("button", { name: /turn jev on/i })).toBeInTheDocument();
  });

  it("distinguishes enforce from shadow, because they are different guarantees", async () => {
    renderPanel(configured({ mode: "shadow" }));
    expect(screen.getByText(/the regex result is what gets enforced/i)).toBeInTheDocument();
    cleanup();
    renderPanel(configured({ mode: "enforce" }));
    expect(screen.getByText(/can clear a reviewable deny/i)).toBeInTheDocument();
  });

  it("says each thing once: no endpoint row above the endpoint field, and no file row", async () => {
    // The endpoint the server computes is what the form field already holds —
    // and for Cloudflare that URL is `/accounts/<id>/ai/run`, so a read-only row
    // printed a per-account address, and the id inside it, a second time on one
    // screen. The config path and its mode are not something anybody acts on
    // from a browser; when they do decide something, `problem` and `fix` name
    // the file and the chmod (see the refused-file case below).
    renderPanel(
      configured({
        provider: "cloudflare",
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/abc/ai/run",
        accountId: "abc",
        endpoint: "https://api.cloudflare.com/client/v4/accounts/abc/ai/run",
        permissions: "0600",
      }),
    );
    await waitFor(() => expect(getViewMock).toHaveBeenCalled());
    // Once, as the value of the editable field — never as a second read-only row.
    expect(screen.getAllByDisplayValue("https://api.cloudflare.com/client/v4/accounts/abc/ai/run")).toHaveLength(1);
    expect(screen.queryByText("https://api.cloudflare.com/client/v4/accounts/abc/ai/run")).toBeNull();
    expect(screen.queryByText(/jev\.json/)).toBeNull();
    expect(screen.queryByText(/0600/)).toBeNull();
  });

  it("keeps the rows that answer whether it is working", async () => {
    // What the block is FOR: the model it asks, how much it may clear, and how
    // often it fell back. Removing the repeats must not take these with them.
    renderPanel(
      configured({
        model: { kind: "id", id: "typesafe/jev-1.13" },
        stats: { windowMs: 86_400_000, total: 72, answered: 69, fallbacks: 3, fallbackRate: 0.04 },
        reviewable: { enabled: 38, reviewable: 17, summary: "17 of 38 enabled policies are reviewable.", problem: null },
      }),
    );
    expect(screen.getByText("typesafe/jev-1.13")).toBeInTheDocument();
    expect(screen.getByText(/17 of 38 enabled policies are reviewable/)).toBeInTheDocument();
    expect(screen.getByText(/4% of 72 calls in the last 1d/)).toBeInTheDocument();
    // The provider is still named — in the sentence that says Jev is on, and as
    // the value of the field that changes it.
    expect(screen.getByText(/also asked of typesafe/)).toBeInTheDocument();
  });

  it("shows the fallback rate so a person can see whether it is working", async () => {
    renderPanel(
      configured({
        stats: { windowMs: 86_400_000, total: 200, answered: 191, fallbacks: 9, fallbackRate: 0.045 },
      }),
    );
    // "1d", not "24h": the same window formatting `failproofai jev status`
    // prints, so the two surfaces describe one window the same way.
    expect(screen.getByText(/5% of 200 calls in the last 1d/i)).toBeInTheDocument();
  });

  it("shows a stored model id, which nothing else on the page says", async () => {
    renderPanel(configured({ model: { kind: "id", id: "typesafe/jev-1.13" } }));
    expect(screen.getByText("typesafe/jev-1.13")).toBeInTheDocument();
  });

  it("describes a model that is not a model id instead of printing it", async () => {
    // The server has already decided not to send the value — a key pasted one
    // field off would otherwise be echoed into the page by the row that exists
    // to help someone repair exactly that file.
    renderPanel(configured({ model: { kind: "withheld" } }));
    expect(screen.getByText(/not shown here, in case it is a key/i)).toBeInTheDocument();
  });

  it("says how much of the policy set Jev may clear", async () => {
    renderPanel(
      configured({
        reviewable: {
          enabled: 12,
          reviewable: 7,
          summary: "7 of 12 enabled policies are reviewable: Jev may clear a deny or an instruction from those, and from no others.",
          problem: null,
        },
      }),
    );
    expect(screen.getByText(/7 of 12 enabled policies are reviewable/i)).toBeInTheDocument();
  });

  it("warns when Jev is on and cannot clear anything, because nothing else on the page would", async () => {
    // The state an upgrade produces: a pack published before this release
    // declares no authority, so every policy is hard and the clear half of the
    // evaluator can never fire. The endpoint, the mode and the fallback rate
    // all look healthy in that state.
    renderPanel(
      configured({
        reviewable: {
          enabled: 11,
          reviewable: 0,
          summary: "0 of 11 enabled policies are reviewable.",
          problem:
            "Jev can add a deny or an instruction on this machine, but it can never clear one. " +
            "No enabled policy is marked reviewable — a policy pack published before this release carries no such marks — " +
            "so re-take the pack (`failproofai policies add FailproofAI/policies`) to get a marked copy, " +
            "or enforce this build's builtin policies, which carry them.",
        },
      }),
    );
    expect(screen.getByText(/0 of 11 enabled policies are reviewable/i)).toBeInTheDocument();
    expect(screen.getByText(/it can never clear one/i)).toBeInTheDocument();
    expect(screen.getByText(/failproofai policies add FailproofAI\/policies/i)).toBeInTheDocument();
  });

  it("says nothing about authority while Jev is off", async () => {
    renderPanel(view());
    await waitFor(() => expect(getViewMock).toHaveBeenCalled());
    expect(document.body.textContent ?? "").not.toMatch(/reviewable/i);
  });

  it("surfaces the loader's own reason when the file is refused, with the fix", async () => {
    renderPanel(
      view({
        status: "refused",
        problem: "its permissions are 0644; it holds a key, so it must be owner-only",
        fix: "chmod 600 /tmp/fpai/jev.json",
      }),
    );
    expect(screen.getByText(/its permissions are 0644/)).toBeInTheDocument();
    expect(screen.getByText(/chmod 600/)).toBeInTheDocument();
  });
});

describe("the token field is write-only", () => {
  it("never renders a stored token, nor any fragment of one — presence only", async () => {
    renderPanel(configured());
    await waitFor(() => expect(getViewMock).toHaveBeenCalled());
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(TOKEN);
    // It used to say "configured, ending 3f2a" in two places at once: the status
    // row and the field's hint. Four characters of a live key are a recognisable
    // piece of it on a page with no authentication, and they answer nothing the
    // reader could not settle by re-pasting the key. The server does not send
    // them any more, so there is nothing here to print.
    expect(text).not.toContain(TOKEN.slice(-4));
    expect(text).not.toMatch(/ending/i);
    expect(screen.getAllByText(/configured/i).length).toBeGreaterThan(0);
    // The one thing the field's reader has to know is still said.
    expect(screen.getByText(/leave blank to keep it/i)).toBeInTheDocument();
  });

  it("is a password field and starts empty even when one is stored", async () => {
    renderPanel(configured());
    const field = screen.getByLabelText("token") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.value).toBe("");
  });

  it("sends a blank token when nothing was typed, which the server reads as keep", async () => {
    saveMock.mockResolvedValue({ ok: true, view: configured({ mode: "shadow" }) });
    renderPanel(configured());
    fireEvent.change(screen.getByLabelText("mode"), { target: { value: "shadow" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "typesafe", mode: "shadow", token: "" }),
    );
  });

  it("sends a typed token and then clears the field", async () => {
    saveMock.mockResolvedValue({ ok: true, view: configured() });
    renderPanel(view());
    const field = screen.getByLabelText("token") as HTMLInputElement;
    fireEvent.change(field, { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /turn jev on/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }));
    // Cleared on success, so the value is not sitting in a form field for the
    // rest of the session.
    await waitFor(() => expect((screen.getByLabelText("token") as HTMLInputElement).value).toBe(""));
  });
});

describe("the form", () => {
  it("sends no model at all, so a save cannot clear the stored one", async () => {
    saveMock.mockResolvedValue({ ok: true, view: configured({ mode: "shadow" }) });
    renderPanel(configured({ model: { kind: "id", id: "typesafe/jev-1.13" } }));
    fireEvent.change(screen.getByLabelText("mode"), { target: { value: "shadow" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    // Not "sends an empty model": an empty string is what the server used to
    // read as "clear it".
    expect(Object.keys(saveMock.mock.calls[0][0] as object)).not.toContain("model");
  });

  it("marks the token field when the server says that is what is missing", async () => {
    saveMock.mockResolvedValue({
      ok: false,
      problem: "that endpoint is not the one the stored token was given for, so it is not sent there. enter the token for it.",
      needsToken: true,
    });
    renderPanel(configured());
    fireEvent.change(screen.getByLabelText("endpoint url"), { target: { value: "https://elsewhere.example" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));

    const field = screen.getByLabelText("token") as HTMLInputElement;
    await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText(/needed for this save/i)).toBeInTheDocument();
  });

  it("says a key read from the environment stays there when the field is left blank", async () => {
    // The state the panel used to refuse to save at all, with a message about a
    // stored token that this config deliberately does not have.
    renderPanel(
      view({
        status: "key-missing",
        provider: "custom",
        baseUrl: "https://mine.example",
        problem: "no API key: set apiKey in the file, or FAILPROOFAI_JEV_API_KEY for this session",
      }),
    );
    expect(screen.getByText(/read from the environment, which is not set in this shell/i)).toBeInTheDocument();
    expect((screen.getByLabelText("endpoint url") as HTMLInputElement).value).toBe("https://mine.example");
  });

  it("asks for an account id only for cloudflare, because only cloudflare needs one", async () => {
    renderPanel(view());
    expect(screen.queryByLabelText("account id")).toBeNull();
    fireEvent.change(screen.getByLabelText("provider"), { target: { value: "cloudflare" } });
    expect(screen.getByLabelText("account id")).toBeInTheDocument();
  });

  it("says a custom endpoint is required, rather than leaving the field looking optional", async () => {
    renderPanel(view());
    fireEvent.change(screen.getByLabelText("provider"), { target: { value: "custom" } });
    expect(screen.getByText(/required — https/i)).toBeInTheDocument();
  });

  it("admits the endpoint field is showing less than the file holds", async () => {
    // The server does not send a stored query string — it is where a credential
    // fits, and a page on this origin is not authenticated. Without the hint the
    // field would silently disagree with the file, and an untouched save would
    // look like it kept something the person was never shown.
    renderPanel(configured({ provider: "custom", baseUrl: "https://gw.example.com/v1", baseUrlQueryWithheld: true }));
    expect(screen.getByText(/query string is not shown here/i)).toBeInTheDocument();
    cleanup();
    renderPanel(configured({ provider: "custom", baseUrl: "https://gw.example.com/v1" }));
    expect(screen.queryByText(/query string is not shown here/i)).toBeNull();
  });

  it("shows the server's refusal on the page instead of a generic failure", async () => {
    saveMock.mockResolvedValue({ ok: false, problem: "baseUrl is not a valid URL" });
    renderPanel(view());
    fireEvent.change(screen.getByLabelText("token"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /turn jev on/i }));
    await waitFor(() => expect(screen.getByText("baseUrl is not a valid URL")).toBeInTheDocument());
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a half-typed endpoint when the tab is refocused", async () => {
    // The page re-reads on every `visibilitychange`, which includes the tab hide
    // that happens when somebody alt-tabs to their password manager mid-edit.
    renderPanel(configured());
    const url = screen.getByLabelText("endpoint url") as HTMLInputElement;
    fireEvent.change(url, { target: { value: "https://half-ty" } });
    getViewMock.mockResolvedValue(configured());
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(getViewMock.mock.calls.length).toBeGreaterThan(1));
    expect((screen.getByLabelText("endpoint url") as HTMLInputElement).value).toBe("https://half-ty");
  });

  it("turns Jev off through the remove action and says what that means", async () => {
    removeMock.mockResolvedValue({ ok: true, view: view() });
    renderPanel(configured());
    fireEvent.click(screen.getByRole("button", { name: /turn jev off/i }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/regex policies/)));
    expect(screen.getByText(/off\. hooks run the regex policies/i)).toBeInTheDocument();
  });
});

// ── FailproofAI Cloud ────────────────────────────────────────────────────────

const CONNECTED = { connected: true, org: "Acme Inc (acme)", host: "app.befailproof.ai", jev: "yes" as const };

function cloudView(over: Partial<JevSettingsView> = {}): JevSettingsView {
  return view({
    status: "ok",
    on: true,
    provider: "failproofai",
    permissions: "0600",
    baseUrl: "https://app.befailproof.ai/enforcement/v1/jev",
    endpoint: "https://app.befailproof.ai/enforcement/v1/jev/systemone",
    token: { source: "cloud" },
    mode: "shadow",
    timeoutMs: 3000,
    cloud: CONNECTED,
    ...over,
  });
}

describe("the FailproofAI Cloud route", () => {
  it("names the provider as FailproofAI Cloud, and the connection row says org and Jev", async () => {
    renderPanel(cloudView());
    expect(screen.getByText(/also asked of FailproofAI Cloud/)).toBeInTheDocument();
    expect(screen.getByText("FailproofAI Cloud connection", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("connected to Acme Inc (acme) · key carries jev")).toBeInTheDocument();
    expect(screen.getByText("FailproofAI Cloud · app.befailproof.ai")).toBeInTheDocument();
    // The token row names the key's SOURCE, never the key.
    expect(screen.getByText("FailproofAI Cloud connection", { selector: "dd" })).toBeInTheDocument();
  });

  it("offers no endpoint or token field: those come from the connection", async () => {
    renderPanel(cloudView());
    expect(screen.queryByLabelText(/endpoint url/i)).toBeNull();
    expect(screen.queryByLabelText(/^token$/i)).toBeNull();
    expect(screen.queryByLabelText(/provider/i)).toBeNull();
  });

  it("switches off through the mode action — never by deleting the file", async () => {
    modeMock.mockResolvedValue({ ok: true, view: cloudView({ status: "off", on: false, mode: "off" }) });
    renderPanel(cloudView());
    fireEvent.click(screen.getByRole("button", { name: /turn jev off/i }));
    await waitFor(() => expect(modeMock).toHaveBeenCalledWith("off"));
    expect(removeMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/switched off/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /turn jev on/i })).toBeInTheDocument();
  });

  it("switches back on in shadow mode", async () => {
    modeMock.mockResolvedValue({ ok: true, view: cloudView() });
    renderPanel(cloudView({ status: "off", on: false, mode: "off" }));
    // Nothing to pick while it is off.
    expect(screen.getByLabelText(/^mode$/i)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /turn jev on/i }));
    await waitFor(() => expect(modeMock).toHaveBeenCalledWith("shadow"));
  });

  it("switches shadow to enforce with the mode control, and says a refusal", async () => {
    modeMock.mockResolvedValue({ ok: false, problem: "plain http is accepted only with mode shadow" });
    renderPanel(cloudView());
    fireEvent.change(screen.getByLabelText(/^mode$/i), { target: { value: "enforce" } });
    await waitFor(() => expect(modeMock).toHaveBeenCalledWith("enforce"));
    await waitFor(() => expect(screen.getByText(/plain http is accepted only with mode shadow/)).toBeInTheDocument());
  });

  it("not connected: says so, and what fixes it", async () => {
    renderPanel(
      cloudView({
        status: "not-connected",
        on: false,
        token: null,
        cloud: { connected: false, org: null, host: null, jev: "no" },
        problem: "this machine is not connected to FailproofAI Cloud with a key that carries jev:evaluate",
        fix: "connect this machine with a key that carries jev:evaluate: failproofai config --token <key>",
      }),
    );
    expect(screen.getByText(/this machine is not connected to FailproofAI Cloud\. hooks run/)).toBeInTheDocument();
    expect(screen.getByText("not connected")).toBeInTheDocument();
    expect(screen.getByText(/config --token/)).toBeInTheDocument();
  });

  it("connected with a key that has no Jev: says THAT, never \"not connected\"", async () => {
    renderPanel(
      cloudView({
        status: "key-lacks-jev",
        on: false,
        token: null,
        cloud: { ...CONNECTED, jev: "no" },
        problem: "this machine is connected to FailproofAI Cloud, but its key does not carry jev:evaluate",
        fix: "reconnect this machine with a key that carries jev:evaluate: failproofai config --token <key>",
      }),
    );
    expect(screen.getByText(/off — this machine's FailproofAI Cloud key does not carry jev\. hooks run/)).toBeInTheDocument();
    expect(screen.getByText("connected to Acme Inc (acme) · key does not carry jev")).toBeInTheDocument();
    expect(screen.queryByText(/not connected/)).toBeNull();
  });

  it("shows the connection row on a BYOK machine too, without taking over its form", async () => {
    renderPanel(configured({ cloud: { ...CONNECTED, jev: "no" } }));
    expect(screen.getByText("connected to Acme Inc (acme) · key does not carry jev")).toBeInTheDocument();
    expect(screen.getByLabelText(/endpoint url/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /turn jev off/i })).toBeInTheDocument();
  });
});
