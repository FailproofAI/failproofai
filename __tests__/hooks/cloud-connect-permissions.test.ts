/**
 * What a key's permissions do to `connectToCloud` — which capabilities it
 * probes, what it writes, and what it says.
 *
 * The permission check exists so a partial key fails at CONNECT time with a
 * message naming the missing permission, instead of at use time as an empty
 * dashboard or a machine that quietly never receives policy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { connectToCloud, describeOutcome } from "../../src/hooks/cloud-connection";
import { readCredentials, readConfig } from "../../src/hooks/fp-config";
import { credentialsFile } from "../../src/hooks/fp-home";
import { readCloudCredentials } from "../../src/hooks/cloud-enrollment";
import { readIngestCredential } from "../../src/hooks/collector-config";
import type { IntrospectResult } from "../../src/hooks/cloud-introspect";

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.FAILPROOFAI_HOME;
  home = mkdtempSync(resolve(tmpdir(), "fpai-perm-"));
  process.env.FAILPROOFAI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FAILPROOFAI_HOME;
  else process.env.FAILPROOFAI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const ORG = { orgId: "org_123", orgSlug: "acme", orgName: "Acme Inc" };

function introspecting(result: IntrospectResult) {
  return async () => result;
}

function withPermissions(...permissions: string[]) {
  return introspecting({ kind: "ok", identity: { ...ORG, permissions } });
}

/** Verifiers that record whether they ran, and always succeed if they do. */
function probes() {
  const ran = { policy: false, ingest: false };
  return {
    ran,
    verifyPolicy: async () => {
      ran.policy = true;
      return { ok: true as const, policyCount: 3, deployment: 7 };
    },
    verifyIngest: async () => {
      ran.ingest = true;
      return { ok: true as const };
    },
  };
}

function connect(introspect: () => Promise<IntrospectResult>, p = probes()) {
  return connectToCloud({
    url: "https://api.example.com",
    token: "k-secret",
    machineId: "machine-1",
    sessions: true,
    introspect,
    verifyPolicy: p.verifyPolicy,
    verifyIngest: p.verifyIngest,
  });
}

describe("a key carrying both permissions", () => {
  it("verifies and configures both capabilities", async () => {
    const p = probes();
    const outcome = await connect(withPermissions("events:add", "policies:pull"), p);

    expect(p.ran).toEqual({ policy: true, ingest: true });
    expect(outcome.policy.ok).toBe(true);
    expect(outcome.ingest.ok).toBe(true);
    expect(readCloudCredentials()).not.toBeNull();
    expect(readIngestCredential()).not.toBeNull();
    expect(readConfig().mode).toBe("cloud");
  });

  it("records the org, once, alongside the credentials", async () => {
    await connect(withPermissions("events:add", "policies:pull"));
    expect(readCredentials().org).toEqual({ id: "org_123", slug: "acme", name: "Acme Inc" });
  });
});

describe("a key missing events:add", () => {
  it("does not probe ingest, and says which permission is missing", async () => {
    const p = probes();
    const outcome = await connect(withPermissions("policies:pull"), p);

    // Not an optimisation: the 403 that probing would produce reads like a
    // server problem, where the key itself can say exactly what is wrong.
    expect(p.ran.ingest).toBe(false);
    expect(p.ran.policy).toBe(true);
    expect(outcome.ingest.ok).toBe(false);
    expect(outcome.ingest.reason).toContain("events:add");
    // Named, so a fleet operator can tell "wrong permission" from "wrong org".
    expect(outcome.ingest.reason).toContain("Acme Inc");
  });

  it("still writes the policy credential it CAN use", async () => {
    // Half a working connection is worth keeping; discarding it helps nobody.
    const outcome = await connect(withPermissions("policies:pull"));

    expect(outcome.anyConfigured).toBe(true);
    expect(readCloudCredentials()).not.toBeNull();
    expect(readIngestCredential()).toBeNull();
  });
});

describe("a key missing policies:pull", () => {
  it("does not probe policy, and still configures reporting", async () => {
    const p = probes();
    const outcome = await connect(withPermissions("events:add"), p);

    expect(p.ran.policy).toBe(false);
    expect(outcome.policy.ok).toBe(false);
    expect(outcome.policy.reason).toContain("policies:pull");
    expect(readIngestCredential()).not.toBeNull();
    expect(readCloudCredentials()).toBeNull();
  });

  it("records the org even though the cloud object was never written", async () => {
    // The case a per-table org field would have silently lost: an events-only
    // key configures ingest and nothing else, and `--status` must still be able
    // to say where this machine's data goes.
    await connect(withPermissions("events:add"));

    expect(readCredentials().org?.slug).toBe("acme");
    expect(JSON.parse(readFileSync(credentialsFile(), "utf8")).org).toMatchObject({
      slug: "acme",
    });
  });
});

