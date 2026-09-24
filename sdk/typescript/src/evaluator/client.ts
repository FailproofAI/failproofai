/**
 * HTTP client for the Evaluator v2 worker protocol.
 *
 * Built on the global `fetch` (Node 18+), so it adds no dependency. Four things
 * in here are security or correctness properties rather than style:
 *
 * * **Redirects are refused**, not followed. A redirect carries the
 *   `Authorization` header to wherever it points, so following one turns a
 *   compromised or misconfigured server into credential exfiltration.
 * * **Every URL is pinned to the configured origin.** The server supplies
 *   `transcript_url` and `definitions_url`; a URL outside the origin we
 *   authenticated to is refused before a request is made.
 * * **Responses are bounded while they are read**, not after. A limit checked
 *   on a fully-buffered body is a limit that has already been exceeded.
 * * **`claim` is never retried at the transport layer.** A lost claim response
 *   may already have leased work; a blind retry would lease it twice. The
 *   runtime recalculates capacity and claims again on its own schedule.
 */

import {
  CLAIM_PATH,
  DEFINITIONS_PATH,
  HEARTBEAT_PATH,
  LEASE_GENERATION_HEADER,
  MAX_TRANSCRIPT_BYTES,
  PLAN_PATH,
  REGISTER_PATH,
  RESULT_PATH,
  WORKER_ID_HEADER,
  claimRequestToWire,
  claimResponseFromWire,
  definitionsResponseFromWire,
  errorResponseFromWire,
  heartbeatRequestToWire,
  heartbeatResponseFromWire,
  planRequestToWire,
  planResponseFromWire,
  registerRequestToWire,
  registerResponseFromWire,
  resultRequestToWire,
  resultResponseFromWire,
  sessionTranscriptFromWire,
} from "./protocol.js";
import type {
  Assignment,
  ClaimRequest,
  ClaimResponse,
  DefinitionsResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  PlanRequest,
  PlanResponse,
  RegisterRequest,
  RegisterResponse,
  ResultRequest,
  ResultResponse,
  SessionTranscript,
  WireObject,
} from "./protocol.js";

const DEFAULT_RESPONSE_LIMIT = 2 * 1024 * 1024;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

export class EvaluatorAPIError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(options: {
    status: number | null;
    code: string;
    message: string;
    retryable: boolean;
    requestId?: string | null;
  }) {
    super(`${options.code}: ${options.message}`);
    this.name = "EvaluatorAPIError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.requestId = options.requestId ?? null;
  }
}

export interface EvaluatorClientOptions {
  baseUrl: string;
  credential: string;
  timeoutSeconds?: number;
  maxRetries?: number;
  allowInsecureHttp?: boolean;
  /** Injected by the tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, so a retry schedule does not cost real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

function isLoopback(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (bare === "::1") return true;
  // 127.0.0.0/8 — the whole block, not just 127.0.0.1, because a dev server on
  // 127.0.0.2 is as local as one on .1 and refusing it helps nobody.
  const parts = bare.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  return octets[0] === 127 && octets.every((octet) => octet >= 0 && octet <= 255);
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Client for the public Evaluator v2 machine API.
 *
 * Hosted workers normally use the FailproofAI dashboard origin. Its `/v1`
 * passthrough forwards this worker's bearer credential to the private server.
 */
export class EvaluatorClient {
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly credential: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EvaluatorClientOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new Error("baseUrl must be an absolute http(s) URL");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.host) {
      throw new Error("baseUrl must be an absolute http(s) URL");
    }
    if (
      parsed.protocol !== "https:" &&
      !isLoopback(parsed.hostname) &&
      options.allowInsecureHttp !== true
    ) {
      throw new Error("baseUrl must use https unless it targets loopback");
    }
    if (!options.credential || options.credential.trim() === "") {
      throw new Error("credential must not be empty");
    }
    for (const char of options.credential) {
      const code = char.codePointAt(0)!;
      // A control character in a header value is a header-injection primitive
      // and `fetch` rejects it with an opaque error; refusing here names the
      // real problem.
      if (code < 32 || code === 127) {
        throw new Error("credential must not contain control characters");
      }
    }
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    if (!(timeoutSeconds > 0)) throw new Error("timeoutSeconds must be greater than zero");
    const maxRetries = options.maxRetries ?? 3;
    if (maxRetries < 0) throw new Error("maxRetries must not be negative");

