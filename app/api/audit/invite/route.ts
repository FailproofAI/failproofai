/**
 * POST /api/audit/invite
 *
 * Browser-facing proxy for the api-server's POST /v0/invite — the user
 * supplies a list of friend emails, the api-server composes invite emails
 * (Cc'ing the sender so the recipient sees who invited them), and dispatches
 * them through the same email infrastructure that backs the OTP flow.
 *
 * Auth: requires an active session — same cookie/refresh-token contract as
 * /api/auth/reminder. Anonymous calls get 401 so the front-end can route to
 * the AuthDialog before retrying.
 *
 * Validation: max 10 recipients per call, each must look like an email.
 * Anything beyond that gets a 400 and never reaches upstream.
 *
 * Contract for the upstream endpoint is handed over to the platform team
 * separately.
 */
import { NextRequest, NextResponse } from "next/server";
import { whoAmI } from "@/lib/auth/auth-store";
import { AuthApiError, sendInvites } from "@/lib/auth/api-server-client";
import { initTelemetry, trackEvent } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

const MAX_RECIPIENTS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InviteBody {
  to?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  await initTelemetry();
  const who = await whoAmI();
  if (!who) {
    trackEvent("audit_invite_sent", { status: "unauthorized", source: "dashboard" });
    return NextResponse.json(
      { code: "unauthorized", message: "Sign in before sending invites." },
      { status: 401 },
    );
  }

  let body: InviteBody = {};
  const raw = await req.text();
  if (raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        trackEvent("audit_invite_sent", {
          status: "validation_error",
          source: "dashboard",
          reason: "not_an_object",
          user_id: who.me.id,
        });
        return NextResponse.json(
          { code: "validation_error", message: "Request body must be a JSON object." },
          { status: 400 },
        );
      }
      body = parsed as InviteBody;
    } catch {
      trackEvent("audit_invite_sent", {
        status: "validation_error",
        source: "dashboard",
        reason: "malformed_json",
        user_id: who.me.id,
      });
      return NextResponse.json(
        { code: "validation_error", message: "Request body is not valid JSON." },
        { status: 400 },
      );
    }
  }

  if (!Array.isArray(body.to)) {
    trackEvent("audit_invite_sent", {
      status: "validation_error",
      source: "dashboard",
      reason: "missing_to",
      user_id: who.me.id,
    });
    return NextResponse.json(
      { code: "validation_error", message: "`to` must be a list of email addresses." },
      { status: 400 },
    );
  }

  const normalised: string[] = [];
  const seen = new Set<string>();
  for (const entry of body.to) {
    if (typeof entry !== "string") continue;
    const e = entry.trim().toLowerCase();
    if (!e || !EMAIL_RE.test(e)) continue;
    if (e === who.me.email.toLowerCase()) continue; // can't invite yourself
    if (seen.has(e)) continue;
    seen.add(e);
    normalised.push(e);
  }

  if (normalised.length === 0) {
    trackEvent("audit_invite_sent", {
      status: "validation_error",
      source: "dashboard",
      reason: "no_valid_recipients",
      user_id: who.me.id,
      input_count: Array.isArray(body.to) ? body.to.length : 0,
    });
    return NextResponse.json(
      {
        code: "validation_error",
        message: "Provide at least one valid email address (other than your own).",
      },
      { status: 400 },
    );
  }

  if (normalised.length > MAX_RECIPIENTS) {
    trackEvent("audit_invite_sent", {
      status: "validation_error",
      source: "dashboard",
      reason: "too_many_recipients",
      user_id: who.me.id,
      input_count: normalised.length,
    });
    return NextResponse.json(
      {
        code: "validation_error",
        message: `Up to ${MAX_RECIPIENTS} recipients per invite batch. Please send the rest in a follow-up.`,
      },
      { status: 400 },
    );
  }

  try {
    const result = await sendInvites(who.auth.access_token, normalised);
    trackEvent("audit_invite_sent", {
      status: "success",
      source: "dashboard",
      user_id: who.me.id,
      sent_count: result.sent.length,
      failed_count: result.failed.length,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof AuthApiError) {
      trackEvent("audit_invite_sent", {
        status: "failed",
        source: "dashboard",
        user_id: who.me.id,
        error_code: err.code,
        http_status: err.status,
        recipient_count: normalised.length,
      });
      const httpStatus = err.status >= 200 && err.status < 600 ? err.status : 504;
      return NextResponse.json(
        {
          code: err.code,
          message: err.message,
          ...(err.retryAfterSecs !== undefined ? { retry_after_secs: err.retryAfterSecs } : {}),
        },
        { status: httpStatus },
      );
    }
    // Don't surface the raw upstream message to either telemetry or the
    // client. Network/DNS errors can carry internal hostnames, IPs, or
    // fragment payload bytes that have no business leaving the proxy.
    // Log the error name only (bounded) and return a stable generic.
    const errorName = err instanceof Error ? err.name : "unknown";
    trackEvent("audit_invite_sent", {
      status: "failed",
      source: "dashboard",
      user_id: who.me.id,
      error_code: "upstream_unreachable",
      error_name: errorName.slice(0, 50),
      recipient_count: normalised.length,
    });
    return NextResponse.json(
      { code: "upstream_unreachable", message: "Invite service is unreachable. Please try again in a moment." },
      { status: 502 },
    );
  }
}
