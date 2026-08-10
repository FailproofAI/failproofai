/**
 * Where the local dashboard binds, and which `Host` headers it will answer to.
 *
 * Shared by `scripts/launch.ts` (which chooses the bind address) and `proxy.ts`
 * (which enforces it per request), because the two drifting apart is exactly how
 * a lockdown quietly stops working.
 *
 * ## Why this exists
 *
 * The dashboard is a WRITE surface for this machine's security configuration —
 * it can toggle policies and uninstall failproofai's hooks from every agent CLI
 * — and it has no authentication of any kind. It used to bind `0.0.0.0`
 * unconditionally, so every peer on the network could do all of that.
 *
 * Binding loopback is necessary but NOT sufficient. A malicious page can still
 * reach `http://localhost:8020` from the victim's own browser, and DNS
 * rebinding (a domain that resolves to 127.0.0.1 after first load) defeats an
 * `Origin === Host` comparison, because both then read as the attacker's
 * domain. So the defence is three layers, and all three are load-bearing:
 *
 *   1. bind loopback by default (kills every off-machine caller);
 *   2. answer only to a loopback `Host` (kills DNS rebinding, whose whole trick
 *      is arriving with an attacker-controlled Host);
 *   3. reject cross-origin mutating requests by `Origin` (kills the ordinary
 *      drive-by, which arrives with a perfectly valid `Host: localhost:8020`
 *      and an `Origin` of the attacker's site).
 *
 * Layer 2 is what makes layer 3 trustworthy: without it, a rebound page is
 * same-origin by the browser's own reckoning and layer 3 waves it through.
 */

/** The default bind address. Loopback — never the wildcard. */
export const DEFAULT_DASHBOARD_HOST = "127.0.0.1";

/**
 * Hostnames that mean "this machine". `[::1]` is the bracketed form as it
 * appears in a `Host` header; `::1` is the bare form as it appears in a bind
 * address.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/**
 * True for any address that only this machine can reach.
 *
 * The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1 — some setups
 * bind 127.0.0.2 to separate services, and treating that as external would
 * refuse a request the user deliberately arranged.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The hostname part of a `Host` header, with the port removed.
 *
 * IPv6 literals are bracketed (`[::1]:8020`), so the port cannot be found by
 * looking for the last colon without handling the brackets first — `[::1]`
 * is all colons.
 */
export function hostnameFromHostHeader(hostHeader: string): string {
  const raw = hostHeader.trim();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw : raw.slice(0, end + 1);
  }
  const colon = raw.indexOf(":");
  return colon === -1 ? raw : raw.slice(0, colon);
}

/** The hostname part of an `Origin` header (`http://localhost:8020` -> `localhost`). */
export function hostnameFromOrigin(origin: string): string | null {
  const raw = origin.trim();
  // "null" is a real Origin value (sandboxed iframes, some redirects). It is
  // never ours, so it must not parse into something permissive.
  if (!raw || raw === "null") return null;
  try {
    const url = new URL(raw);
    // `URL.hostname` KEEPS the brackets on an IPv6 literal ("[::1]"), which is
    // already the form a Host header carries — so it passes through untouched.
    // Bracketing it again would produce "[[::1]]" and never match anything.
    return url.hostname || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the bind address from an explicit flag, then the environment, then
 * the safe default.
 *
 * An explicit non-loopback value is honoured — someone running the dashboard in
 * a container or on a remote dev box has a real need — but it is a deliberate
 * act, and `launch.ts` says so out loud when it happens.
 */
export function resolveDashboardHost(flagHost?: string, envHost?: string): string {
  const chosen = (flagHost ?? envHost ?? "").trim();
  return chosen || DEFAULT_DASHBOARD_HOST;
}
