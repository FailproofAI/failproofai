"use client";

/**
 * The Jev panel on /settings — the dashboard's half of `failproofai jev setup`.
 *
 * ## What it is for
 *
 * Jev is the optional second evaluation tier. It is on when, and only when, a
 * valid `~/.failproofai/jev.json` exists; without it the hook path is byte for
 * byte what it was before. So this panel has two jobs, in this order:
 *
 *   1. say whether it is on, in which mode, against which provider and model,
 *      how much of the enabled policy set it is allowed to clear, and — once it
 *      has run — how often it fell back to the regex engine. A panel that only
 *      took input would leave "is this thing working" unanswerable from the
 *      dashboard.
 *   2. take the endpoint and the token.
 *
 * Each fact is stated ONCE. The status block says nothing the form below it
 * already holds: the endpoint and the account id are form values, and printing
 * them above the fields put a per-account URL — and the id inside it — twice on
 * one screen. The config file's path and permission bits are gone for a
 * different reason: nobody repairs a 0644 from a browser, and the loader's own
 * refusal already names the file when it matters.
 *
 * It is a full-width cell in the same hairline console as the scheduled-audit
 * panel, using the same tokens, the same `.btn-press` action and the same
 * `toast()` on success. No new colour and no new control that did not already
 * exist on this page, except a `<select>` — five providers do not fit a switch.
 *
 * ## The token is write-only
 *
 * The field is always blank on load, whatever is stored. `JevSettingsView`
 * carries presence and nothing else, so the panel can say "configured" — or
 * that the key is read from the environment — and no more; the value itself
 * never leaves the machine's filesystem, and neither does a fragment of it.
 * Leaving the field empty on save KEEPS the key where it is — the stored one, or
 * the environment's for a config that takes it from there — which the server
 * decides, not this component.
 *
 * The stored MODEL is shown the same way when it does not look like a model id,
 * for the same reason: it is the one routing field someone can paste a key into.
 * The panel gets a `JevModelView`, never the string, so there is nothing here to
 * leak even by accident. It is display-only — the form does not offer the field,
 * and a save leaves whatever is stored alone.
 *
 * Client-side validation here is a convenience only. Every rule — the URL
 * scheme, plain http being refused outside shadow mode, cloudflare's account id
 * — is enforced server-side by the same `validateJevConfig` the loader runs.
 *
 * ## FailproofAI Cloud
 *
 * When `jev.json` names the FailproofAI Cloud provider, the endpoint and the
 * key are not this page's to edit: both come from the machine's connection
 * (`config --token`). So the form is replaced by the two controls that are
 * the owner's — an on/off switch and shadow/enforce — both through
 * `setJevModeAction`, which rewrites `mode` and nothing else. "Off" there keeps
 * the file (`mode: "off"`): deleting it would leave nothing on this page to
 * switch back on — the only way to get the file back would be re-running
 * `config --token` with the key.
 *
 * The connection itself — org, and whether the key carries Jev — is one row,
 * read from `credentials.json` by the server with no network call; the key is
 * never part of what this component receives.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  getJevSettingsAction,
  type JevModelView,
  type JevSettingsView,
} from "@/app/actions/get-jev-config";
import {
  removeJevConfigAction,
  saveJevConfigAction,
  setJevModeAction,
} from "@/app/actions/update-jev-config";
import { toast } from "@/app/components/toast";

const PROVIDERS = [
  { value: "typesafe", label: "typesafe" },
  { value: "openrouter", label: "openrouter" },
  { value: "vercel", label: "vercel ai gateway" },
  { value: "cloudflare", label: "cloudflare workers ai" },
  { value: "custom", label: "custom endpoint" },
] as const;

const MODES = [
  { value: "enforce", label: "enforce — jev's verdict counts" },
  { value: "shadow", label: "shadow — log only, regex decides" },
  { value: "off", label: "off — keep this config, don't ask jev" },
] as const;

/** The provider whose endpoint and key come from the FailproofAI Cloud connection. */
const CLOUD_PROVIDER = "failproofai";

/** What a provider is called on this page. */
function providerName(provider: string | null): string {
  return provider === CLOUD_PROVIDER ? "FailproofAI Cloud" : (provider ?? "");
}

/** The connection row: org, and whether the key carries Jev. No key, ever. */
function fmtConnection(cloud: JevSettingsView["cloud"] | undefined): string {
  if (!cloud || !cloud.connected) {
    return cloud?.jev === "yes" ? "a jev key is stored, but no connection is" : "not connected";
  }
  const where = cloud.org ?? cloud.host ?? "connected";
  const jev =
    cloud.jev === "yes"
      ? "key carries jev"
      : cloud.jev === "refused"
        ? "jev key refused — credentials.json is not owner-only"
        : "key does not carry jev";
  return `connected to ${where} · ${jev}`;
}

