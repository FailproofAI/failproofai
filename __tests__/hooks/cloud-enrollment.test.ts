import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  clearCloudCredentials,
  cloudCredentialPath,
  maskToken,
  readCloudCredentials,
  validateCloudUrl,
  verifyCloudCredentials,
  writeCloudCredentials,
} from "../../src/hooks/cloud-enrollment";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "fpai-enroll-"));
  process.env.FAILPROOFAI_CLOUD_CREDENTIALS = resolve(dir, "cloud.json");
});

afterEach(() => {
  delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
  rmSync(dir, { recursive: true, force: true });
});

describe("validateCloudUrl", () => {
  it("accepts https and normalises a trailing slash", () => {
    expect(validateCloudUrl("https://be.failproof.ai/")).toEqual({ ok: true, url: "https://be.failproof.ai" });
  });

  it("REFUSES plain http to a remote host — the token is a bearer credential", () => {
    const r = validateCloudUrl("http://cloud.example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/plain http/);
  });

  it("allows http for loopback, which local development needs", () => {
    expect(validateCloudUrl("http://localhost:8080").ok).toBe(true);
    expect(validateCloudUrl("http://127.0.0.1:8080").ok).toBe(true);
  });

  it("rejects a non-URL and a non-http scheme", () => {
    expect(validateCloudUrl("be.failproof.ai").ok).toBe(false);
    expect(validateCloudUrl("ftp://cloud.example").ok).toBe(false);
    expect(validateCloudUrl("file:///etc/passwd").ok).toBe(false);
  });
});

describe("maskToken", () => {
  it("keeps only enough to tell two keys apart", () => {
    expect(maskToken("abcdefghijkl")).toBe("****ijkl");
    expect(maskToken("ab")).toBe("****");
  });
});

describe("credential storage", () => {
  const creds = { url: "https://be.failproof.ai", machineId: "m-1", token: "super-secret-token" };

  it("round-trips", () => {
    writeCloudCredentials(creds);
    expect(readCloudCredentials()).toEqual(creds);
  });

  it("writes owner-only, because this is a bearer credential", () => {
    writeCloudCredentials(creds);
    expect(statSync(cloudCredentialPath()).mode & 0o777).toBe(0o600);
  });

  it("reads as not-connected when absent, malformed, or a future schema", () => {
    expect(readCloudCredentials()).toBeNull();
    writeFileSync(cloudCredentialPath(), "{ not json");
    expect(readCloudCredentials()).toBeNull();
    writeFileSync(cloudCredentialPath(), JSON.stringify({ schemaVersion: 99, url: "u", machineId: "m", token: "t" }));
    expect(readCloudCredentials()).toBeNull();
  });

  it("treats a partial record as not connected rather than half-configured", () => {
    writeFileSync(cloudCredentialPath(), JSON.stringify({ schemaVersion: 1, url: "https://x", machineId: "m" }));
    expect(readCloudCredentials()).toBeNull();
    writeFileSync(cloudCredentialPath(), JSON.stringify({ schemaVersion: 1, url: "", machineId: "m", token: "t" }));
    expect(readCloudCredentials()).toBeNull();
  });

  it("clearCloudCredentials removes the file and reports whether there was one", () => {
    writeCloudCredentials(creds);
    expect(clearCloudCredentials()).toBe(true);
    expect(existsSync(cloudCredentialPath())).toBe(false);
    expect(clearCloudCredentials()).toBe(false);
  });
});

describe("verifyCloudCredentials", () => {
  let server: Server;
  let base: string;
  let lastAuth: string | undefined;
  let respond: (path: string) => { status: number; body: string };

  beforeEach(async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ schemaVersion: 1, generation: 4, policies: [] }) });
    server = createServer((req, res) => {
      lastAuth = req.headers.authorization;
      const { status, body } = respond(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const creds = () => ({ url: base, machineId: "m-1", token: "the-token" });

  it("sends the token as a bearer against the machine's own desired-state", async () => {
    let seenUrl = "";
    respond = (url) => {
      seenUrl = url;
      return { status: 200, body: JSON.stringify({ generation: 9, policies: [{ id: "a" }, { id: "b" }] }) };
    };
    const result = await verifyCloudCredentials(creds());
    expect(result).toEqual({ ok: true, policyCount: 2, generation: 9 });
    expect(lastAuth).toBe("Bearer the-token");
    expect(seenUrl).toContain("/enforcement/v1/desired-state?machineId=m-1");
  });

  it("names the actual problem on 401 and 403", async () => {
    // These are the two mistakes people actually make — a truncated key, and
    // an admin key without policies:pull. A bare "failed" makes the operator
    // guess between them.
    respond = () => ({ status: 401, body: "{}" });
    const unauthorized = await verifyCloudCredentials(creds());
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.reason).toMatch(/rejected this token/);

    respond = () => ({ status: 403, body: "{}" });
    const forbidden = await verifyCloudCredentials(creds());
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.reason).toMatch(/policies:pull/);
  });

  it("rejects a 200 that is not a desired-state document", async () => {
    respond = () => ({ status: 200, body: "<html>hello</html>" });
    const r = await verifyCloudCredentials(creds());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not with a desired-state document/);
  });

  it("reports an unreachable server rather than throwing", async () => {
    const r = await verifyCloudCredentials({ url: "http://127.0.0.1:1", machineId: "m", token: "t" });
    expect(r.ok).toBe(false);
  });
});
