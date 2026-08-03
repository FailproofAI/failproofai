// @vitest-environment node
//
// The credential half of this is a security property, not a behaviour:
// `policies-config.json` is 0664 inside a 0775 `~/.failproofai` on a normal
// machine, which is exactly why the key lives in its own file at 0600.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_INGEST_URL,
  writeIngestCredential,
  validateIngestKey,
  hasIngestCredential,
  ingestPath,
} from "@/src/hooks/collector-config";

describe("collector credential storage", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.FAILPROOFAI_HOME;
    home = mkdtempSync(join(tmpdir(), "fpai-cc-"));
    process.env.FAILPROOFAI_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
    else process.env.FAILPROOFAI_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the credential owner-only", () => {
    const path = writeIngestCredential({ url: DEFAULT_INGEST_URL, key: "sk-secret" });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).key).toBe("sk-secret");
  });

  it("tightens a world-traversable home", () => {
    // A 0600 file inside a 0775 directory is still reachable by every local
    // user, and ~/.failproofai really is 0775 on a normal machine.
    chmodSync(home, 0o775);
    writeIngestCredential({ url: DEFAULT_INGEST_URL, key: "k" });
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("fixes the mode of an already-permissive credential file", () => {
    // `mode` on writeFileSync applies only when the file is CREATED, so
    // without the explicit chmod an existing 0644 file keeps its mode.
    mkdirSync(home, { recursive: true });
    writeFileSync(ingestPath(), "{}");
    chmodSync(ingestPath(), 0o644);

    writeIngestCredential({ url: DEFAULT_INGEST_URL, key: "k" });
    expect(statSync(ingestPath()).mode & 0o777).toBe(0o600);
  });

  it("reports whether a credential is configured", () => {
    expect(hasIngestCredential()).toBe(false);
    writeIngestCredential({ url: DEFAULT_INGEST_URL, key: "k" });
    expect(hasIngestCredential()).toBe(true);
  });
});

describe("ingest key validation", () => {
  const cred = { url: "https://example.test/events", key: "k" };

  it("accepts a key the server answers 2xx for", async () => {
    const fake = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await validateIngestKey(cred, fake)).toEqual({ ok: true });
  });

  it("names a rejected key rather than reporting a generic failure", async () => {
    // The whole point of checking at setup: a typo'd key is otherwise only
    // discovered later as a pile of 401s parked in failed/, which reads like a
    // server problem.
    const fake = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const res = await validateIngestKey(cred, fake);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain("rejected that key");
  });

  it("distinguishes a wrong URL from a wrong key", async () => {
    const fake = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const res = await validateIngestKey(cred, fake);
    expect(res.ok === false && res.reason).toContain("no ingest endpoint");
  });

  it("reports an unreachable server without echoing the URL back", async () => {
    // The URL can carry an internal hostname the user would rather not have in
    // a shared terminal recording.
    const fake = (async () => {
      throw new Error("getaddrinfo ENOTFOUND internal.corp.example");
    }) as unknown as typeof fetch;
    const res = await validateIngestKey(cred, fake);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain("could not reach");
  });

  it("sends an empty body so checking creates no event", async () => {
    // Verifying with a real event would put a spurious row in the user's
    // dashboard every time they ran setup.
    let seenBody: unknown = "unset";
    let seenAuth: string | null = null;
    const fake = (async (_url: string, init: RequestInit) => {
      seenBody = init.body;
      seenAuth = new Headers(init.headers).get("authorization");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await validateIngestKey({ url: cred.url, key: "abc" }, fake);
    expect(seenBody).toBe("");
    expect(seenAuth).toBe("Bearer abc");
  });
});
