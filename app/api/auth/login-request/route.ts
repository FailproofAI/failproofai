/**
 * POST /api/auth/login-request
 *
 * Browser-facing proxy for the api-server's /v0/auth/login/request. Keeps the
 * api-server URL server-side so the browser only ever talks to the local
 * dashboard.
 */
import { NextRequest, NextResponse } from "next/server";
import { AuthApiError, requestLoginCode } from "@/lib/auth/api-server-client";
import { initTelemetry, trackEvent } from "@/lib/telemetry";

export const dynamic = "force-dynamic";

interface RequestBody {
  email?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  await initTelemetry();
  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    trackEvent("audit_otp_requested", { status: "validation_error", source: "dashboard", reason: "invalid_json" });
    return NextResponse.json({ code: "validation_error", message: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.email !== "string" || !body.email.trim()) {
    trackEvent("audit_otp_requested", { status: "validation_error", source: "dashboard", reason: "missing_email" });
    return NextResponse.json(
      { code: "validation_error", message: "email is required" },
      { status: 400 },
    );
  }
  // Telemetry sends the raw (normalised) email so PostHog can identify the
  // sender. Core login logic still uses the original `body.email`.
  const email = body.email.trim().toLowerCase();
  try {
    const r = await requestLoginCode(body.email);
    trackEvent("audit_otp_requested", {
      status: "success",
      email,
      source: "dashboard",
      expires_in: r.expires_in,
      resend_available_in: r.resend_available_in,
    });
    return NextResponse.json(
      {
        status: r.status,
        expires_in: r.expires_in,
        resend_available_in: r.resend_available_in,
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof AuthApiError) {
      trackEvent("audit_otp_requested", {
        status: "failed",
        email,
        source: "dashboard",
        error_code: err.code,
        http_status: err.status,
        retry_after_secs: err.retryAfterSecs ?? null,
      });
      // AuthApiError uses `status: 0` for client-side timeouts; NextResponse
      // (the Response constructor) rejects any status < 200 with a
      // RangeError. Surface the timeout as 504 so the browser sees a real
      // status code, not a 500 stack trace.
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
    const message = err instanceof Error ? err.message : String(err);
    trackEvent("audit_otp_requested", {
      status: "failed",
      email,
      source: "dashboard",
      error_code: "upstream_unreachable",
      error_message: message.slice(0, 200),
    });
    return NextResponse.json(
      { code: "upstream_unreachable", message: `api-server unreachable: ${message}` },
      { status: 502 },
    );
  }
}
