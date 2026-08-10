// @vitest-environment node
//
// The default ingest endpoint is written down TWICE — once in TypeScript for
// the CLI, once in Rust for the daemon — and both copies say "MUST stay
// byte-identical" while nothing checked that they were.
//
// The duplication is deliberate and cannot be removed: the CLI resolves a
// credential to VERIFY the endpoint at setup, and the daemon resolves one
// independently to POST to it. Neither reads the other's constant. So a
// divergence does not fail loudly — the CLI validates one URL, tells the user
// they are connected, and the daemon ships to a different one. The daemon looks
// healthy, the wizard looked happy, and nothing ever arrives. That failure is
// invisible from both ends, which is precisely why it needs a tripwire rather
// than a comment.
//
// Read from SOURCE rather than by importing the TS constant and shelling out to
// cargo: this must fail on a machine with no Rust toolchain, in CI's quality
// job, and before anything is compiled.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_INGEST_URL } from "../../src/hooks/collector-config";
import { INGEST_PATH } from "../../src/hooks/cloud-connection";

const RUST_CONFIG = resolve(__dirname, "../../crates/fpai-collect/src/config.rs");

/** The Rust literal, read out of the source text. */
function rustDefaultIngestUrl(): string {
  const src = readFileSync(RUST_CONFIG, "utf-8");
  const m = /pub const DEFAULT_INGEST_URL: &str = "([^"]+)";/.exec(src);
  if (!m) {
    throw new Error(
      `Could not find DEFAULT_INGEST_URL in ${RUST_CONFIG}. If it was renamed or ` +
        `restructured, update this test — do not delete it; it is the only thing ` +
        `keeping the two copies in agreement.`,
    );
  }
  return m[1];
}

describe("DEFAULT_INGEST_URL — the TS and Rust copies", () => {
  it("are byte-identical", () => {
    expect(rustDefaultIngestUrl()).toBe(DEFAULT_INGEST_URL);
  });

  it("carry the versioned path, not the flat one", () => {
    // `/v1/events`, never `/events`. The server mounts its routes twice so both
    // work when talking to it DIRECTLY — which is what makes a flat path look
    // fine in a Compose test and fail on the hosted deployment, where the proxy
    // routes only `/v1/*` to the server and hands `/events` to the Next.js app.
    // That app answers, so the failure is a cheerful 200 rather than an error.
    expect(DEFAULT_INGEST_URL.endsWith(INGEST_PATH)).toBe(true);
    expect(rustDefaultIngestUrl().endsWith(INGEST_PATH)).toBe(true);
  });

  it("is https, since it carries a bearer token", () => {
    // `validateCloudUrl` permits http for loopback only. The shipped default is
    // never loopback, so http here would put every machine's ingest key on the
    // wire in clear.
    expect(DEFAULT_INGEST_URL.startsWith("https://")).toBe(true);
  });

  it("is a complete endpoint, so nothing joins a path onto it", () => {
    // The Rust side POSTs to this value verbatim (`client.post(&self.url)`).
    // A bare origin here would ship every batch to the site root.
    const u = new URL(DEFAULT_INGEST_URL);
    expect(u.pathname).not.toBe("/");
    expect(u.search).toBe("");
    expect(u.hash).toBe("");
  });
});
