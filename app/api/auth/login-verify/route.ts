/**
 * POST /api/auth/login-verify
 *
 * Browser-facing proxy: verifies the OTP with the api-server, persists the
 * resulting tokens to ~/.failproofai/auth.json on the local dashboard host,
 * and returns *only* the user identity to the browser. The refresh token
 * never leaves the local filesystem.
 */
import { NextRequest, NextResponse } from "next/server";
import { AuthApiError, verifyLoginCode } from "@/lib/auth/api-server-client";
import { authFromTokenResponse, writeAuth } from "@/lib/auth/auth-store";
import { initTelemetry, trackEvent } from "@/lib/telemetry";
import { getInstanceId } from "@/lib/telemetry-id";

export const dynamic = "force-dynamic";

interface VerifyBody {
  email?: unknown;
  code?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // `initTelemetry` never throws — its internal try/catch is total. Init up
  // front so the validation-400 paths below are tracked too, mirroring
  // /api/auth/login-request.
  await initTelemetry();
  let body: VerifyBody = {};
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    trackEvent("audit_otp_verified", { status: "validation_error", source: "dashboard", reason: "invalid_json" });
    return NextResponse.json({ code: "validation_error", message: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.email !== "string" || !body.email.trim()) {
    trackEvent("audit_otp_verified", { status: "validation_error", source: "dashboard", reason: "missing_email" });
    return NextResponse.json(
      { code: "validation_error", message: "email is required" },
      { status: 400 },
    );
  }
  if (typeof body.code !== "string" || !body.code.trim()) {
    trackEvent("audit_otp_verified", { status: "validation_error", source: "dashboard", reason: "missing_code", email: body.email.trim().toLowerCase() });
    return NextResponse.json(
      { code: "validation_error", message: "code is required" },
      { status: 400 },
    );
  }
  const email = body.email.trim().toLowerCase();
  try {
    const tokens = await verifyLoginCode(body.email, body.code);
    writeAuth(authFromTokenResponse(tokens));
    // Identity stitch: this event's distinct_id IS the device random id
    // (getInstanceId()), so attaching the verified email + user_id — and
    // persisting them as person properties via `$set` — maps the verified
    // account onto the anonymous device person in PostHog.
    trackEvent("audit_user_identity_linked", {
      source: "audit_set_reminder_auth_dialog",
      user_id: tokens.user.id,
      email: tokens.user.email,
      local_random_id: getInstanceId(),
      $set: { email: tokens.user.email, user_id: tokens.user.id },
    });
    trackEvent("audit_otp_verified", {
      status: "success",
      source: "dashboard",
      user_id: tokens.user.id,
      email: tokens.user.email,
    });
    return NextResponse.json(
      {
        authenticated: true,
        user: { id: tokens.user.id, email: tokens.user.email },
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof AuthApiError) {
      trackEvent("audit_otp_verified", {
        status: "failed",
        source: "dashboard",
        email,
        error_code: err.code,
        http_status: err.status,
      });
      // AuthApiError uses `status: 0` for client-side timeouts; map those to
      // 504 so NextResponse.json doesn't reject with a RangeError.
      const httpStatus = err.status >= 200 && err.status < 600 ? err.status : 504;
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status: httpStatus },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    trackEvent("audit_otp_verified", {
      status: "failed",
      source: "dashboard",
      email,
      error_code: "upstream_unreachable",
      error_message: message.slice(0, 200),
    });
    return NextResponse.json(
      { code: "upstream_unreachable", message: `api-server unreachable: ${message}` },
      { status: 502 },
    );
  }
}
