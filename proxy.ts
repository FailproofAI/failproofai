import { NextRequest, NextResponse } from "next/server";
import {
  DASHBOARD_TOKEN_PARAM,
  dashboardToken,
  dashboardTokenCookie,
  hostnameFromHostHeader,
  isLoopbackHostname,
  resolveDashboardHost,
  sameDashboardToken,
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
 * The token gate's refusal says how to get in. Unlike the checks `forbid()`
 * keeps quiet about, naming it helps no prober: a 256-bit token cannot be
 * guessed. A relaunch makes a new token, so an open tab or bookmark lands here.
 */
function forbidWithoutToken(): NextResponse {
  return new NextResponse(
    "Forbidden: open the dashboard at the address it printed when it started. " +
      "That address carries this launch's access token.",
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

/**
 * On a non-loopback bind, every request must carry this launch's access token.
 *
 * The checks below this one judge `Host` and `Origin`, which only a *browser*
 * cannot forge. On a routable bind any peer on the network can connect and send
 * both, so they stopped nothing there: GETs (transcripts, downloads) were not
 * checked at all, and a POST passed with `Origin` set to the `Host` the caller
 * itself sent. That reached every server action, including installing a policy
 * pack, which imports the downloaded code (FailproofAI/agenteye#1799).
 *
 * The launcher prints the address with `?token=`. A GET or HEAD presenting it
 * gets it back as an HttpOnly cookie and a redirect to the same address
 * without it, so it is not left in history, a bookmark, or a Referer. After
 * that the cookie must match. `SameSite=Lax` keeps it off cross-site POSTs and
 * subresource requests, while a link opened from chat or mail still works.
 * There is no `Secure` flag because the dashboard serves plain http.
 *
 * A server with no usable token (started by something other than the launcher)
 * refuses everything rather than falling back to no check.
 */
function requireAccessToken(request: NextRequest, bindHost: string): NextResponse | null {
  const expected = dashboardToken();
  if (!expected) {
    console.warn(
      `[failproofai] refused a request: the dashboard is bound to ${bindHost}, not loopback, ` +
        "and was started without an access token",
    );
    return forbidWithoutToken();
  }
  // One cookie per port the browser reached, so two dashboards on one host
  // keep separate tokens (see `dashboardTokenCookie`).
  const cookieName = dashboardTokenCookie(request.nextUrl.port || (request.nextUrl.protocol === "https:" ? "443" : "80"));
  const presented = request.nextUrl.searchParams.get(DASHBOARD_TOKEN_PARAM);
  if (
    presented !== null &&
    (request.method === "GET" || request.method === "HEAD") &&
    sameDashboardToken(presented, expected)
  ) {
    const clean = request.nextUrl.clone();
    clean.searchParams.delete(DASHBOARD_TOKEN_PARAM);
    // Absolute: Next's middleware adapter parses `Location` with no base URL, so
    // a relative one throws. It makes the header relative again itself when the
    // host matches the request's.
    const res = NextResponse.redirect(clean, 303);
    res.headers.set("cache-control", "no-store");
    res.cookies.set(cookieName, expected, { httpOnly: true, sameSite: "lax", path: "/" });
    return res;
  }
  const cookie = request.cookies.get(cookieName)?.value;
  if (!cookie || !sameDashboardToken(cookie, expected)) {
    console.warn(
      `[failproofai] refused a ${request.method} without this launch's access token ` +
        `(the dashboard is bound to ${bindHost}, not loopback)`,
    );
    return forbidWithoutToken();
  }
  return null;
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
 * A request with no Origin at all is allowed ONLY on a loopback bind: it is a
 * non-browser caller, and on loopback that is necessarily a local process —
 * which can already read and rewrite these files directly, so refusing it buys
 * nothing. That reasoning is entirely about the bind address, and the exemption
 * used to ignore it. `dashboard-host.ts` documents and supports a deliberate
 * non-loopback bind (`--host`, `FAILPROOFAI_DASHBOARD_HOST`) for containers and
 * remote dev boxes, and on one of those "no Origin" describes every `curl` on
 * the network segment — including one grafting an OTP token into `auth.json`
 * via `/api/auth/login-verify`, uninstalling every CLI's hooks via `POST
 * /policies`, or starting a scan via `POST /api/audit/run`. Layer 1 is absent
 * by the operator's choice and layer 2 cannot apply, so this is the only layer
 * left; exempting the commonest non-browser shape from it left nothing at all.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const bindHost = resolveDashboardHost(undefined, process.env.FAILPROOFAI_DASHBOARD_HOST);
  const boundToLoopback = isLoopbackHostname(bindHost);

  if (!boundToLoopback) {
    const refused = requireAccessToken(request, bindHost);
    if (refused) return refused;
  }

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
  if (MUTATING_METHODS.has(request.method)) {
    if (!origin) {
      // See the header: only a loopback bind makes "no Origin" mean "a local
      // process that could do this by editing the files anyway".
      if (!boundToLoopback) {
        console.warn(
          `[failproofai] refused a ${request.method} with no Origin header — ` +
            `the dashboard is bound to ${bindHost}, not loopback, so an Origin-less ` +
            `request is not necessarily local`,
        );
        return forbid();
      }
    } else {
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
