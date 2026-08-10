import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { configFile, credentialsFile } from "../../src/hooks/fp-home";

import { hostname } from "node:os";
import {
  clearCloudCredentials,
  cloudCredentialPath,
  maskToken,
  readCloudCredentials,
  resolveMachineId,
  resolveMachineLabel,
  validateCloudUrl,
  verifyCloudCredentials,
  writeCloudCredentials,
} from "../../src/hooks/cloud-enrollment";

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "fpai-enroll-"));
  process.env.FAILPROOFAI_CLOUD_CREDENTIALS = resolve(dir, "cloud.json");
  // `resolveMachineId` reads `config.json`'s collector block before minting, and
  // that file lives under the failproofai home. Without pinning the home the
  // suite reads the DEVELOPER'S real config: "mints a fresh id" then passes on a
  // clean CI runner and fails on any machine that has actually been connected —
  // the worst shape of flake, because it only appears where someone is working.
  // Saved and restored rather than deleted, matching the other hook suites.
  prevHome = process.env.FAILPROOFAI_HOME;
  process.env.FAILPROOFAI_HOME = dir;
});

afterEach(() => {
  delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write `collector.machine_id` into the real `config.json`, through the real
 * on-disk shape (snake_case, nested under `collector`) rather than a mock — the
 * parse in `readConfig` is part of what is under test here.
 */
function writeCollectorMachineId(id: unknown): void {
  writeFileSync(
    configFile(),
    JSON.stringify({ mode: { kind: "cloud" }, collector: { machine_id: id } }),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("resolveMachineId", () => {
  it("uses an explicit id verbatim", () => {
    expect(resolveMachineId("prod-build-3")).toBe("prod-build-3");
    expect(resolveMachineId("  spaced  ")).toBe("spaced");
  });

  it("mints a fresh UUID when nothing is enrolled and none is given", () => {
    const id = resolveMachineId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Not the hostname — that is the whole point of minting.
    expect(id).not.toBe(hostname());
  });

  it("reuses the already-enrolled id instead of minting again", () => {
    writeCloudCredentials({ url: "https://x", machineId: "existing-id", token: "t" });
    expect(resolveMachineId()).toBe("existing-id");
    // An explicit id still overrides a stored one.
    expect(resolveMachineId("override")).toBe("override");
  });

  it("does not memoise a mint — two calls with nothing stored are two ids", () => {
    // Guards the reading that minting somehow "registers" the machine. It does
    // not: the value is only stable once `connectToCloud` has written it, which
    // is exactly why the fallbacks below have to be exhaustive.
    expect(resolveMachineId()).not.toBe(resolveMachineId());
  });
});

/**
 * The collector-config fallback.
 *
 * `connectToCloud` writes the id to two files under two INDEPENDENT conditions
 * — `credentials.json` when `policies:pull` verified, `config.json`'s collector
 * block when `events:add` did. Consulting only the first meant an ingest-only
 * first connect left the id somewhere this function never looked, so the next
 * connect minted a second identity for one host and split it into two machines
 * server-side, stranding the first one's history.
 */
describe("resolveMachineId falls back to collector.machine_id", () => {
  it("reuses the collector id when no cloud credential exists", () => {
    writeCollectorMachineId("collector-owned-id");
    expect(resolveMachineId()).toBe("collector-owned-id");
  });

  it("REPRODUCES the split: a telemetry-only connect then a policy connect keep one id", () => {
    // Step 1 — a key with `events:add` but not `policies:pull`. `connectToCloud`
    // writes the collector block and NOTHING else, because the policy check
    // failed. This is the state the `collector` key preset produces.
    const first = resolveMachineId();
    writeCollectorMachineId(first);
    expect(readCloudCredentials()).toBeNull();

    // Step 2 — the operator creates a policies-capable key and reconnects.
    // Before this fix the empty cloud credential sent it straight to
    // `randomUUID()`, and the host became two machines.
    const second = resolveMachineId();
    expect(second).toBe(first);
  });

  it("prefers the CLOUD credential when the two disagree", () => {
    // The server keys enrolment, deployment and history on the id it was given,
    // so the cloud credential is the association that must not break. This is
    // the one ordering in the chain that is load-bearing rather than cosmetic.
    writeCloudCredentials({ url: "https://x", machineId: "cloud-id", token: "t" });
    writeCollectorMachineId("collector-id");
    expect(resolveMachineId()).toBe("cloud-id");
  });

  it("still lets an explicit id override the collector block", () => {
    writeCollectorMachineId("collector-id");
    expect(resolveMachineId("explicit-id")).toBe("explicit-id");
    expect(resolveMachineId("  padded-id  ")).toBe("padded-id");
  });

  it("returns the collector id VERBATIM, without trimming", () => {
    // The daemon stamps this value on events exactly as written (`spool.rs`
    // filters only the empty string). Normalising it here would hand the cloud a
    // different id than the events carry — reintroducing the split from the
    // other side.
    writeCollectorMachineId(" pad-me ");
    expect(resolveMachineId()).toBe(" pad-me ");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a tab and newline", "\t\n"],
  ])("mints instead of adopting %s", (_label, value) => {
    // None of these identify anything, and the server refuses them
    // (`safe_identifier`), so adopting one would produce a machine that can
    // never enrol — worse than a fresh id.
    writeCollectorMachineId(value);
    expect(resolveMachineId()).toMatch(UUID_RE);
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an object", { nested: true }],
    ["an array", ["a"]],
    ["a boolean", true],
  ])("mints when the collector id is %s rather than a string", (_label, value) => {
    // `readConfig` already narrows on `typeof === "string"`; this pins that the
    // fallback cannot be tricked into returning a non-string by a hand-edited
    // config, which would then be interpolated into a URL.
    writeCollectorMachineId(value);
    const id = resolveMachineId();
    expect(typeof id).toBe("string");
    expect(id).toMatch(UUID_RE);
  });

  it("mints when config.json is missing entirely", () => {
    expect(existsSync(configFile())).toBe(false);
    expect(resolveMachineId()).toMatch(UUID_RE);
  });

  it("mints when config.json is corrupt, rather than throwing", () => {
    // Enrolment must survive a damaged config: `readConfig` swallows the parse
    // failure and answers with defaults, and this asserts the fallback inherits
    // that rather than propagating an exception on the connect path.
    writeFileSync(configFile(), "{ this is not json");
    expect(() => resolveMachineId()).not.toThrow();
    expect(resolveMachineId()).toMatch(UUID_RE);
  });

  it("mints when the collector block has no machine_id at all", () => {
    // The shape a machine that connected before machine ids existed has.
    writeFileSync(
      configFile(),
      JSON.stringify({ mode: { kind: "cloud" }, collector: { sessions: true, hooks: true } }),
    );
    expect(resolveMachineId()).toMatch(UUID_RE);
  });

  it("is idempotent — repeated calls return the same collector id", () => {
    writeCollectorMachineId("stable-id");
    expect(resolveMachineId()).toBe("stable-id");
    expect(resolveMachineId()).toBe("stable-id");
    expect(resolveMachineId()).toBe("stable-id");
  });

  it("adopts an id that is not a UUID, e.g. one set by --machine-id earlier", () => {
    // An operator who set `--machine-id prod-runner-01` on the ingest-only
    // connect must get that back, not a UUID that silently replaces it.
    writeCollectorMachineId("prod-runner-01");
    expect(resolveMachineId()).toBe("prod-runner-01");
  });
});

describe("resolveMachineLabel", () => {
  it("uses an explicit label, else falls back to the hostname", () => {
    expect(resolveMachineLabel("Chetan's laptop")).toBe("Chetan's laptop");
    expect(resolveMachineLabel("  ")).toBe(hostname());
    expect(resolveMachineLabel()).toBe(hostname());
  });
});

describe("machineLabel round-trips through the credentials.json cloud object", () => {
  // The default tests use the JSON override; this one exercises the real TOML
  // path (layout 2), where the label lives in the [cloud] table of
  // credentials.toml and must survive a write → read.
  let homeDir: string;
  beforeEach(() => {
    delete process.env.FAILPROOFAI_CLOUD_CREDENTIALS;
    homeDir = mkdtempSync(resolve(tmpdir(), "fpai-home-"));
    process.env.FAILPROOFAI_HOME = homeDir;
  });
  afterEach(() => {
    delete process.env.FAILPROOFAI_HOME;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes machine_label into the JSON and reads it back", () => {
    writeCloudCredentials({
      url: "https://be.failproof.ai",
      machineId: "id-123",
      token: "tok",
      machineLabel: "Chetan's laptop",
    });
    expect(JSON.parse(readFileSync(credentialsFile(), "utf8")).cloud.machine_label).toBe(
      "Chetan's laptop",
    );
    expect(readCloudCredentials()).toEqual({
      url: "https://be.failproof.ai",
      machineId: "id-123",
      token: "tok",
      machineLabel: "Chetan's laptop",
    });
  });

  it("omits machine_label when there is none, and reads back undefined", () => {
    writeCloudCredentials({ url: "https://x", machineId: "id-1", token: "t" });
    expect(readFileSync(credentialsFile(), "utf8")).not.toMatch(/machine_label/);
    expect(readCloudCredentials()?.machineLabel).toBeUndefined();
  });
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
    respond = () => ({ status: 200, body: JSON.stringify({ schemaVersion: 1, deployment: 4, policies: [] }) });
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
      return { status: 200, body: JSON.stringify({ deployment: 9, policies: [{ id: "a" }, { id: "b" }] }) };
    };
    const result = await verifyCloudCredentials(creds());
    expect(result).toEqual({ ok: true, policyCount: 2, deployment: 9 });
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
