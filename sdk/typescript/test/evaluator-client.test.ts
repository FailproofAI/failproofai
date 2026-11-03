import { describe, expect, it, vi } from "vitest";

import { EvaluatorAPIError, EvaluatorClient } from "../src/evaluator/client.js";
import { PROTOCOL_VERSION } from "../src/evaluator/protocol.js";

/**
 * Four properties in here are security or correctness, not style:
 * redirects are refused, every URL is pinned to the configured origin,
 * responses are bounded WHILE they are read, and `claim` is never retried.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(options: Partial<ConstructorParameters<typeof EvaluatorClient>[0]> = {}) {
  const fetchImpl = vi.fn(async () =>
    jsonResponse({
      protocol_version: PROTOCOL_VERSION,
      evaluator_instance_id: "i1",
      evaluator_kind: "customer",
      heartbeat_interval_seconds: 30,
      lease_duration_seconds: 120,
      poll_interval_seconds: 10,
      claim_limit: 4,
      disabled_definitions: [],
    }),
  );
  const client = new EvaluatorClient({
    baseUrl: "https://api.example.test",
    credential: "token",
    fetchImpl: fetchImpl,
    sleep: async () => undefined,
    ...options,
  });
  return { client, fetchImpl };
}

describe("construction", () => {
  it("refuses plaintext http to a non-loopback host", () => {
    expect(() => new EvaluatorClient({ baseUrl: "http://api.example.test", credential: "t" })).toThrow(
      /must use https unless it targets loopback/,
    );
  });

  it("allows http to loopback, where there is no network to eavesdrop", () => {
    for (const host of ["http://localhost:8020", "http://127.0.0.1:8020", "http://[::1]:8020"]) {
      expect(() => new EvaluatorClient({ baseUrl: host, credential: "t" })).not.toThrow();
    }
  });

  it("refuses a credential that would let a header be injected", () => {
    expect(() =>
      new EvaluatorClient({ baseUrl: "https://a.test", credential: "tok\r\nX-Evil: 1" }),
    ).toThrow(/control characters/);
    expect(() => new EvaluatorClient({ baseUrl: "https://a.test", credential: "  " })).toThrow(
      /must not be empty/,
    );
  });

  it("refuses a non-absolute base url", () => {
    expect(() => new EvaluatorClient({ baseUrl: "/v1", credential: "t" })).toThrow(
      /absolute http\(s\) URL/,
    );
  });
});

describe("requests", () => {
  it("sends the bearer credential and refuses redirects", async () => {
    const { client, fetchImpl } = makeClient();
    await client.register({
      workerId: "w1",
      sdkVersion: "0",
      catalogRevision: "sha256:0",
      maxConcurrency: 1,
      definitions: [],
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
    // Following a redirect would carry the Authorization header to wherever it
    // points, which turns a misconfigured server into credential exfiltration.
    expect(init.redirect).toBe("error");
  });

  it("refuses a server-supplied URL outside the configured origin", async () => {
    const { client } = makeClient();
    await expect(
      client.transcript(
        {
          assignmentId: "a1",
          leaseGeneration: 1,
          leaseExpiresAt: "",
          sessionId: "s",
          sessionRevisionId: "r",
          agentId: "main",
          environment: "dev",
          triggerReason: "x",
          eventCount: 0,
          transcriptUrl: "https://attacker.test/transcript",
          definitionsUrl: "",
        },
        "w1",
      ),
    ).rejects.toThrow(/outside the configured API origin/);
  });

  it("retries a retryable status and stops at the cap", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const client = new EvaluatorClient({
      baseUrl: "https://api.example.test",
      credential: "t",
      maxRetries: 2,
      fetchImpl: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(
      client.register({
        workerId: "w1",
        sdkVersion: "0",
        catalogRevision: "sha256:0",
        maxConcurrency: 1,
        definitions: [],
      }),
    ).rejects.toThrow(EvaluatorAPIError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable status", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          protocol_version: PROTOCOL_VERSION,
          error: { code: "invalid_credentials", message: "nope", retryable: false, request_id: "r" },
        },
        401,
      ),
    );
    const client = new EvaluatorClient({
      baseUrl: "https://api.example.test",
      credential: "t",
      fetchImpl: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(
      client.register({
        workerId: "w1",
        sdkVersion: "0",
        catalogRevision: "sha256:0",
        maxConcurrency: 1,
        definitions: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("NEVER retries a claim, because a lost response may already have leased work", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const client = new EvaluatorClient({
      baseUrl: "https://api.example.test",
      credential: "t",
      maxRetries: 5,
      fetchImpl: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(
      client.claim({ workerId: "w1", catalogRevision: "sha256:0", capacity: 1 }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a non-JSON body as an invalid response rather than crashing", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>gateway</html>", { status: 200 }));
    const client = new EvaluatorClient({
      baseUrl: "https://api.example.test",
      credential: "t",
      fetchImpl: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(
      client.register({
        workerId: "w1",
        sdkVersion: "0",
        catalogRevision: "sha256:0",
        maxConcurrency: 1,
        definitions: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("stops reading a body past the limit instead of buffering it whole", async () => {
    const huge = "x".repeat(4 * 1024 * 1024);
    const fetchImpl = vi.fn(async () => jsonResponse({ padding: huge }));
    const client = new EvaluatorClient({
      baseUrl: "https://api.example.test",
      credential: "t",
      fetchImpl: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(
      client.register({
        workerId: "w1",
        sdkVersion: "0",
        catalogRevision: "sha256:0",
        maxConcurrency: 1,
        definitions: [],
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("classifies a transport failure as retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new EvaluatorClient({
      baseUrl: "https://api.example.test",
      credential: "t",
      maxRetries: 0,
      fetchImpl: fetchImpl,
      sleep: async () => undefined,
    });
    await expect(
      client.register({
        workerId: "w1",
        sdkVersion: "0",
        catalogRevision: "sha256:0",
        maxConcurrency: 1,
        definitions: [],
      }),
    ).rejects.toMatchObject({ code: "transport_error", retryable: true });
  });
});
