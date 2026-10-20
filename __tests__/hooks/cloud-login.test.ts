import { describe, it, expect, vi } from "vitest";
import {
  claimLogin,
  isOpenableUrl,
  LOGIN_CLAIM_PATH,
  LOGIN_POLL_PATH,
  LOGIN_START_PATH,
  machineOs,
  pollLogin,
  startLogin,
} from "../../src/hooks/cloud-login";
import { canOpenBrowser } from "../../src/audit/open-browser";

const ORIGIN = "https://app.befailproof.ai";
const MACHINE = { label: "box", os: "linux", cliVersion: "1.0.12" };

/** A fetch answering one status and body, recording what it was asked. */
function fetchOf(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }),
  );
}

describe("startLogin", () => {
  it("returns the link and the poll secret, and sends the machine", async () => {
    const f = fetchOf(201, {
      verification_url: `${ORIGIN}/cli/authorize?r=abc`,
      poll_secret: "secret",
      expires_in: 600,
      interval: 2,
    });
    const r = await startLogin(ORIGIN + "/", MACHINE, f as unknown as typeof fetch);
    expect(r).toEqual({
      kind: "ok",
      verificationUrl: `${ORIGIN}/cli/authorize?r=abc`,
      pollSecret: "secret",
      expiresIn: 600,
      interval: 2,
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}${LOGIN_START_PATH}`);
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toEqual({ machine_label: "box", machine_os: "linux", cli_version: "1.0.12" });
  });

  it("calls an older cloud unsupported, whether it 404s or redirects to a login page", async () => {
    expect(await startLogin(ORIGIN, MACHINE, fetchOf(404, "") as unknown as typeof fetch)).toEqual({ kind: "unsupported" });
    expect(
      await startLogin(ORIGIN, MACHINE, fetchOf(307, "", { location: "/login" }) as unknown as typeof fetch),
    ).toEqual({ kind: "unsupported" });
    // A 201 that is not this API.
    expect(await startLogin(ORIGIN, MACHINE, fetchOf(201, { hello: "world" }) as unknown as typeof fetch)).toEqual({
      kind: "unsupported",
    });
  });

  it("never hands a non-http link to the browser opener", async () => {
    for (const verification_url of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
      const f = fetchOf(201, { verification_url, poll_secret: "s", expires_in: 600, interval: 2 });
      expect(await startLogin(ORIGIN, MACHINE, f as unknown as typeof fetch)).toEqual({ kind: "unsupported" });
    }
    expect(isOpenableUrl("https://x.test/a")).toBe(true);
    expect(isOpenableUrl("http://localhost:3000/a")).toBe(true);
    expect(isOpenableUrl("ftp://x.test")).toBe(false);
  });

  it("tells a rate limit, a refusal and an outage apart", async () => {
    expect((await startLogin(ORIGIN, MACHINE, fetchOf(429, {}) as unknown as typeof fetch)).kind).toBe("refused");
    expect(
      await startLogin(ORIGIN, MACHINE, fetchOf(422, { error: "machine_label_required" }) as unknown as typeof fetch),
    ).toEqual({ kind: "refused", reason: "machine_label_required" });
    expect(await startLogin(ORIGIN, MACHINE, fetchOf(502, "<html>") as unknown as typeof fetch)).toEqual({
      kind: "unreachable",
      reason: "the server answered 502",
    });
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await startLogin(ORIGIN, MACHINE, down as unknown as typeof fetch)).toEqual({
      kind: "unreachable",
      reason: "fetch failed",
    });
  });
});

describe("pollLogin", () => {
  it("reads every state the server can answer", async () => {
    const poll = (body: unknown, status = 200) => pollLogin(ORIGIN, "s", fetchOf(status, body) as unknown as typeof fetch);
    expect(await poll({ status: "pending", interval: 2 })).toEqual({ kind: "pending", interval: 2 });
    expect(await poll({ status: "slow_down", interval: 2 })).toEqual({ kind: "slow_down" });
    expect(await poll({ status: "denied" })).toEqual({ kind: "denied" });
    expect(await poll({ status: "expired" })).toEqual({ kind: "expired" });
    expect(await poll({ status: "claimed" })).toEqual({ kind: "claimed" });
    expect(await poll({ status: "unknown" }, 404)).toEqual({ kind: "unknown" });
    expect(
      await poll({
        status: "approved",
        org: { id: "o1", slug: "acme", name: "Acme" },
        approved_by: "ada@acme.test",
        key_name: "failproofai · box",
        permissions: ["events:add", "policies:pull", 7],
      }),
    ).toEqual({
      kind: "approved",
      org: { id: "o1", slug: "acme", name: "Acme" },
      approvedBy: "ada@acme.test",
      keyName: "failproofai · box",
      permissions: ["events:add", "policies:pull"],
    });
    expect((await poll("<html>", 500)).kind).toBe("unreachable");
  });

  it("posts the poll secret, and only that", async () => {
    const f = fetchOf(200, { status: "pending" });
    await pollLogin(ORIGIN, "the-secret", f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}${LOGIN_POLL_PATH}`);
    expect(JSON.parse(String(init?.body))).toEqual({ poll_secret: "the-secret" });
  });
});

