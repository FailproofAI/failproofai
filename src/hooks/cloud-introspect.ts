/**
 * `GET /v1/auth/introspect` — asking the server what a key actually is.
 *
 * Before this endpoint existed a machine could not describe its own
 * credential: every other `/keys*` route needs a `keys:*` permission that a
 * machine credential must never hold. So a revoked key, a valid key missing
 * one permission, and a valid key pointed at the WRONG ORG all failed
 * identically — at the point of use, later, as an empty dashboard.
 *
 * Introspect answers all three at connect time, in one request:
 *
 *   is the key accepted at all?          401 vs 200
 *   which org will this machine report into?   org_slug / org_name
 *   can it do the job it was provisioned for?  permissions
 *
 * ## Effective, not granted — the subtle part
 *
 * Permissions imply other permissions, and the server widens a grant at
 * authentication time (`expand_implied`): `alerts:read` also carries
 * `issues:read`, and so on. Authorization is checked against the WIDENED set.
 *
 * The dashboard's key page and the CLI both display the *stored* grant, so both
 * understate what a key can do. Introspect returns what the server actually
 * enforces — which is precisely why a local permission check is only correct
 * when it is built against this response and not against the displayed list.
 *
 * ## Do not poll this
 *
 * `/v1` has no rate limiting and failed auth is not negatively cached: one bad
 * token is one database lookup per request. This runs ONCE, when a machine is
 * provisioned. Revocation and expiry are cached server-side for up to a minute,
 * so treat a positive answer as current to within a minute — never to the
 * second.
 */

/** The path introspect is served on, appended to the cloud origin. */
export const INTROSPECT_PATH = "/v1/auth/introspect";

export interface KeyIdentity {
  keyId?: string;
  orgId?: string;
  orgSlug?: string;
  orgName?: string;
  /** The EFFECTIVE permission set — what the server enforces. */
  permissions: string[];
  expiresAt?: string | null;
}

export type IntrospectResult =
  | { kind: "ok"; identity: KeyIdentity }
  /** The key was refused. Nothing more is knowable — the body carries no detail. */
  | { kind: "rejected" }
  /**
   * This server has no introspect endpoint, i.e. it predates the endpoint.
   * The caller must fall back to probing rather than treating it as a bad key:
   * the CLI ships independently of whatever AgentEye a customer runs, so a
   * perfectly good key on an older server must still connect.
   */
  | { kind: "unsupported" }
  /** Network/DNS/TLS — indistinguishable from a typo'd host, so reported as-is. */
  | { kind: "unreachable"; reason: string };

export function introspectUrlFor(origin: string): string {
  return `${origin.replace(/\/$/, "")}${INTROSPECT_PATH}`;
}

export async function introspectKey(
  origin: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<IntrospectResult> {
  // AbortController rather than the shared fetchWithTimeout helper: this needs
  // an injectable `fetch` so tests never reach the network, and that helper
  // closes over the global one.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(introspectUrlFor(origin), {
      headers: { Authorization: `Bearer ${token}` },
      // Never follow a redirect. The dashboard app answers unrouted paths and
      // will happily 307 to a login page that then returns 200 — which would
      // read as a valid key against an endpoint that authenticated nothing.
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Deliberately does not echo the URL: setup is routinely run while
    // screen-sharing, and the host may be one the user would rather not show.
    return { kind: "unreachable", reason: message };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) return { kind: "rejected" };
  // 404 is "this server has no such route"; a redirect means we reached the web
  // app rather than the API, which on an older deployment means the same thing.
  if (res.status === 404 || (res.status >= 300 && res.status < 400)) {
    return { kind: "unsupported" };
  }
  if (!res.ok) return { kind: "unreachable", reason: `the server answered ${res.status}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // A 200 that is not JSON is a proxy or a static host, not introspect.
    return { kind: "unsupported" };
  }

  const b = body as Record<string, unknown>;
  // `valid: false` is not documented as a 200 shape, but treating a negative
  // assertion as success would be the worst possible reading of it.
  if (b.valid === false) return { kind: "rejected" };
  if (!Array.isArray(b.permissions)) {
    // Shaped like something else entirely — an unrelated 200 from a proxy.
    return { kind: "unsupported" };
  }

  return {
    kind: "ok",
    identity: {
      keyId: typeof b.key_id === "string" ? b.key_id : undefined,
      orgId: typeof b.org_id === "string" ? b.org_id : undefined,
      orgSlug: typeof b.org_slug === "string" ? b.org_slug : undefined,
      orgName: typeof b.org_name === "string" ? b.org_name : undefined,
      permissions: b.permissions.filter((p): p is string => typeof p === "string"),
      expiresAt: typeof b.expires_at === "string" ? b.expires_at : null,
    },
  };
}

/** The permission each capability needs. Named so the messages can quote them. */
export const PERMISSION_EVENTS = "events:add";
export const PERMISSION_POLICIES = "policies:pull";

export function hasPermission(identity: KeyIdentity, permission: string): boolean {
  return identity.permissions.includes(permission);
}

/** "Acme Inc (acme)", or the slug/id alone when the server sent less. */
export function describeOrg(identity: KeyIdentity): string {
  if (identity.orgName && identity.orgSlug) return `${identity.orgName} (${identity.orgSlug})`;
  return identity.orgName ?? identity.orgSlug ?? identity.orgId ?? "an unknown organisation";
}
