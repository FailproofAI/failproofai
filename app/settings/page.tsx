import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getScheduledAuditAction,
  type ScheduledAuditView,
} from "@/app/actions/get-scheduled-audit";
import {
  getJevSettingsAction,
  type JevSettingsView,
} from "@/app/actions/get-jev-config";
import JevPanel from "./jev-panel";
import SettingsClient from "./settings-client";

export const metadata: Metadata = {
  title: "settings · failproof_ai",
  description: "Scheduled audits for this machine.",
};

export const dynamic = "force-dynamic";

/**
 * Machine-scoped settings.
 *
 * The state is read HERE, on the server, and handed to the client as its
 * initial value — rather than fetched from a `useEffect` after mount. The
 * difference is visible: with a client-side load the page paints "off. nothing
 * runs and nothing is sent." and then flips to the truth a moment later, so a
 * page whose whole job is to tell you whether a security feature is on spends
 * its first frame telling you the opposite. It reads from local files, so there
 * is no latency argument for deferring it either.
 *
 * `force-dynamic` because that state is `~/.failproofai/config.json` and the
 * daemon's status — a cached render would show a stale machine.
 */
export default async function SettingsPage() {
  // Same gate the audit, policies and projects pages carry. It was dropped in
  // the rewrite, and this is the page that least deserves to lose it: it shows
  // the address digests go to and can sign the machine out, on a dashboard an
  // operator may deliberately be exposing beyond localhost.
  const disabled = (process.env.FAILPROOFAI_DISABLE_PAGES ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (disabled.includes("settings")) notFound();

  let initial: ScheduledAuditView | null = null;
  try {
    initial = await getScheduledAuditAction();
  } catch {
    // Left null; the client renders the unreadable-config message. Throwing
    // here would replace a page that can explain itself with an error boundary
    // that cannot.
  }
  // Same reasoning as above, for the same reason it matters more here: this
  // panel's headline fact is whether a second evaluator is switched on, and a
  // client-side load would paint "off" first and correct itself after.
  // `getJevSettingsAction` does not throw, but a failed read must not take the
  // scheduled-audit panel down with it either.
  let jev: JevSettingsView | null = null;
  try {
    jev = await getJevSettingsAction();
  } catch {
    // Left null; the panel reads as "reading…" until the client load lands.
  }
  // The panel is composed in rather than imported by `SettingsClient`, so the
  // scheduled-audit console and the Jev console share a layout without sharing
  // a dependency — see the `jevPanel` prop.
  return <SettingsClient initial={initial} jevPanel={<JevPanel initial={jev} />} />;
}
