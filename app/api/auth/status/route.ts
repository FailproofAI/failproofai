/**
 * GET /api/auth/status
 *
 * Returns the currently signed-in identity by reading the local
 * `~/.failproofai/auth.json` cache. No round-trip to the api-server — the
 * file is the source of truth for who is signed in on this machine.
 * This keeps the dashboard UI and the CLI consistent regardless of whether
 * the api-server is reachable.
 *
 * Also returns the user's persisted re-audit reminder (if any). The reminder
 * lives in ~/.failproofai/next-audit.json and is only surfaced when its
 * `user_email` matches the active session — so swapping accounts via CLI
 * does not leak a previous user's reminder into the dashboard.
 */
import { NextResponse } from "next/server";
import { readAuth, readReminder } from "@/lib/auth/auth-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const auth = readAuth();
  if (!auth) {
    return NextResponse.json({ authenticated: false, reminder: null }, { status: 200 });
  }
  const reminderRaw = readReminder();
  const reminder =
    reminderRaw && reminderRaw.user_email === auth.user.email
      ? {
          next_audit_at: reminderRaw.next_audit_at,
          user_email: reminderRaw.user_email,
          set_at: reminderRaw.set_at,
        }
      : null;
  return NextResponse.json(
    {
      authenticated: true,
      user: { id: auth.user.id, email: auth.user.email },
      reminder,
    },
    { status: 200 },
  );
}
