// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Exercise the proxy route in isolation: a stub session (whoAmI) and a
// recording upstream client (sendInvites) so we can assert exactly what score
// the route forwards after its defensive coercion.
const { whoAmIMock, sendInvitesMock } = vi.hoisted(() => ({
  whoAmIMock: vi.fn(),
  sendInvitesMock: vi.fn(),
}));

vi.mock("@/lib/auth/auth-store", () => ({ whoAmI: whoAmIMock }));
vi.mock("@/lib/auth/api-server-client", () => ({
  sendInvites: sendInvitesMock,
  // The route only checks `instanceof AuthApiError`; a stub class suffices.
  AuthApiError: class AuthApiError extends Error {},
}));
vi.mock("@/lib/telemetry", () => ({
  initTelemetry: vi.fn(async () => {}),
  trackEvent: vi.fn(),
}));

import { POST } from "@/app/api/audit/invite/route";

function req(body: unknown): NextRequest {
  return { text: async () => JSON.stringify(body) } as unknown as NextRequest;
}

describe("POST /api/audit/invite — score forwarding", () => {
  beforeEach(() => {
    whoAmIMock.mockReset();
    sendInvitesMock.mockReset();
    whoAmIMock.mockResolvedValue({
      me: { id: "u1", email: "alice@example.com" },
      auth: { access_token: "at-1" },
    });
    sendInvitesMock.mockResolvedValue({ sent: ["bob@x.co"], failed: [] });
  });

  // The score is the 3rd positional arg to sendInvites(accessToken, to, score).
  const scoreArg = () => sendInvitesMock.mock.calls[0][2];

  it("forwards a valid in-range score to the api-server", async () => {
    const res = await POST(req({ to: ["bob@x.co"], score: 18 }));
    expect(res.status).toBe(200);
    expect(sendInvitesMock).toHaveBeenCalledWith("at-1", ["bob@x.co"], 18);
  });

  it("clamps out-of-range scores and rounds fractions", async () => {
    await POST(req({ to: ["bob@x.co"], score: 250 }));
    expect(scoreArg()).toBe(100);

    sendInvitesMock.mockClear();
    await POST(req({ to: ["bob@x.co"], score: -5 }));
    expect(scoreArg()).toBe(0);

    sendInvitesMock.mockClear();
    await POST(req({ to: ["bob@x.co"], score: 72.6 }));
    expect(scoreArg()).toBe(73);
  });

  it("forwards undefined when the score is absent or non-numeric", async () => {
    await POST(req({ to: ["bob@x.co"] }));
    expect(scoreArg()).toBeUndefined();

    sendInvitesMock.mockClear();
    await POST(req({ to: ["bob@x.co"], score: "lots" }));
    expect(scoreArg()).toBeUndefined();

    sendInvitesMock.mockClear();
    await POST(req({ to: ["bob@x.co"], score: Number.NaN }));
    expect(scoreArg()).toBeUndefined();
  });
});
