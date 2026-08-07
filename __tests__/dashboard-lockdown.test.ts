// @vitest-environment node
/**
 * The local dashboard's access control.
 *
 * These tests encode real exploits, not shapes. The dashboard has no
 * authentication and can toggle policies and uninstall failproofai's hooks from
 * every agent CLI, so each case below is written as "the attack that would
 * work", and passing means it no longer does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import {
  DEFAULT_DASHBOARD_HOST,
  hostnameFromHostHeader,
  hostnameFromOrigin,
  isLoopbackHostname,
  resolveDashboardHost,
} from "@/lib/dashboard-host";

const ORIGINAL = process.env.FAILPROOFAI_DASHBOARD_HOST;

beforeEach(() => {
  // The launcher exports this; default the tests to the shipped posture.
  process.env.FAILPROOFAI_DASHBOARD_HOST = "127.0.0.1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FAILPROOFAI_DASHBOARD_HOST;
  else process.env.FAILPROOFAI_DASHBOARD_HOST = ORIGINAL;
  vi.restoreAllMocks();
});

/** Build a request the way a browser would, with explicit Host/Origin control. */
function req(
  url: string,
  opts: { method?: string; host?: string | null; origin?: string | null; extra?: Record<string, string> } = {},
): NextRequest {
  const headers = new Headers();
  if (opts.host !== null) headers.set("host", opts.host ?? "localhost:8020");
  if (opts.origin) headers.set("origin", opts.origin);
  for (const [k, v] of Object.entries(opts.extra ?? {})) headers.set(k, v);
  return new NextRequest(new URL(url), { method: opts.method ?? "GET", headers });
}