describe("claimLogin", () => {
  it("returns the key once minted", async () => {
    const f = fetchOf(201, {
      api_key: "k".repeat(64),
      key_id: "kid",
      key_name: "failproofai · box",
      permissions: ["events:add"],
      org: { slug: "acme", name: "Acme" },
      approved_by: "ada@acme.test",
    });
    const r = await claimLogin(ORIGIN, "s", f as unknown as typeof fetch);
    expect(r).toMatchObject({ kind: "ok", key: "k".repeat(64), keyName: "failproofai · box", approvedBy: "ada@acme.test" });
    expect(f.mock.calls[0]![0]).toBe(`${ORIGIN}${LOGIN_CLAIM_PATH}`);
  });

  it("names why a key could not be created", async () => {
    const claim = (status: number, body: unknown) => claimLogin(ORIGIN, "s", fetchOf(status, body) as unknown as typeof fetch);
    expect(await claim(410, { error: "not_actionable", status: "expired" })).toEqual({ kind: "expired" });
    expect(await claim(403, { error: "approval_revoked" })).toEqual({ kind: "revoked" });
    expect(await claim(409, { error: "not_actionable", status: "claimed" })).toEqual({
      kind: "refused",
      reason: "the login request is claimed",
    });
    expect((await claim(503, "")).kind).toBe("unreachable");
    expect(await claim(201, { key_id: "no secret" })).toEqual({ kind: "refused", reason: "the server answered without a key" });
  });
});

describe("machineOs", () => {
  it("names the OS the way the page shows it", () => {
    expect(machineOs("darwin")).toBe("macOS");
    expect(machineOs("linux")).toBe("linux");
    expect(machineOs("win32")).toBe("windows");
  });
});

// Next's types make NODE_ENV required on ProcessEnv; these are plain maps.
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("canOpenBrowser", () => {
  it("is false over SSH, whatever the display says", () => {
    for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) {
      expect(canOpenBrowser(env({ [key]: "1", DISPLAY: ":0" }), "linux")).toBe(false);
      expect(canOpenBrowser(env({ [key]: "1" }), "darwin")).toBe(false);
    }
  });
  it("is false on a Linux box with no display at all", () => {
    expect(canOpenBrowser(env({}), "linux")).toBe(false);
    expect(canOpenBrowser(env({ DISPLAY: ":0" }), "linux")).toBe(true);
    expect(canOpenBrowser(env({ WAYLAND_DISPLAY: "wayland-0" }), "linux")).toBe(true);
  });
  it("is true on a Mac at its own keyboard", () => {
    expect(canOpenBrowser(env({}), "darwin")).toBe(true);
  });
});
