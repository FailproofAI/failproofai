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
  readIngestCredential,
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
    // Stored in credentials.toml now; assert through the reader, and
    // separately that the raw file never leaks into a world-readable mode.
    expect(readIngestCredential()?.key).toBe("sk-secret");
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
    writeFileSync(ingestPath(), "");
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

  it("accepts a key the ingest endpoint answers with an ingest response", async () => {
    // The real endpoint answers `{"accepted":N,"skipped":M}` for an empty body.
    // A bare 2xx is deliberately NOT enough — see the two tests below.
    const fake = (async () =>
      new Response(JSON.stringify({ accepted: 0, skipped: 0 }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await validateIngestKey(cred, fake)).toEqual({ ok: true });
  });

  it("refuses a URL that REDIRECTS instead of accepting events", async () => {
    // The dashboard sits on another port of the same host and is printed right
    // beside the API during setup, so typing :3000 for :8080 is the likeliest
    // mistake available. It answers POST /events with a 307 to its login page,
    // which returns 200 — and `fetch` follows redirects by default, so this
    // used to read as a valid ingest endpoint. The credential was written, the
    // CLI reported success, and every batch afterwards was POSTed into a login
    // form and silently lost.
    const fake = (async () =>
      new Response("", {
        status: 307,
        headers: { location: "/login?next=%2Fevents" },
      })) as unknown as typeof fetch;
    const res = await validateIngestKey(cred, fake);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain("redirects");
  });

  it("refuses a 200 that is not an ingest response", async () => {
    // A proxy, a static host or a catch-all router will happily 200 anything.
    // Requiring the response SHAPE is what proves this is the endpoint the
    // uploader will actually be talking to.
    const fake = (async () =>
      new Response("<html>hello</html>", { status: 200 })) as unknown as typeof fetch;
    const res = await validateIngestKey(cred, fake);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain("not the events endpoint");
  });

  it("refuses a 200 whose JSON lacks an accepted count", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as unknown as typeof fetch;
    const res = await validateIngestKey(cred, fake);
    expect(res.ok).toBe(false);
  });

  it("does not follow redirects at all", async () => {
    // Belt and braces: the shape check above would also catch a followed
    // redirect, but only if the login page happened not to return ingest-shaped
    // JSON. Not following is the part that makes it unconditional.
    let seenInit: RequestInit | undefined;
    const fake = (async (_u: string, init: RequestInit) => {
      seenInit = init;
      return new Response(JSON.stringify({ accepted: 0, skipped: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    await validateIngestKey(cred, fake);
    expect(seenInit?.redirect).toBe("manual");
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
