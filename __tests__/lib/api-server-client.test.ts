// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const trackEventMock = vi.fn();

vi.mock("@/lib/telemetry", () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}));

import {
  AuthApiError,
  cancelReminder,
  decodeJwt,
  requestLoginCode,
  scheduleReminder,
  sendInvites,
} from "@/lib/auth/api-server-client";

describe("api-server-client fetchWithTimeout telemetry", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    trackEventMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fires api_server_unreachable with kind=timeout on AbortError", async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;

    await expect(requestLoginCode("a@b.co")).rejects.toBeInstanceOf(AuthApiError);
    expect(trackEventMock).toHaveBeenCalledWith(
      "api_server_unreachable",
      expect.objectContaining({
        kind: "timeout",
        path: "/v0/auth/login/request",
        method: "POST",
      }),
    );
  });

  it("fires api_server_unreachable with kind=network on connection error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(requestLoginCode("a@b.co")).rejects.toBeInstanceOf(TypeError);
    expect(trackEventMock).toHaveBeenCalledWith(
      "api_server_unreachable",
      expect.objectContaining({
        kind: "network",
        path: "/v0/auth/login/request",
        method: "POST",
      }),
    );
  });

  it("does NOT fire api_server_unreachable on a successful response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ status: "code_sent", expires_in: 600, resend_available_in: 30 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const out = await requestLoginCode("a@b.co");
    expect(out.status).toBe("code_sent");
    expect(trackEventMock).not.toHaveBeenCalled();
  });
});

describe("scheduleReminder", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    trackEventMock.mockClear();
  });

  it("POSTs /v0/reminders with the access token and returns the unwrapped reminder", async () => {
    const reminder = { user_id: "u", email: "a@b.co", fire_at: 1, set_at: 0 };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ reminder }), { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const out = await scheduleReminder("at-1", { in_days: 7 });
    expect(out).toEqual(reminder);
    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer at-1");
  });

  it("throws AuthApiError on non-OK responses", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: "rate_limited", message: "slow down" }), { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(scheduleReminder("at-1", { in_days: 7 })).rejects.toBeInstanceOf(AuthApiError);
  });
});

describe("cancelReminder", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    trackEventMock.mockClear();
  });

  it("DELETEs /v0/reminders with the access token and resolves on 204", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await expect(cancelReminder("at-1")).resolves.toBeUndefined();
    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer at-1");
  });

  it("throws AuthApiError on non-OK responses", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: "unauthorized", message: "no" }), { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(cancelReminder("at-1")).rejects.toBeInstanceOf(AuthApiError);
  });
});

describe("sendInvites", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    trackEventMock.mockClear();
  });

  const okResult = { sent: ["b@x.co"], failed: [] };
  const mockFetch = () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(okResult), { status: 200 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    return fetchMock;
  };
  const bodyOf = (fetchMock: typeof fetch) => {
    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    return JSON.parse(init.body as string) as { to: string[]; score?: number };
  };

  it("includes the score in the POST body when provided", async () => {
    const fetchMock = mockFetch();
    const out = await sendInvites("at-1", ["b@x.co"], 18);
    expect(out).toEqual(okResult);
    const body = bodyOf(fetchMock);
    expect(body.to).toEqual(["b@x.co"]);
    expect(body.score).toBe(18);
  });

  it("omits the score key entirely when not provided", async () => {
    const fetchMock = mockFetch();
    await sendInvites("at-1", ["b@x.co"]);
    const body = bodyOf(fetchMock);
    expect(body.to).toEqual(["b@x.co"]);
    expect("score" in body).toBe(false);
  });
});

describe("retry-after parsing in parseError", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    trackEventMock.mockClear();
  });

  it("reads retry_after_secs from the body when present", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: "rate_limited", message: "slow", retry_after_secs: 42 }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    try {
      await requestLoginCode("a@b.co");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AuthApiError);
      expect((err as AuthApiError).retryAfterSecs).toBe(42);
    }
  });

  it("falls back to the Retry-After header (numeric seconds) when body omits it", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: "rate_limited", message: "slow" }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "17" } },
      ),
    ) as unknown as typeof fetch;
    try {
      await requestLoginCode("a@b.co");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AuthApiError);
      expect((err as AuthApiError).retryAfterSecs).toBe(17);
    }
  });

  it("leaves retry_after undefined when the header is unparseable", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: "rate_limited", message: "slow" }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "not-a-number" } },
      ),
    ) as unknown as typeof fetch;
    try {
      await requestLoginCode("a@b.co");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AuthApiError);
      expect((err as AuthApiError).retryAfterSecs).toBeUndefined();
    }
  });
});

describe("decodeJwt", () => {
  function makeJwt(payload: object): string {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.sig`;
  }

  it("returns the parsed payload for a well-formed token", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt({ sub: "user-1", email: "a@b.co", exp });
    const out = decodeJwt(token);
    expect(out).not.toBeNull();
    expect(out?.sub).toBe("user-1");
    expect(out?.email).toBe("a@b.co");
    expect(out?.exp).toBe(exp);
  });

  it("returns the parsed payload even for an expired token (validation is the caller's job)", () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = makeJwt({ sub: "user-1", email: "a@b.co", exp: past });
    expect(decodeJwt(token)?.exp).toBe(past);
  });

  it("returns null when the token doesn't have 3 parts", () => {
    expect(decodeJwt("only.two")).toBeNull();
    expect(decodeJwt("just-one")).toBeNull();
  });

  it("returns null when the payload isn't valid JSON", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const bogus = Buffer.from("not-json").toString("base64url");
    expect(decodeJwt(`${header}.${bogus}.sig`)).toBeNull();
  });

  it("returns null when exp is missing or non-numeric", () => {
    const noExp = makeJwt({ sub: "u", email: "a@b.co" });
    expect(decodeJwt(noExp)).toBeNull();
    const stringExp = makeJwt({ sub: "u", email: "a@b.co", exp: "soon" });
    expect(decodeJwt(stringExp)).toBeNull();
  });

  it("rejects payloads with illegal base64url characters instead of silently truncating", () => {
    // `+` and `/` are valid base64 but not base64url; the legacy
    // Buffer.from(..., 'base64url') happily truncated, which could
    // produce synthetic claims that JSON.parse accepted.
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const goodPayload = Buffer.from(JSON.stringify({ sub: "u", email: "a@b.co", exp })).toString("base64url");
    // Inject illegal chars into the payload.
    const tampered = `${header}.${goodPayload.slice(0, 4)}+/${goodPayload.slice(4)}.sig`;
    expect(decodeJwt(tampered)).toBeNull();
  });

  it("rejects an empty payload segment", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    expect(decodeJwt(`${header}..sig`)).toBeNull();
  });
});
