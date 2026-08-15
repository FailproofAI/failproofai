/**
 * GET /api/auth/status
 *
 * Returns the currently signed-in identity by reading the local
 * `~/.failproofai/audit/session.json` cache. No round-trip to the api-server — the
 * file is the source of truth for who is signed in on this machine.
 * This keeps the dashboard UI and the CLI consistent regardless of whether
 * the api-server is reachable.
 *
 * Reminders are gone: the machine now audits itself on a timer and mails a
 * digest when it finds harm, so there is nothing to nudge anyone about. The
 * scheduled-scan state lives in `getScheduledAuditAction`, which reads it from
 * the config and the daemon rather than from here.
 */
import { NextResponse } from "next/server";
import { readAuth } from "@/lib/auth/auth-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const auth = readAuth();
  if (!auth) {
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }
  return NextResponse.json(
    {
      authenticated: true,
      user: { id: auth.user.id, email: auth.user.email },
    },
    { status: 200 },
  );
}