describe("a key carrying neither permission", () => {
  it("probes nothing, writes nothing, and stays in oss mode", async () => {
    const p = probes();
    const outcome = await connect(withPermissions("issues:read"), p);

    expect(p.ran).toEqual({ policy: false, ingest: false });
    expect(outcome.anyConfigured).toBe(false);
    expect(readCloudCredentials()).toBeNull();
    expect(readIngestCredential()).toBeNull();
    // Mode is the hard gate every cloud path keys off. A machine that proved
    // nothing must stay provably silent.
    expect(readConfig().mode).toBe("oss");
  });

  it("records no org for a machine that connected to nothing", async () => {
    await connect(withPermissions("issues:read"));
    expect(readCredentials().org).toBeUndefined();
  });
});

describe("a key the server refuses", () => {
  it("stops at introspect without probing further", async () => {
    const p = probes();
    const outcome = await connect(introspecting({ kind: "rejected" }), p);

    expect(p.ran).toEqual({ policy: false, ingest: false });
    expect(outcome.anyConfigured).toBe(false);
    expect(outcome.policy.reason).toContain("did not accept");
    expect(outcome.ingest.reason).toContain("did not accept");
    expect(readConfig().mode).toBe("oss");
  });
});

describe("a server with no introspect endpoint", () => {
  it("falls back to probing both capabilities", async () => {
    // The CLI ships independently of the server a customer runs; a good key on
    // an older deployment has to keep working exactly as it did before.
    const p = probes();
    const outcome = await connect(introspecting({ kind: "unsupported" }), p);

    expect(p.ran).toEqual({ policy: true, ingest: true });
    expect(outcome.policy.ok).toBe(true);
    expect(outcome.ingest.ok).toBe(true);
    expect(outcome.org).toBeUndefined();
  });

  it("omits the org rather than guessing one from the URL", async () => {
    // One deployment hosts many orgs — the host says nothing about which.
    await connect(introspecting({ kind: "unsupported" }));
    expect(readCredentials().org).toBeUndefined();
  });

  it("also falls back when introspect is unreachable", async () => {
    // A blip on one endpoint must not fail a connection whose real endpoints
    // are answering fine.
    const p = probes();
    const outcome = await connect(introspecting({ kind: "unreachable", reason: "ECONNRESET" }), p);

    expect(p.ran).toEqual({ policy: true, ingest: true });
    expect(outcome.anyConfigured).toBe(true);
  });
});

describe("what the user is told", () => {
  it("names the org on a full connection", async () => {
    const outcome = await connect(withPermissions("events:add", "policies:pull"));
    expect(describeOutcome(outcome, "machine-1", "https://api.example.com").join("\n")).toContain(
      "Acme Inc (acme)",
    );
  });

  it("names the org on the PARTIAL connections too", async () => {
    // The case that makes it worth printing: a key pasted from the wrong org
    // authenticates perfectly and reports somewhere nobody is looking.
    for (const perm of ["events:add", "policies:pull"]) {
      const outcome = await connect(withPermissions(perm));
      const text = describeOutcome(outcome, "machine-1", "https://api.example.com").join("\n");
      expect(text).toContain("Acme Inc (acme)");
    }
  });

  it("says nothing about an org when the server never named one", async () => {
    const outcome = await connect(introspecting({ kind: "unsupported" }));
    const text = describeOutcome(outcome, "machine-1", "https://api.example.com").join("\n");
    expect(text).toContain("Connected to https://api.example.com as machine-1.");
    expect(text).not.toContain("into");
  });
});

/**
 * The URL guard, enforced at the boundary rather than assumed.
 *
 * `ConnectInput.url` was documented as "already validated by
 * `validateCloudUrl`", and only ONE of the two callers did it. `--connect`
 * validated; the interactive wizard — the documented primary path — checked
 * `/^https?:\/\//` and handed the raw string to `validateIngestKey` and then
 * here, so the flow most people use put the machine's bearer token on the wire
 * in clear against any `http://` host.
 */
describe("the cloud URL", () => {
  it("refuses plain http to a remote host, before probing anything", async () => {
    const p = probes();
    const outcome = await connectToCloud({
      url: "http://cloud.example.com",
      token: "k-secret",
      machineId: "machine-1",
      sessions: true,
      introspect: withPermissions("events:add", "policies:pull"),
      verifyPolicy: p.verifyPolicy,
      verifyIngest: p.verifyIngest,
    });

    expect(outcome.anyConfigured).toBe(false);
    expect(outcome.policy.reason).toMatch(/plain http/i);
    // Nothing reached the network, and nothing was written — the token must not
    // leave the machine even once to discover that the URL was unacceptable.
    expect(p.ran).toEqual({ policy: false, ingest: false });
    expect(readCloudCredentials()).toBeNull();
    expect(readIngestCredential()).toBeNull();
  });

  it("still allows plain http to loopback, which the local walkthrough needs", async () => {
    const p = probes();
    const outcome = await connectToCloud({
      url: "http://localhost:8080",
      token: "k-secret",
      machineId: "machine-1",
      sessions: true,
      introspect: withPermissions("events:add", "policies:pull"),
      verifyPolicy: p.verifyPolicy,
      verifyIngest: p.verifyIngest,
    });

    expect(outcome.anyConfigured).toBe(true);
    expect(p.ran).toEqual({ policy: true, ingest: true });
  });
});
