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

// PARTIAL: the flow draws its frame with the real `intro`/`step`/`outro`, and
// only the prompt is stood in for. A wholesale mock had to be extended every
// time the flow used one more thing from the toolkit, and each time it failed
// as "no export is defined" rather than as anything about the login.
vi.mock("../../src/hooks/tui", async (orig) => ({
  ...(await orig<typeof import("../../src/hooks/tui")>()),
  promptText: promptTextMock,
}));
vi.mock("../../lib/auth/api-server-client", async (orig) => ({
  ...(await orig<typeof import("../../lib/auth/api-server-client")>()),
  requestLoginCode: requestMock,
  verifyLoginCode: verifyMock,
}));
vi.mock("../../lib/auth/auth-store", async (orig) => ({
  ...(await orig<typeof import("../../lib/auth/auth-store")>()),
  writeAuth: writeAuthMock,
}));

import { runLogin, extractCode } from "../../src/audit/cli-login";
import { AuthApiError } from "../../lib/auth/api-server-client";

/** The `validate` the code prompt was handed, so it can be exercised directly. */
function codeValidator(): (v: string) => string | null {
  // The prompt's own label is just "code" — the question it answers lives on
  // the step heading above it ("the code from that email"), so the input line
  // stays short enough to sit beside a pasted value at 80 columns.
  const call = promptTextMock.mock.calls.find(([opts]) => opts.message === "code");
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

    // A pasted line is ACCEPTED now — the digits are pulled out of it. This
    // used to be rejected for length, which is what made pasting the message
    // out of the email cost a fresh code.
    expect(validate("Your code is 123456")).toBeNull();
    expect(validate("code: 123 456")).toBeNull();

    // What is still refused is a digit run the server would answer with
    // `validation_error` rather than `invalid_code` — a distinction the retry
    // loop treats as fatal, so it is caught here where it can be retyped.
    expect(validate("1234567890123")).toMatch(/too long/i);
    expect(validate("123")).toMatch(/too short/i);
    // And no digits at all is not a code, so it never spends an attempt.
    expect(validate("where is it")).toMatch(/digits/i);

    // The ordinary six, and the boundary either side.
    expect(validate("123456")).toBeNull();
    expect(validate("1234")).toBeNull();
    expect(validate("123456789012")).toBeNull();
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

describe("extractCode", () => {
  it("takes the digits out of a pasted line", () => {
    // The code is numeric (`auth/otp.rs` generates digits only), so anything
    // else in the field is packaging. Rejecting it cost a fresh email.
    expect(extractCode("Your failproof code is 123456")).toBe("123456");
    expect(extractCode("code: 123456")).toBe("123456");
    expect(extractCode("123 456")).toBe("123456");
    expect(extractCode("  123456  ")).toBe("123456");
    expect(extractCode("123456 ")).toBe("123456");
  });

  it("passes a clean code through untouched", () => {
    expect(extractCode("123456")).toBe("123456");
    expect(extractCode("0000")).toBe("0000");
  });

  it("does not rewrite a digit-less string into something else", () => {
    // A field with no digits is not a mistyped code; it is returned as typed so
    // the caller can reject it rather than sending an invented one.
    expect(extractCode("hunter2".replace(/\d/g, ""))).toBe("hunter");
    expect(extractCode("   ")).toBe("");
  });

  it("keeps leading zeros, which a numeric parse would eat", () => {
    expect(extractCode("code 007123")).toBe("007123");
  });
});

describe("a preset address", () => {
  it("asks only for the code", async () => {
    // One prompt, not two — the flag already answered the first question.
    promptTextMock.mockResolvedValueOnce("123456");

    const user = await runLogin("Preset@Example.com");

    expect(user.email).toBe(TOKENS.user.email);
    expect(promptTextMock).toHaveBeenCalledTimes(1);
    expect(promptTextMock.mock.calls[0]![0].message).toBe("code");
    // Normalised before it goes anywhere, the same as a typed address.
    expect(requestMock).toHaveBeenCalledWith("preset@example.com");
  });

  it("still sends the code to that address before asking for it", async () => {
    // The order matters: a flag that skipped the request would leave somebody
    // waiting at a code prompt for a mail that was never sent.
    promptTextMock.mockResolvedValueOnce("123456");
    await runLogin("preset@example.com");

    expect(requestMock).toHaveBeenCalledBefore(verifyMock);
  });
});
