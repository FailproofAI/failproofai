import { NextRequest, NextResponse } from "next/server";
import {
  hostnameFromHostHeader,
  isLoopbackHostname,
  resolveDashboardHost,
} from "./lib/dashboard-host";

/** Methods that can change something. Safe methods are not origin-checked. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Deliberately terse, and identical whichever check failed: this is an
 * unauthenticated local surface, and a body naming the failed check is a probing
 * aid. The detail goes to the server log, where only the operator sees it.
 */
function forbid(): NextResponse {
  return new NextResponse("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
}

/**
 * Refuse anything that is not a same-machine, same-origin request.
 *
 * The dashboard has no authentication and is a write surface for this machine's
 * security configuration — `removeHooksWebAction` strips failproofai's hooks out
 * of every agent CLI's settings file, and `togglePolicyAction` disables
 * individual policies. Two checks stand between an ordinary malicious web page
 * and that, and they defeat different attacks:
 *
 * **Host** — a DNS-rebinding page (a domain whose second lookup returns
 * 127.0.0.1) arrives at the loopback socket with `Host: attacker.tld`. Because
 * its Origin matches that Host, every same-origin check in the framework passes;
 * Next's own action-handler comparison is `originHost !== host.value`, which is
 * satisfied. Pinning Host to loopback is what makes rebinding fail, and a
 * loopback *bind* does not do it — rebinding targets 127.0.0.1 by design.
 *
 * **Origin** — an ordinary drive-by does not need rebinding for the route
 * handlers, which get none of the Server-Action protection. `req.json()` ignores
 * Content-Type, so `fetch(..., {method:"POST", body:'{...}'})` from any site is a
 * CORS *simple* request: no preflight, the request is delivered, the side effect
 * lands, and the attacker never needs to read the response.
 *
 * A request with no Origin at all is allowed: that is a non-browser caller, and
 * with a loopback bind it is necessarily a local process — which can already
 * read and rewrite these files directly, so refusing it buys nothing.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const bindHost = resolveDashboardHost(undefined, process.env.FAILPROOFAI_DASHBOARD_HOST);
  const boundToLoopback = isLoopbackHostname(bindHost);

  const hostHeader = request.headers.get("host");

  // Only meaningful when we are on loopback. If the operator deliberately bound
  // a routable address they have accepted reachability, and we cannot know which
  // Host they intend to answer to.
  if (boundToLoopback) {
    if (!hostHeader) {
      console.warn("[failproofai] refused a request with no Host header");
      return forbid();
    }
    if (!isLoopbackHostname(hostnameFromHostHeader(hostHeader))) {
      console.warn(`[failproofai] refused a request with Host: ${hostHeader} (expected loopback)`);
      return forbid();
    }
  }

  const origin = request.headers.get("origin");
  if (origin && MUTATING_METHODS.has(request.method)) {
    let originHost: string | null = null;
    try {
      // "null" (sandboxed iframes, some redirects) is a valid Origin value and
      // must not parse into anything permissive — the URL constructor throws on
      // it, which is the behaviour we want.
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = null;
    }
    // Compare the full authority, not just the hostname: another app on
    // localhost:3000 is a different origin and has no business POSTing here.
    if (!originHost || originHost !== (hostHeader ?? "").toLowerCase()) {
      console.warn(`[failproofai] refused a cross-origin ${request.method} from ${origin}`);
      return forbid();
    }
  }

  const { pathname } = request.nextUrl;

  if (pathname === "/") {
    const disabled = (process.env.FAILPROOFAI_DISABLE_PAGES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!disabled.includes("policies")) {
      return NextResponse.redirect(new URL("/policies", request.url));
    }
    if (!disabled.includes("projects")) {
      return NextResponse.redirect(new URL("/projects", request.url));
    }
  }

  // Next's own Host resolution prefers `x-forwarded-host` over `Host`, so a
  // caller that can set headers could otherwise satisfy the action handler's
  // origin comparison against a value it supplied itself. Nothing proxies this
  // server, so the header is never legitimate here — drop it before it reaches
  // any framework code that trusts it.
  const headers = new Headers(request.headers);
  headers.delete("x-forwarded-host");
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|icon\\.png).*)"],
};