    this.baseUrl = `${options.baseUrl.replace(/\/+$/, "")}/`;
    this.origin = parsed.origin;
    this.credential = options.credential;
    this.timeoutMs = timeoutSeconds * 1000;
    this.maxRetries = maxRetries;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "no global fetch is available; pass fetchImpl, or run on Node 18 or newer",
      );
    }
  }

  async register(request: RegisterRequest): Promise<RegisterResponse> {
    return registerResponseFromWire(
      await this.json("POST", REGISTER_PATH, registerRequestToWire(request), { retry: true }),
    );
  }

  async claim(request: ClaimRequest): Promise<ClaimResponse> {
    return claimResponseFromWire(
      await this.json("POST", CLAIM_PATH, claimRequestToWire(request), { retry: false }),
    );
  }

  async transcript(assignment: Assignment, workerId: string): Promise<SessionTranscript> {
    return sessionTranscriptFromWire(
      await this.json("GET", assignment.transcriptUrl, null, {
        retry: true,
        headers: this.leaseHeaders(assignment, workerId),
        responseLimit: MAX_TRANSCRIPT_BYTES,
      }),
    );
  }

  async definitions(assignment: Assignment, workerId: string): Promise<DefinitionsResponse> {
    const path =
      assignment.definitionsUrl ||
      DEFINITIONS_PATH.replace("{assignment_id}", encodeURIComponent(assignment.assignmentId));
    return definitionsResponseFromWire(
      await this.json("GET", path, null, {
        retry: true,
        headers: this.leaseHeaders(assignment, workerId),
      }),
    );
  }

  async plan(assignmentId: string, request: PlanRequest): Promise<PlanResponse> {
    return planResponseFromWire(
      await this.json(
        "POST",
        PLAN_PATH.replace("{assignment_id}", encodeURIComponent(assignmentId)),
        planRequestToWire(request),
        { retry: true },
      ),
    );
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return heartbeatResponseFromWire(
      await this.json("POST", HEARTBEAT_PATH, heartbeatRequestToWire(request), { retry: true }),
    );
  }

  async submitResult(runId: string, request: ResultRequest): Promise<ResultResponse> {
    return resultResponseFromWire(
      await this.json(
        "POST",
        RESULT_PATH.replace("{evaluation_run_id}", encodeURIComponent(runId)),
        resultRequestToWire(request),
        { retry: true },
      ),
    );
  }

  private leaseHeaders(assignment: Assignment, workerId: string): Record<string, string> {
    return {
      [WORKER_ID_HEADER]: workerId,
      [LEASE_GENERATION_HEADER]: String(assignment.leaseGeneration),
    };
  }

  private url(path: string): string {
    const resolved = new URL(path, this.baseUrl);
    if (resolved.origin !== this.origin) {
      throw new EvaluatorAPIError({
        status: null,
        code: "invalid_transcript_url",
        message: "server supplied a URL outside the configured API origin",
        retryable: false,
      });
    }
    return resolved.toString();
  }

  private async json(
    method: string,
    path: string,
    body: WireObject | null,
    options: { retry: boolean; headers?: Record<string, string>; responseLimit?: number },
  ): Promise<WireObject> {
    const responseLimit = options.responseLimit ?? DEFAULT_RESPONSE_LIMIT;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.credential}`,
      "User-Agent": "failproofai-sdk-evaluator/2",
      ...options.headers,
    };
    let encoded: string | undefined;
    if (body !== null) {
      encoded = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    const attempts = options.retry ? this.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const url = this.url(path);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: encoded,
          // Never follow a redirect: it would carry the Authorization header to
          // wherever the redirect points.
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt + 1 === attempts) {
          throw new EvaluatorAPIError({
            status: null,
            code: "transport_error",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          });
        }
        await this.backoff(attempt);
        continue;
      }

      if (response.ok) return decode(await readLimited(response, responseLimit), responseLimit);

      const apiError = await this.httpError(response, responseLimit);
      if (attempt + 1 === attempts || !apiError.retryable) throw apiError;
      await this.backoff(attempt);
    }
    // Unreachable: the loop either returns or throws on its last attempt.
    throw new Error("retry loop exhausted without returning or throwing");
  }

  private async backoff(attempt: number): Promise<void> {
    // Jitter is scheduling noise, not a security decision, so `Math.random` is
    // the right tool — a CSPRNG here would buy nothing and cost entropy.
    await this.sleep(Math.random() * Math.min(250 * 2 ** attempt, 2000));
  }

  private async httpError(response: Response, limit: number): Promise<EvaluatorAPIError> {
    let raw: string;
    try {
      raw = await readLimited(response, limit);
    } catch {
      raw = "";
    }
    try {
      const parsed = errorResponseFromWire(decode(raw, limit));
      return new EvaluatorAPIError({
        status: response.status,
        code: parsed.error.code,
        message: parsed.error.message,
        retryable: parsed.error.retryable,
        requestId: parsed.error.requestId,
      });
    } catch {
      return new EvaluatorAPIError({
        status: response.status,
        code: "http_error",
        message: `server returned HTTP ${response.status}`,
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
      });
    }
  }
}

/**
 * Read a response body, stopping the moment it exceeds `limit`.
 *
 * Checking the size after buffering is checking it too late — the memory has
 * already been allocated, which on a 25 MiB transcript ceiling and a hostile or
 * broken server is the whole problem. `response.body` may be absent (a 204, or
 * a mocked response in a test), in which case `text()` is bounded by whatever
 * produced it.
 */
async function readLimited(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        throw new EvaluatorAPIError({
          status: null,
          code: "response_too_large",
          message: `server response exceeds ${limit} bytes`,
          retryable: false,
        });
      }
      chunks.push(value);
    }
  } finally {
    // Releasing the lock lets the connection be reused; cancelling an
    // over-limit body stops the server streaming the rest of it at us.
    if (total > limit) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function decode(raw: string, limit: number): WireObject {
  if (Buffer.byteLength(raw, "utf8") > limit) {
    throw new EvaluatorAPIError({
      status: null,
      code: "response_too_large",
      message: `server response exceeds ${limit} bytes`,
      retryable: false,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new EvaluatorAPIError({
      status: null,
      code: "invalid_response",
      message: "server response was not valid JSON",
      retryable: false,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvaluatorAPIError({
      status: null,
      code: "invalid_response",
      message: "server response must be a JSON object",
      retryable: false,
    });
  }
  return value as WireObject;
}
