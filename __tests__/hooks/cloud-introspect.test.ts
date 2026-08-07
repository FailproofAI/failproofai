import { describe, it, expect } from "vitest";
import {
  introspectKey,
  introspectUrlFor,
  hasPermission,
  describeOrg,
  PERMISSION_EVENTS,
  PERMISSION_POLICIES,
  type KeyIdentity,
} from "../../src/hooks/cloud-introspect";

/** A fetch that answers once with the given status/body, recording the request. */
function stubFetch(res: {
  status: number;
  body?: unknown;
  text?: string;
  throws?: Error;
}): typeof fetch & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (res.throws) throw res.throws;
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      json: async () => {
        if (res.text !== undefined) throw new SyntaxError("not json");
        return res.body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

const VALID = {
  key_id: "key_abc",
  org_id: "org_123",
  org_slug: "acme",
  org_name: "Acme Inc",
  permissions: ["events:add", "policies:pull", "issues:read"],
  expires_at: null,
};

describe("introspectUrlFor", () => {
  it("appends the versioned path and tolerates a trailing slash", () => {
    expect(introspectUrlFor("https://api.example.com")).toBe(
      "https://api.example.com/v1/auth/introspect",
    );
    expect(introspectUrlFor("https://api.example.com/")).toBe(
      "https://api.example.com/v1/auth/introspect",
    );
  });
});

describe("introspectKey", () => {
  it("returns the identity and the EFFECTIVE permission set", async () => {
    const f = stubFetch({ status: 200, body: VALID });
    const r = await introspectKey("https://api.example.com", "k-secret", f);

    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.identity.orgSlug).toBe("acme");
    expect(r.identity.orgId).toBe("org_123");
    // `issues:read` is implied, not granted — the server widens the set at auth
    // time and enforces against the widened one, so that is what we must read.
    expect(r.identity.permissions).toContain("issues:read");
  });

  it("sends the token as a bearer and never as a query parameter", async () => {
    // A key in a URL lands in access logs, proxy logs and browser history.
    const f = stubFetch({ status: 200, body: VALID });
    await introspectKey("https://api.example.com", "k-secret", f);

    expect(f.calls[0].url).not.toContain("k-secret");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer k-secret",
    );
  });

  it("treats 401 and 403 as a refused key", async () => {
    for (const status of [401, 403]) {
      const r = await introspectKey("https://api.example.com", "bad", stubFetch({ status }));
      expect(r.kind).toBe("rejected");
    }
  });

  it("treats 404 as an older server, NOT as a bad key", async () => {
    // The CLI ships independently of the server a customer runs. Reading "this
    // deployment has no such route" as "your key is invalid" would strand every
    // good key on every server older than the endpoint.
    const r = await introspectKey("https://api.example.com", "k", stubFetch({ status: 404 }));
    expect(r.kind).toBe("unsupported");
  });

  it("does not follow redirects, and reads one as unsupported", async () => {
    // The dashboard app answers unrouted paths and will 307 to a login page
    // that then returns 200 — which would otherwise read as a valid key
    // against an endpoint that authenticated nothing at all.
    const f = stubFetch({ status: 307 });
    const r = await introspectKey("https://api.example.com", "k", f);

    expect(r.kind).toBe("unsupported");
    expect(f.calls[0].init.redirect).toBe("manual");
  });

  it("reads a 200 that is not JSON as unsupported", async () => {
    // A proxy or static host answering 200/text is not an introspect endpoint.
    const r = await introspectKey(
      "https://api.example.com",
      "k",
      stubFetch({ status: 200, text: "<html>hello</html>" }),
    );
    expect(r.kind).toBe("unsupported");
  });

  it("reads a 200 with no permissions array as unsupported", async () => {
    const r = await introspectKey(
      "https://api.example.com",
      "k",
      stubFetch({ status: 200, body: { hello: "world" } }),
    );
    expect(r.kind).toBe("unsupported");
  });

  it("honours an explicit valid:false on a 200", async () => {
    // Not a documented shape, but reading a negative assertion as success
    // would be the worst possible way to be wrong about it.
    const r = await introspectKey(
      "https://api.example.com",
      "k",
      stubFetch({ status: 200, body: { valid: false, permissions: [] } }),
    );
    expect(r.kind).toBe("rejected");
  });

  it("reports a 500 as unreachable rather than as a bad key", async () => {
    // A server having a bad day must not send someone off to rotate a key
    // that is perfectly fine.
    const r = await introspectKey("https://api.example.com", "k", stubFetch({ status: 500 }));
    expect(r.kind).toBe("unreachable");
  });

  it("reports a transport failure without echoing the URL", async () => {
    // Setup gets run while screen-sharing, and the host may be one the user
    // would rather not put on screen.
    const r = await introspectKey(
      "https://internal.customer.example",
      "k",
      stubFetch({ status: 0, throws: new Error("getaddrinfo ENOTFOUND") }),
    );
    expect(r.kind).toBe("unreachable");
    if (r.kind !== "unreachable") return;
    expect(r.reason).toContain("ENOTFOUND");
    expect(r.reason).not.toContain("internal.customer.example");
  });

  it("gives up rather than hanging when the server never answers", async () => {
    // A hung connect on the setup path is worse than a failure: the wizard is
    // blocking a terminal with no indication anything is wrong.
    const never = (async (_u: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const r = await introspectKey("https://api.example.com", "k", never, 20);
    expect(r.kind).toBe("unreachable");
  });
});

describe("permission helpers", () => {
  const id = (perms: string[]): KeyIdentity => ({ permissions: perms });

  it("reads the two capability permissions independently", () => {
    expect(hasPermission(id([PERMISSION_EVENTS]), PERMISSION_EVENTS)).toBe(true);
    expect(hasPermission(id([PERMISSION_EVENTS]), PERMISSION_POLICIES)).toBe(false);
    expect(hasPermission(id([PERMISSION_POLICIES]), PERMISSION_EVENTS)).toBe(false);
  });

  it("does not accept a wildcard or a prefix as the permission", () => {
    // The server expands implied permissions itself and returns the result;
    // re-implementing that expansion here is how the two drift apart.
    expect(hasPermission(id(["events:*"]), PERMISSION_EVENTS)).toBe(false);
    expect(hasPermission(id(["events"]), PERMISSION_EVENTS)).toBe(false);
  });
});

describe("describeOrg", () => {
  it("names the org the way a human would recognise it", () => {
    expect(describeOrg({ permissions: [], orgName: "Acme Inc", orgSlug: "acme" })).toBe(
      "Acme Inc (acme)",
    );
  });

  it("degrades through slug and id rather than printing nothing", () => {
    expect(describeOrg({ permissions: [], orgSlug: "acme" })).toBe("acme");
    expect(describeOrg({ permissions: [], orgId: "org_123" })).toBe("org_123");
    expect(describeOrg({ permissions: [] })).toContain("unknown");
  });
});
