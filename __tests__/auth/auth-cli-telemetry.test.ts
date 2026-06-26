// @vitest-environment node
/**
 * Reliability coverage for `failproofai auth` telemetry. The auth CLI emitted
 * its events fire-and-forget (`void trackHookEvent(...)`); since the process
 * exits after the command returns, the terminal login/logout/whoami events
 * raced the exit and were dropped. The fix awaits the exit-adjacent events.
 *
 * Proof technique: trackHookEvent resolves on a macrotask and records into
 * `resolvedEvents`. After `await runAuthCli(...)`, an awaited event will already
 * be in the set; a fire-and-forget (regressed) one will not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const resolvedEvents = new Set<string>();
let promptResponses: string[] = [];

const h = vi.hoisted(() => ({
  trackHookEvent: vi.fn(),
  readAuth: vi.fn(),
  deleteAuth: vi.fn(),
  writeAuth: vi.fn(),
  logoutSession: vi.fn(async () => {}),
  requestLoginCode: vi.fn(),
  verifyLoginCode: vi.fn(),
}));

vi.mock("../../src/hooks/hook-telemetry", () => ({ trackHookEvent: h.trackHookEvent }));
vi.mock("../../lib/telemetry-id", () => ({ getInstanceId: () => "test-instance" }));
vi.mock("../../lib/auth/auth-store", () => ({
  readAuth: h.readAuth,
  deleteAuth: h.deleteAuth,
  writeAuth: h.writeAuth,
  authFromTokenResponse: (t: unknown) => t,
}));
vi.mock("../../lib/auth/api-server-client", () => ({
  logoutSession: h.logoutSession,
  requestLoginCode: h.requestLoginCode,
  verifyLoginCode: h.verifyLoginCode,
  getApiBase: () => "https://api.test",
  AuthApiError: class AuthApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number, message: string) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));
vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(promptResponses.shift() ?? ""),
    close: () => {},
  }),
}));

import { runAuthCli } from "../../src/auth/cli";

const session = { user: { id: "u1", email: "a@b.com" }, refresh_expires_at: 9_999_999_999 };
const names = () => h.trackHookEvent.mock.calls.map((c) => c[1] as string);

beforeEach(() => {
  vi.clearAllMocks();
  resolvedEvents.clear();
  promptResponses = [];
  process.exitCode = 0;
  h.trackHookEvent.mockImplementation(
    (_id: string, name: string) =>
      new Promise<void>((res) =>
        setTimeout(() => {
          resolvedEvents.add(name);
          res();
        }, 5),
      ),
  );
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("failproofai auth telemetry (awaited before exit)", () => {
  it("whoami (signed in) awaits audit_cli_auth_whoami", async () => {
    h.readAuth.mockReturnValue(session);
    await runAuthCli(["whoami"]);
    expect(names()).toEqual(["audit_cli_auth_whoami"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith(
      "test-instance",
      "audit_cli_auth_whoami",
      expect.objectContaining({ authenticated: true }),
    );
    expect(resolvedEvents.has("audit_cli_auth_whoami")).toBe(true);
  });

  it("whoami (not signed in) awaits the event and sets exit code 1", async () => {
    h.readAuth.mockReturnValue(null);
    await runAuthCli(["whoami"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith(
      "test-instance",
      "audit_cli_auth_whoami",
      expect.objectContaining({ authenticated: false }),
    );
    expect(resolvedEvents.has("audit_cli_auth_whoami")).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("logout (with session) awaits audit_cli_auth_logout_completed and wipes auth", async () => {
    h.readAuth.mockReturnValue(session);
    await runAuthCli(["logout"]);
    expect(names()).toContain("audit_cli_auth_logout_completed");
    expect(h.deleteAuth).toHaveBeenCalledTimes(1);
    expect(resolvedEvents.has("audit_cli_auth_logout_completed")).toBe(true);
  });

  it("logout (no session) awaits the no-op event", async () => {
    h.readAuth.mockReturnValue(null);
    await runAuthCli(["logout"]);
    expect(h.trackHookEvent).toHaveBeenCalledWith(
      "test-instance",
      "audit_cli_auth_logout_completed",
      expect.objectContaining({ had_session: false }),
    );
    expect(resolvedEvents.has("audit_cli_auth_logout_completed")).toBe(true);
  });

  it("login success awaits the terminal login_completed event", async () => {
    h.readAuth.mockReturnValue(null);
    promptResponses = ["a@b.com", "123456"];
    h.requestLoginCode.mockResolvedValue({ status: "sent", expires_in: 600, resend_available_in: 30 });
    h.verifyLoginCode.mockResolvedValue({ user: { id: "u1", email: "a@b.com" } });

    await runAuthCli(["login"]);

    const emitted = names();
    expect(emitted).toContain("audit_cli_auth_login_started"); // fire-and-forget (mid-flow)
    expect(emitted).toContain("audit_otp_verified");
    expect(emitted).toContain("audit_user_identity_linked");
    expect(emitted).toContain("audit_cli_auth_login_completed");
    expect(h.writeAuth).toHaveBeenCalledTimes(1);
    // The terminal event (followed by return -> process exit) must be awaited.
    expect(resolvedEvents.has("audit_cli_auth_login_completed")).toBe(true);
  });
});
