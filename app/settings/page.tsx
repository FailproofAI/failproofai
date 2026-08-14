import type { Metadata } from "next";
import {
  getScheduledAuditAction,
  type ScheduledAuditView,
} from "@/app/actions/get-scheduled-audit";
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
  let initial: ScheduledAuditView | null = null;
  try {
    initial = await getScheduledAuditAction();
  } catch {
    // Left null; the client renders the unreadable-config message. Throwing
    // here would replace a page that can explain itself with an error boundary
    // that cannot.
  }
  return <SettingsClient initial={initial} />;
}
