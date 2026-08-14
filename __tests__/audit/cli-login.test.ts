// @vitest-environment node
/**
 * `failproofai audit --schedule`'s sign-in prompts.
 *
 * The whole flow is two questions and a retry loop, and the part worth pinning
 * is where the loop's assumptions meet the api-server's: it re-asks for a code
 * only when the server says `invalid_code`, so any other rejection ends the
 * sign-in. What the prompts refuse LOCALLY therefore decides which mistakes cost
 * a retry and which cost the whole login.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { promptTextMock, requestMock, verifyMock, writeAuthMock } = vi.hoisted(() => ({
  promptTextMock: vi.fn(),
  requestMock: vi.fn(),
  verifyMock: vi.fn(),
  writeAuthMock: vi.fn(),
}));

vi.mock("../../src/hooks/tui", () => ({ promptText: promptTextMock }));
vi.mock("../../lib/auth/api-server-client", async (orig) => ({
  ...(await orig<typeof import("../../lib/auth/api-server-client")>()),
  requestLoginCode: requestMock,
  verifyLoginCode: verifyMock,
}));
vi.mock("../../lib/auth/auth-store", async (orig) => ({
  ...(await orig<typeof import("../../lib/auth/auth-store")>()),
  writeAuth: writeAuthMock,
}));

import { runLogin } from "../../src/audit/cli-login";
import { AuthApiError } from "../../lib/auth/api-server-client";

/** The `validate` the code prompt was handed, so it can be exercised directly. */
function codeValidator(): (v: string) => string | null {
  const call = promptTextMock.mock.calls.find(([opts]) => opts.message === "the code");
  expect(call, "the code prompt was never reached").toBeDefined();
  return call![0].validate;
}

const TOKENS = {
  token_type: "Bearer" as const,
  access_token: "at",
  access_expires_in: 900,
  refresh_token: "rt",
  refresh_expires_in: 86_400,
  user: { id: "u_1", email: "you@example.com" },
};

beforeEach(() => {
  promptTextMock.mockReset();
  requestMock.mockReset().mockResolvedValue({
    status: "code_sent",
    expires_in: 600,
    resend_available_in: 60,
  });
  verifyMock.mockReset().mockResolvedValue(TOKENS);
  writeAuthMock.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("the code prompt", () => {
  it("refuses a value longer than the api-server will validate", async () => {
    // The server bounds `code` at 4..12 characters, and a longer one comes back
    // as `validation_error` rather than `invalid_code` — which the retry loop
    // below does not recognise, so the whole sign-in aborts and the next attempt
    // costs a fresh email. Pasting the sentence around the code out of the
    // message, rather than just the code, is the ordinary way to hit that.
    promptTextMock
      .mockResolvedValueOnce("you@example.com")
      .mockResolvedValueOnce("123456");

    await runLogin();

    const validate = codeValidator();
    expect(validate("Your code is 123456")).toMatch(/paste just the code/i);
    expect(validate("1234567890123")).toBeTruthy();
    // And the ordinary six digits still pass, plus the boundary either side.
    expect(validate("123456")).toBeNull();
    expect(validate("1234")).toBeNull();
    expect(validate("123456789012")).toBeNull();
    expect(validate("123")).toBeTruthy();
  });
});

describe("the retry loop", () => {
  it("re-asks on a wrong code rather than sending a second email", async () => {
    promptTextMock
      .mockResolvedValueOnce("you@example.com")
      .mockResolvedValueOnce("000000")
      .mockResolvedValueOnce("123456");
    verifyMock
      .mockRejectedValueOnce(new AuthApiError(401, "invalid_code", "that code is wrong"))
      .mockResolvedValueOnce(TOKENS);

    const user = await runLogin();

    expect(user.email).toBe("you@example.com");
    // One code, two attempts at it. A fresh email per typo would burn the
    // server's own per-address rate limit on the user's behalf.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledTimes(2);
    expect(writeAuthMock).toHaveBeenCalledTimes(1);
  });

  it("stops on anything that is not a wrong code", async () => {
    // A rate limit or a validation failure will not become a success by asking
    // the same question again, and the message names the remedy instead.
    promptTextMock
      .mockResolvedValueOnce("you@example.com")
      .mockResolvedValueOnce("123456");
    verifyMock.mockRejectedValue(new AuthApiError(429, "rate_limited", "slow down", 30));

    await expect(runLogin()).rejects.toThrow(/too many attempts/i);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(writeAuthMock).not.toHaveBeenCalled();
  });
});
