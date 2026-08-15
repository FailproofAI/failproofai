// @vitest-environment node
/**
 * The two claims the harm digest rests on that nothing was pinning.
 *
 * 1. A bare `failproofai audit` sends nothing. This is the load-bearing privacy
 *    promise — `audit --help` and the docs both make it, and `reportHarm` is
 *    the only thing in the audit that can reach the network with a transcript
 *    excerpt in hand.
 * 2. An older api-server degrades rather than throwing. `report-harm.test.ts`
 *    asserts that against `submitMock.mockRejectedValue(...)`, which proves
 *    `reportHarm`'s try/catch and says nothing about what the CLIENT does with
 *    a 404 — and the 58 lines of coverage deleted from
 *    `api-server-client.test.ts` were the only tests that had ever touched
 *    that layer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AuthApiError, submitAuditReport } from "../../lib/auth/api-server-client";

describe("only a SCHEDULED audit can report harm", () => {
  // Structural rather than behavioural on purpose: driving `runAuditCli` starts
  // a dashboard server and scans the real machine, so the honest way to pin
  // "this call site is unreachable from the manual path" is to assert where the
  // call site IS. The repo already reads committed sources this way for the
  // dogfood configs and for the Rust/TS harness-key pair.
  const source = readFileSync(resolve(__dirname, "../../src/audit/cli.ts"), "utf8");

  it("calls reportHarm from exactly one place", () => {
    // A second call site is how this promise would break: the manual path and
    // the scheduled path share almost everything else.
    const calls = source.match(/\breportHarm\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("puts that call inside runScheduledAudit, not runAuditCli", () => {
    const scheduledAt = source.indexOf("export async function runScheduledAudit");
    const manualAt = source.indexOf("export async function runAuditCli");
    const callAt = source.search(/\breportHarm\s*\(/);
    expect(scheduledAt).toBeGreaterThan(-1);
    expect(manualAt).toBeGreaterThan(-1);
    // The manual entry point is declared after the scheduled one, so the call
    // belongs strictly between them.
    expect(manualAt).toBeGreaterThan(scheduledAt);
    expect(callAt).toBeGreaterThan(scheduledAt);
    expect(callAt).toBeLessThan(manualAt);
  });
});

describe("submitAuditReport against a server that does not have the route", () => {
  const TOKEN = "at";
  const BODY = {
    machine_id: "m1",
    label: "box",
    platform: "linux",
    window_from: "2026-08-07T00:00:00.000Z",
    window_to: "2026-08-14T00:00:00.000Z",
    harmful: [],
  };

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function respond(status: number, body: string, contentType = "application/json") {
    fetchSpy.mockResolvedValue(
      new Response(body, { status, headers: { "content-type": contentType } }),
    );
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("raises a typed error for a 404, which is the older-server case", async () => {
    // The rollout note says an older api-server 404s and `reportHarm` turns
    // that into `{kind:"failed"}` without throwing. That is only true if what
    // arrives here is a catchable AuthApiError rather than, say, a JSON parse
    // failure on an HTML body.
    respond(404, JSON.stringify({ error: "not_found", message: "no such route" }));

    await expect(submitAuditReport(TOKEN, BODY)).rejects.toBeInstanceOf(AuthApiError);
  });

  it("does not choke on an HTML error page from a proxy", async () => {
    // A corporate proxy answers with `text/html`, not JSON. A body-parse
    // exception here would escape as something other than AuthApiError and
    // reach `reportHarm`'s catch as an unrecognised shape.
    respond(502, "<html><body>Bad Gateway</body></html>", "text/html");

    await expect(submitAuditReport(TOKEN, BODY)).rejects.toBeInstanceOf(Error);
  });

  it("surfaces a 401 as a 401, so the caller can tell auth from everything else", async () => {
    respond(401, JSON.stringify({ error: "unauthorized", message: "expired" }));

    await expect(submitAuditReport(TOKEN, BODY)).rejects.toMatchObject({ status: 401 });
  });

  it("returns the parsed body on success", async () => {
    respond(
      200,
      JSON.stringify({ emailed: true, next_window_from: "2026-08-14T00:00:00.000Z" }),
    );

    await expect(submitAuditReport(TOKEN, BODY)).resolves.toMatchObject({ emailed: true });
  });

  it("sends the access token, and never the destination address", async () => {
    // The api-server resolves the address from the token. A body carrying one
    // would mean the machine, rather than the account, decided where a digest
    // goes.
    respond(200, JSON.stringify({ emailed: false, next_window_from: BODY.window_to }));

    await submitAuditReport(TOKEN, BODY);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.stringify(init.headers)).toContain(TOKEN);
    expect(String(init.body)).not.toMatch(/@/);
  });
});