describe("host pinning — the DNS-rebinding defence", () => {
  it("REFUSES a rebound request whose Host is the attacker's domain", async () => {
    // The rebinding attack in full: attacker.tld resolves to 127.0.0.1 on the
    // second lookup, so the request lands on our loopback socket. Origin and
    // Host agree, which is exactly why every framework same-origin check —
    // including Next's `originHost !== host.value` — waves it through. Only
    // pinning Host to loopback catches it. A loopback BIND does not: rebinding
    // targets 127.0.0.1 on purpose.
    const res = await proxy(
      req("http://attacker.tld:8020/api/auth/login-verify", {
        method: "POST",
        host: "attacker.tld:8020",
        origin: "http://attacker.tld:8020",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("REFUSES a rebound GET, which is how transcripts would be read", async () => {
    const res = await proxy(
      req("http://attacker.tld:8020/api/download/proj/sess", { host: "attacker.tld:8020" }),
    );
    expect(res.status).toBe(403);
  });

  it("allows every loopback spelling", async () => {
    for (const host of ["localhost:8020", "127.0.0.1:8020", "[::1]:8020", "127.0.0.2:8020"]) {
      const res = await proxy(req(`http://${host}/policies`, { host }));
      expect(res.status, host).not.toBe(403);
    }
  });

  it("REFUSES a request with no Host header at all", async () => {
    expect((await proxy(req("http://localhost:8020/policies", { host: null }))).status).toBe(403);
  });

  it("stops pinning Host when the operator deliberately bound a routable address", async () => {
    // Opting into --host 0.0.0.0 is accepting reachability; we cannot know which
    // Host such an operator intends to answer to, so the pin would only break
    // the setup they asked for.
    process.env.FAILPROOFAI_DASHBOARD_HOST = "0.0.0.0";
    const res = await proxy(req("http://192.168.1.5:8020/policies", { host: "192.168.1.5:8020" }));
    expect(res.status).not.toBe(403);
  });
});

describe("origin checking — the ordinary drive-by defence", () => {
  it("REFUSES the cross-origin POST that grafts an attacker's account (C1)", async () => {
    // login-verify is unauthenticated and never checks the email relates to an
    // existing session, and req.json() ignores Content-Type — so this is a CORS
    // *simple* request: no preflight, the side effect lands, and the attacker
    // never needs to read the response. Whoever owns auth.json receives every
    // future audit report.
    const res = await proxy(
      req("http://localhost:8020/api/auth/login-verify", {
        method: "POST",
        origin: "https://evil.example",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("REFUSES the cross-origin mail-sending primitive (C2)", async () => {
    const res = await proxy(
      req("http://localhost:8020/api/auth/login-request", {
        method: "POST",
        origin: "https://evil.example",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("REFUSES a cross-origin server action, which could uninstall every hook (C3)", async () => {
    // removeHooksWebAction("all") strips failproofai out of ~/.claude/settings.json,
    // .codex/hooks.json, ~/.hermes/config.yaml and the rest. Next's own check
    // covers this one, but defence in depth is the point: this must not depend
    // on a framework internal we do not control.
    const res = await proxy(
      req("http://localhost:8020/policies", { method: "POST", origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  it("REFUSES another app on a different local port", async () => {
    // Same hostname, different authority. A local dev server on :3000 is a
    // different origin and has no business mutating this one.
    const res = await proxy(
      req("http://localhost:8020/api/audit/run", { method: "POST", origin: "http://localhost:3000" }),
    );
    expect(res.status).toBe(403);
  });

  it("REFUSES an opaque 'null' Origin", async () => {
    // Sandboxed iframes and some redirect chains send literally "null"; it must
    // not parse into something permissive.
    const res = await proxy(
      req("http://localhost:8020/api/audit/run", { method: "POST", origin: "null" }),
    );
    expect(res.status).toBe(403);
  });

  it("ALLOWS the dashboard's own same-origin POST", async () => {
    const res = await proxy(
      req("http://localhost:8020/api/audit/run", {
        method: "POST",
        origin: "http://localhost:8020",
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it("does not origin-check safe methods", async () => {
    // A cross-origin GET cannot read the response without CORS headers, which
    // are never sent, so blocking it would cost compatibility for no gain.
    const res = await proxy(
      req("http://localhost:8020/policies", { origin: "https://evil.example" }),
    );
    expect(res.status).not.toBe(403);
  });

  it("ALLOWS an origin-less mutating request (a local non-browser caller)", async () => {
    // curl and friends. With a loopback bind this is necessarily a local
    // process, which can already rewrite these files directly — refusing it
    // would buy nothing and break scripted use.
    const res = await proxy(req("http://localhost:8020/api/audit/run", { method: "POST" }));
    expect(res.status).not.toBe(403);
  });

  // The exemption above is entirely an argument about the BIND address, and it
  // used to be applied unconditionally. On a deliberate non-loopback bind all
  // three layers were then off at once: layer 1 by the operator's choice, layer
  // 2 because the Host pin is skipped for exactly that case (see the test
  // above), and layer 3 because no Origin is the default for curl and every
  // other non-browser client. Any host on the segment could reach every
  // mutating route.
  describe("on a deliberately non-loopback bind", () => {
    beforeEach(() => {
      process.env.FAILPROOFAI_DASHBOARD_HOST = "0.0.0.0";
    });

    it("REFUSES an origin-less POST — it is no longer necessarily local", async () => {
      const res = await proxy(
        req("http://192.168.1.5:8020/api/audit/run", { method: "POST", host: "192.168.1.5:8020" }),
      );
      expect(res.status).toBe(403);
    });

    it("REFUSES the origin-less token graft the lockdown suite exists to stop", async () => {
      // login-verify is unauthenticated and writes auth.json — whoever lands
      // there receives every future audit report.
      const res = await proxy(
        req("http://192.168.1.5:8020/api/auth/login-verify", {
          method: "POST",
          host: "192.168.1.5:8020",
        }),
      );
      expect(res.status).toBe(403);
    });

    it("REFUSES an origin-less hook uninstall", async () => {
      const res = await proxy(
        req("http://192.168.1.5:8020/policies", { method: "POST", host: "192.168.1.5:8020" }),
      );
      expect(res.status).toBe(403);
    });

    it("still allows a same-origin mutating request, so the bind stays usable", async () => {
      // The point is to require a real same-origin claim, not to break the
      // container/remote-dev-box setup the operator deliberately asked for.
      const res = await proxy(
        req("http://192.168.1.5:8020/policies", {
          method: "POST",
          host: "192.168.1.5:8020",
          origin: "http://192.168.1.5:8020",
        }),
      );
      expect(res.status).not.toBe(403);
    });

    it("still allows origin-less READS — only mutating methods are gated", async () => {
      const res = await proxy(req("http://192.168.1.5:8020/policies", { host: "192.168.1.5:8020" }));
      expect(res.status).not.toBe(403);
    });
  });
});

describe("x-forwarded-host is stripped", () => {
  it("removes the header before it reaches framework code that trusts it", async () => {
    // Next resolves the request Host preferring x-forwarded-host, so a caller
    // able to set headers could otherwise satisfy the action handler's origin
    // comparison against a value it supplied itself. Nothing proxies this
    // server, so the header is never legitimate here.
    const res = await proxy(
      req("http://localhost:8020/policies", { extra: { "x-forwarded-host": "evil.example" } }),
    );
    expect(res.status).not.toBe(403);
    expect(res.headers.get("x-middleware-override-headers") ?? "").not.toContain("x-forwarded-host");
  });
});

describe("dashboard-host helpers", () => {
  it("defaults to loopback, never the wildcard", () => {
    expect(DEFAULT_DASHBOARD_HOST).toBe("127.0.0.1");
    expect(resolveDashboardHost(undefined, undefined)).toBe("127.0.0.1");
    expect(isLoopbackHostname(DEFAULT_DASHBOARD_HOST)).toBe(true);
  });

  it("prefers the flag, then the env, then the default", () => {
    expect(resolveDashboardHost("0.0.0.0", "10.0.0.1")).toBe("0.0.0.0");
    expect(resolveDashboardHost(undefined, "10.0.0.1")).toBe("10.0.0.1");
    expect(resolveDashboardHost("   ", undefined)).toBe("127.0.0.1");
  });

  it("classifies loopback correctly, including the whole 127/8 block", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.13.9.2", "::1", "[::1]"]) {
      expect(isLoopbackHostname(h), h).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.1.5", "evil.example", "127.0.0.1.evil.com", "", "10.0.0.1"]) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });

  it("splits the port off a Host header, including bracketed IPv6", () => {
    expect(hostnameFromHostHeader("localhost:8020")).toBe("localhost");
    expect(hostnameFromHostHeader("localhost")).toBe("localhost");
    expect(hostnameFromHostHeader("[::1]:8020")).toBe("[::1]");
    expect(hostnameFromHostHeader("[::1]")).toBe("[::1]");
  });

  it("extracts an Origin hostname and refuses junk", () => {
    expect(hostnameFromOrigin("http://localhost:8020")).toBe("localhost");
    expect(hostnameFromOrigin("http://[::1]:8020")).toBe("[::1]");
    expect(hostnameFromOrigin("null")).toBeNull();
    expect(hostnameFromOrigin("")).toBeNull();
    expect(hostnameFromOrigin("not a url")).toBeNull();
  });
});