/** "24h" / "7d" / "30m", for the stats window. */
function fmtWindow(ms: number): string {
  const h = ms / 3_600_000;
  if (Number.isInteger(h) && h >= 1) return h % 24 === 0 ? `${h / 24}d` : `${h}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** A rate as a whole percent. 0.0417 → "4%". */
function fmtRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * The model row. `withheld` is the case worth having a row for at all: the file
 * holds something in that slot that does not look like a model id, which is
 * what a key pasted one field off looks like, so it is described and not
 * printed — and the server never sent it here to print. The loader's own reason
 * and its fix are already on the page above, in `view.problem`.
 */
function fmtModel(model: JevModelView): string {
  switch (model.kind) {
    case "id":
      return model.id;
    case "withheld":
      return "set to something that is not a model id — not shown here, in case it is a key";
    default:
      return "the provider's default";
  }
}

interface FormState {
  provider: string;
  baseUrl: string;
  accountId: string;
  mode: string;
}

function formFrom(view: JevSettingsView): FormState {
  return {
    // The form is the BYOK form: the Cloud provider is never one of its values.
    provider: view.provider && view.provider !== CLOUD_PROVIDER ? view.provider : "typesafe",
    baseUrl: view.baseUrl,
    accountId: view.accountId,
    mode: view.mode,
  };
}

/** One labelled control, laid out like the interval row above it. */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="set-field">
      <label className="set-field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <span className="set-hint">{hint}</span> : null}
    </div>
  );
}

export default function JevPanel({ initial }: { initial: JevSettingsView | null }) {
  const [view, setView] = useState<JevSettingsView | null>(initial);
  const [form, setForm] = useState<FormState>(
    initial ? formFrom(initial) : { provider: "typesafe", baseUrl: "", accountId: "", mode: "enforce" },
  );
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The server's `needsToken`: the one refusal whose remedy is this field, so it
   * is marked rather than leaving the person to match the message to a control.
   * The refusals that no token can settle deliberately do not set it.
   */
  const [needsToken, setNeedsToken] = useState(false);
  const mounted = useRef(true);
  /**
   * Whether the user has touched the form since the last read. A focus refresh
   * must not overwrite a half-typed endpoint with what is still on disk — the
   * page re-reads on every `visibilitychange`, which includes the tab hide that
   * happens when somebody alt-tabs to their password manager mid-edit.
   */
  const dirty = useRef(false);

  const reload = useCallback(async () => {
    try {
      const next = await getJevSettingsAction();
      if (!mounted.current) return;
      setView(next);
      if (!dirty.current) setForm(formFrom(next));
    } catch {
      // Leave what is on screen: it describes real machine state, and blanking
      // it would report something less true than what is already there.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  useEffect(() => {
    // Same reason as the scheduled-audit panel: `failproofai jev setup` in a
    // terminal changes the same file, and a page left open would otherwise keep
    // showing the old state until it was reloaded by hand.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [reload]);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    dirty.current = true;
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const onSave = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      // The form does not offer a model, so it says nothing about one: the
      // server keeps a stored model when the provider is unchanged, and drops it
      // for the new provider's default when it is not — the same rule `jev setup`
      // applies. `JevConfigInput` has no model field for this to get wrong.
      const res = await saveJevConfigAction({
        provider: form.provider,
        baseUrl: form.baseUrl,
        accountId: form.accountId,
        mode: form.mode,
        token,
      });
      if (!res.ok) {
        setProblem(res.problem);
        setNeedsToken(res.needsToken === true);
        return;
      }
      dirty.current = false;
      setNeedsToken(false);
      setToken("");
      setView(res.view);
      setForm(formFrom(res.view));
      toast(res.view.on ? "jev is on." : "saved.");
    } catch {
      setProblem("could not save that.");
    } finally {
      setBusy(false);
    }
  }, [form, token]);

  /**
   * The FailproofAI Cloud switch: `off`, `shadow` or `enforce`, and nothing
   * else about the file changes (see `setJevModeAction`).
   */
  const onMode = useCallback(async (mode: "off" | "shadow" | "enforce") => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await setJevModeAction(mode);
      if (!res.ok) {
        setProblem(res.problem);
        return;
      }
      dirty.current = false;
      setView(res.view);
      setForm(formFrom(res.view));
      toast(mode === "off" ? "jev is off. hooks run the regex policies." : `jev is on, in ${mode} mode.`);
    } catch {
      setProblem("could not switch that.");
    } finally {
      setBusy(false);
    }
  }, []);

  const onRemove = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    setNeedsToken(false);
    try {
      const res = await removeJevConfigAction();
      if (!res.ok) {
        setProblem(res.problem);
        return;
      }
      dirty.current = false;
      setToken("");
      setView(res.view);
      setForm(formFrom(res.view));
      toast("jev is off. hooks run the regex policies.");
    } catch {
      setProblem("could not turn that off.");
    } finally {
      setBusy(false);
    }
  }, []);

  const configured = view !== null && view.status !== "absent";
  const cloudRoute = view?.provider === CLOUD_PROVIDER;
  const stored = view?.token;
  const tokenHint = needsToken
    ? "needed for this save — type the token for this endpoint"
    : stored
      ? stored.source === "cloud"
        ? "from this machine's FailproofAI Cloud connection"
        : stored.source === "env"
        ? "configured, read from the environment — leave blank to keep it"
        : // Presence and the keep rule, which is everything this field's reader
          // has to decide. Naming the last four characters of the stored key
          // here put that fragment on the page a second time, next to the input
          // it would be re-typed into.
          "configured — leave blank to keep it"
      : // The file names the environment as the key's source and the variable is
        // unset in this process. Leaving the field blank keeps that arrangement,
        // which is not the same thing as "there is no key" — the endpoint and the
        // mode are editable from here without one.
        view?.status === "key-missing"
        ? "read from the environment, which is not set in this shell — leave blank to keep it that way"
        : "sent as a bearer token; stored owner-only at 0600";

  return (
    <div className="set-cell set-jev">
      <h2 className="set-cell-title">jev · semantic evaluation</h2>

      <div className="set-row set-row-main">
        <div className="set-row-copy">
          <span className={view?.on ? "set-strong" : "set-dim"}>
            {view === null
              ? "reading…"
              : view.on
                ? `on. every judged command is also asked of ${providerName(view.provider)}.`
                : view.status === "off"
                  ? "off — switched off. hooks run the regex policies exactly as before."
                  : view.status === "not-connected"
                    ? "off — this machine is not connected to FailproofAI Cloud. hooks run the regex policies."
                    : view.status === "key-lacks-jev"
                      ? "off — this machine's FailproofAI Cloud key does not carry jev. hooks run the regex policies."
                      : "off. hooks run the regex policies exactly as before."}
          </span>
          <span className="set-dim">
            {view?.on
              ? view.mode === "shadow"
                ? "shadow: jev's answers are logged, the regex result is what gets enforced."
                : "enforce: jev's answers can clear a reviewable deny."
              : cloudRoute
                ? "through FailproofAI Cloud, on your org's plan — no endpoint or token of your own."
                : "a second opinion on the commands the regex policies flag. needs your own endpoint and token."}
          </span>
        </div>
      </div>

      {/* Where requests GO is not in this block, deliberately. The editable
          field below holds it, and for Cloudflare that URL is
          `/accounts/<id>/ai/run` — so a read-only row above the form printed the
          same per-account address, and the account id inside it, a second time
          on one screen. The path of the config file and its mode were here too;
          nobody acts on either from a browser. */}
      {/* The FailproofAI Cloud connection, on every state: whether this
          machine could run Jev through the Cloud is worth knowing before it
          does. Org and a yes/no, never a key. */}
      {view && (
        <dl className="set-how-list set-jev-cloud">
          <div className="set-how-row">
            <dt className="set-how-label">FailproofAI Cloud connection</dt>
            <dd className="set-how-body">{fmtConnection(view.cloud)}</dd>
          </div>
        </dl>
      )}

      {view && configured && (
        <dl className="set-how-list">
          {cloudRoute && (
            <div className="set-how-row">
              <dt className="set-how-label">provider</dt>
              <dd className="set-how-body">
                {view.cloud?.host ? `FailproofAI Cloud · ${view.cloud.host}` : "FailproofAI Cloud"}
              </dd>
            </div>
          )}
          <div className="set-how-row">
            <dt className="set-how-label">model</dt>
            <dd className="set-how-body">{fmtModel(view.model)}</dd>
          </div>
          {/* Presence, and where it came from. Not four characters of it: that
              is a recognisable fragment of a live credential on a page with no
              authentication, and it tells the reader nothing they cannot get by
              re-pasting the key. The server no longer sends it either. */}
          <div className="set-how-row">
            <dt className="set-how-label">token</dt>
            <dd className="set-how-body">
              {stored
                ? stored.source === "cloud"
                  ? "FailproofAI Cloud connection"
                  : stored.source === "env"
                    ? "from FAILPROOFAI_JEV_API_KEY"
                    : "configured"
                : cloudRoute
                  ? view.cloud?.connected
                    ? "none — this machine's key does not carry jev"
                    : "none — this machine is not connected"
                  : "none stored"}
            </dd>
          </div>
          {view.reviewable && (
            <div className="set-how-row">
              <dt className="set-how-label">reviewable</dt>
              {/* The count, in the server's words — the same sentence
                  `failproofai jev status` prints, because the two surfaces must
                  not disagree about what Jev is allowed to clear. */}
              <dd className="set-how-body">{view.reviewable.summary}</dd>
            </div>
          )}
          {view.stats && view.stats.total > 0 && (
            <div className="set-how-row">
              <dt className="set-how-label">fallbacks</dt>
              {/* One string, not an interpolated fragment: a sentence split
                  across text nodes is a sentence a screen reader and a test both
                  have to reassemble. */}
              <dd className="set-how-body">
                {`${fmtRate(view.stats.fallbackRate)} of ${view.stats.total} calls in the last ${fmtWindow(view.stats.windowMs)} fell back to the regex engine.`}
              </dd>
            </div>
          )}
        </dl>
      )}

      {view?.problem && (
        <p className="set-warn">
          {view.problem}
          {view.fix ? ` — ${view.fix}` : ""}
        </p>
      )}

      {/* Jev is on, answering, and cannot clear a single verdict. Nothing else
          on this page shows it: a policy set with no authority marks behaves
          exactly like a healthy one until you notice that nothing is ever
          cleared. The server sends the cause and the remedy together. */}
      {view?.reviewable?.problem && <p className="set-warn">{view.reviewable.problem}</p>}

      <div className="set-rule" />

      {cloudRoute ? (
        <>
          <div className="set-jev-fields">
            <Field
              id="jev-cloud-mode"
              label="mode"
              hint="the endpoint and key come from this machine's FailproofAI Cloud connection"
            >
              <select
                id="jev-cloud-mode"
                className="set-select"
                value={view?.mode === "enforce" ? "enforce" : "shadow"}
                disabled={busy || view?.mode === "off"}
                onChange={(e) => void onMode(e.target.value === "enforce" ? "enforce" : "shadow")}
              >
                {MODES.filter((m) => m.value !== "off").map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {problem && <p className="set-warn">{problem}</p>}

          <div className="set-actions set-jev-actions">
            <button
              type="button"
              className="btn btn-press"
              disabled={busy}
              onClick={() => void onMode(view?.mode === "off" ? "shadow" : "off")}
            >
              {busy ? "[ switching… ]" : view?.mode === "off" ? "[ turn jev on ]" : "[ turn jev off ]"}
            </button>
          </div>
        </>
      ) : (
      <>
      <div className="set-jev-fields">
        <Field id="jev-provider" label="provider">
          <select
            id="jev-provider"
            className="set-select"
            value={form.provider}
            disabled={busy}
            onChange={(e) => set("provider", e.target.value)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id="jev-url"
          label="endpoint url"
          hint={[
            form.provider === "custom"
              ? "required — https, or http to localhost in shadow mode"
              : "leave blank for the provider's own api",
            // The stored query string is not sent to this page (see
            // `baseUrlView` in `get-jev-config.ts`), so the field holds the URL
            // without it. Said out loud, because the alternative is a field that
            // silently disagrees with the file and a save that looks like it
            // kept something the person was never shown.
            view?.baseUrlQueryWithheld
              ? "the stored url's query string is not shown here — leave the url as it is to keep it"
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <input
            id="jev-url"
            type="text"
            className="set-text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={form.provider === "custom" ? "https://…" : "the provider's own api"}
            value={form.baseUrl}
            disabled={busy}
            onChange={(e) => set("baseUrl", e.target.value)}
          />
        </Field>

        {form.provider === "cloudflare" && (
          <Field id="jev-account" label="account id" hint="32 lowercase hex characters">
            <input
              id="jev-account"
              type="text"
              className="set-text"
              autoComplete="off"
              spellCheck={false}
              value={form.accountId}
              disabled={busy}
              onChange={(e) => set("accountId", e.target.value)}
            />
          </Field>
        )}

        <Field id="jev-token" label="token" hint={tokenHint}>
          <input
            id="jev-token"
            type="password"
            className="set-text"
            autoComplete="off"
            spellCheck={false}
            placeholder={stored ? "•••• kept" : ""}
            value={token}
            disabled={busy}
            aria-invalid={needsToken || undefined}
            onChange={(e) => {
              dirty.current = true;
              setToken(e.target.value);
            }}
          />
        </Field>

        <Field id="jev-mode" label="mode">
          <select
            id="jev-mode"
            className="set-select"
            value={form.mode}
            disabled={busy}
            onChange={(e) => set("mode", e.target.value)}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {problem && <p className="set-warn">{problem}</p>}

      <div className="set-actions set-jev-actions">
        <button type="button" className="btn btn-press" disabled={busy} onClick={() => void onSave()}>
          {busy ? "[ saving… ]" : configured ? "[ save changes ]" : "[ turn jev on ]"}
        </button>
        {configured && (
          <button type="button" className="set-link" disabled={busy} onClick={() => void onRemove()}>
            turn jev off
          </button>
        )}
      </div>
      </>
      )}
    </div>
  );
}
