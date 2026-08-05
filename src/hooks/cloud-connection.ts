/**
 * One connection to Failproof Cloud, with two capabilities.
 *
 * # Why this exists
 *
 * Enrolment (#632) and collection (#640) were built independently and each
 * arrived with its own credential file, its own URL and its own setup step:
 *
 *   pull policy   ->  ~/.failproofai/cloud.json    <base>/enforcement/v1/...
 *   push events   ->  ~/.failproofai/ingest.json   <base>/events
 *
 * Same server, same organisation, usually the same key. Asked twice, a user
 * who connects for policy sees an empty dashboard and reasonably concludes the
 * product is broken — the second setup step is invisible until someone goes
 * looking for it.
 *
 * So the URL and token are asked for ONCE and both capabilities are configured
 * from them. The two files stay separate on disk — that is a real security
 * boundary, since `cloud.json` and `ingest.json` can hold different keys with
 * different permissions, and the daemon reads them independently — but nothing
 * above this module has to know that.
 *
 * # Capabilities are verified and reported INDEPENDENTLY
 *
 * A key may carry `policies:pull` and not `events:add`, or the reverse. The
 * honest outcome is then a partial connection with a precise reason, not an
 * all-or-nothing failure: refusing to enrol for policy because the dashboard
 * would be empty protects nothing, and silently skipping ingest reproduces the
 * exact confusion this module removes.
 */
import {
  cloudCredentialPath,
  verifyCloudCredentials,
  writeCloudCredentials,
  type CloudCredentials,
} from "./cloud-enrollment";
import { updateConfig, readCredentials, writeCredentials } from "./fp-config";
import {
  introspectKey,
  hasPermission,
  describeOrg,
  PERMISSION_EVENTS,
  PERMISSION_POLICIES,
} from "./cloud-introspect";
import {
  ingestPath,
  validateIngestKey,
  writeCollectorSettings,
  writeIngestCredential,
  type CollectorSettings,
} from "./collector-config";

/**
 * The path ingest is served on, appended to the cloud base URL.
 *
 * `/v1/events` rather than `/events`, and the difference is load-bearing for
 * the hosted deployment. The server mounts its route list TWICE — flat at `/`
 * and nested under `/v1` — so both reach the same handler when you talk to the
 * server directly. But on the dashboard hostname a reverse proxy routes only
 * `/v1/*` and `/enforcement/v1/*` to the server and sends EVERYTHING ELSE to
 * the Next.js app. So `https://app.befailproof.ai/events` does not reach ingest
 * at all; it reaches a web app that will happily answer.
 *
 * `/v1/events` is therefore the only path that works on all three shapes: the
 * dashboard hostname, the server hostname, and a Compose deployment with no
 * proxy at all. That is what lets one `--connect <origin>` configure BOTH
 * capabilities from a single URL.
 */
export const INGEST_PATH = "/v1/events";

/**
 * The ingest endpoint for a cloud base URL.
 *
 * Ingest wants a COMPLETE endpoint while enrolment wants a base, which is the
 * whole reason two URLs were being asked for. One is derivable from the other,
 * so only the base is ever asked for.
 */
export function ingestUrlFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}${INGEST_PATH}`;
}

/**
 * The cloud base for whatever URL someone actually typed.
 *
 * Accepts either form. People paste the ingest endpoint — it is what the older
 * prompt asked for, and what any existing runbook or `ingest.json` contains —
 * and rejecting it as "not a base URL" would be pedantry about a URL we can
 * read perfectly well.
 */
export function cloudBaseFor(url: string): string {
  const trimmed = url.replace(/\/$/, "");
  // Strip either ingest path. People paste what an older setup asked for, what
  // is already in their config, or what a colleague sent them — and `/events`
  // was the documented value for the whole life of the product before `/v1`.
  // Refusing a URL we can read perfectly well is pedantry; silently treating
  // `https://host/events` as an ORIGIN would be worse, because every derived
  // URL would then carry a stray `/events` segment.
  for (const suffix of [INGEST_PATH, "/events"]) {
    if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length);
  }
  return trimmed;
}

export interface ConnectInput {
  /** Cloud base URL, already validated by `validateCloudUrl`. */
  url: string;
  token: string;
  machineId: string;
  /** Human-facing display name for this machine. Defaults to the hostname. */
  machineLabel?: string;
  /**
   * Send session transcripts.
   *
   * Both callers — the wizard and `--connect` — now pass `true` unless the
   * user opts out, because transcripts are what makes a dashboard worth
   * connecting to. This function itself still requires it EXPLICITLY and
   * treats `undefined` as off: a library that silently opts a caller into
   * shipping prompts and file contents is the wrong default at this layer,
   * whatever the product default above it happens to be.
   */
  sessions?: boolean;
  environment?: string;
  /** Injected by tests so nothing reaches the network. */
  verifyPolicy?: typeof verifyCloudCredentials;
  verifyIngest?: typeof validateIngestKey;
  introspect?: typeof introspectKey;
}

export interface CapabilityOutcome {
  ok: boolean;
  reason?: string;
}

export interface ConnectOutcome {
  policy: CapabilityOutcome & { policyCount?: number; generation?: number };
  ingest: CapabilityOutcome;
  /** Which organisation the key belongs to. Absent on a pre-introspect server. */
  org?: { id?: string; slug?: string; name?: string };
  /** True when at least one capability was configured. */
  anyConfigured: boolean;
}

/**
 * Verify both capabilities, then write only what actually works.
 *
 * Verification happens BEFORE any write, per capability. A credential file that
 * does not work is worse than none, because `--status` then reports a
 * connection the machine does not have.
 */
export async function connectToCloud(input: ConnectInput): Promise<ConnectOutcome> {
  const creds: CloudCredentials = {
    url: input.url,
    machineId: input.machineId,
    token: input.token,
    machineLabel: input.machineLabel,
  };

  const verifyPolicy = input.verifyPolicy ?? verifyCloudCredentials;
  const verifyIngest = input.verifyIngest ?? validateIngestKey;
  const introspect = input.introspect ?? introspectKey;
  const ingestUrl = ingestUrlFor(input.url);

  // ── Ask the key what it is, before using it for anything ──────────────────
  //
  // One request answers three questions that are otherwise indistinguishable
  // until much later: is the key accepted, which ORG does it report into, and
  // does it carry the permissions this machine needs. Probing the endpoints
  // (below) can only ever answer the first, and only by inference.
  //
  // A rejected key stops here — probing two more endpoints with a credential
  // the server has already refused tells us nothing and costs two more
  // unauthenticated database lookups on a surface with no rate limiting.
  const identity = await introspect(input.url, input.token);
  if (identity.kind === "rejected") {
    return {
      policy: { ok: false, reason: "the server did not accept that key" },
      ingest: { ok: false, reason: "the server did not accept that key" },
      anyConfigured: false,
    };
  }

  // `unsupported` — an AgentEye older than the introspect endpoint. Fall
  // through to probing, which is what every release before this one did. The
  // CLI ships independently of whatever server a customer runs, so a good key
  // on an older deployment must still connect.
  const known = identity.kind === "ok" ? identity.identity : null;

  // Skip a probe the key provably cannot pass. This is not an optimisation: a
  // permission failure surfaces from `/events` as a 403 whose message reads
  // like a server problem, where introspect can say exactly which permission is
  // missing and for which org.
  const canIngest = known ? hasPermission(known, PERMISSION_EVENTS) : true;
  const canPolicy = known ? hasPermission(known, PERMISSION_POLICIES) : true;

  const missing = (permission: string) =>
    `that key does not carry \`${permission}\`` +
    (known ? ` (it is valid for ${describeOrg(known)})` : "");

  // Both checks run regardless of the other's result: reporting "cannot pull
  // policy" while staying silent about ingest would send someone to fix one
  // permission and hit the next one afterwards.
  const [policyResult, ingestResult] = await Promise.all([
    canPolicy
      ? verifyPolicy(creds)
      : Promise.resolve({ ok: false as const, reason: missing(PERMISSION_POLICIES) }),
    canIngest
      ? verifyIngest({ url: ingestUrl, key: input.token })
      : Promise.resolve({ ok: false as const, reason: missing(PERMISSION_EVENTS) }),
  ]);

  const outcome: ConnectOutcome = {
    policy: policyResult.ok
      ? { ok: true, policyCount: policyResult.policyCount, generation: policyResult.generation }
      : { ok: false, reason: policyResult.reason },
    ingest: ingestResult.ok ? { ok: true } : { ok: false, reason: ingestResult.reason },
    anyConfigured: false,
    org: known
      ? { id: known.orgId, slug: known.orgSlug, name: known.orgName }
      : undefined,
  };

  if (policyResult.ok) {
writeCloudCredentials(creds);
    outcome.anyConfigured = true;
  }

  // Mode is the hard gate, set only once a capability actually verified.
  // "cloud" is never inferred from a token merely being present: a machine
  // that has not proven it can reach the server must stay provably silent.
  if (policyResult.ok || ingestResult.ok) {
    updateConfig({ mode: "cloud" });
  }

  if (ingestResult.ok) {
    writeIngestCredential({ url: ingestUrl, key: input.token });
    const settings: CollectorSettings = {
      // Hook activity is what makes the dashboard show anything at all, and it
      // carries decisions and tool names — never file contents.
      hooks: true,
      // Explicit only — see the `sessions` doc on ConnectInput. Callers decide
      // the product default; this layer never infers one.
      sessions: input.sessions === true,
      environment: input.environment,
      // So the daemon stamps this machine's id on every collected event and the
      // dashboard groups by machine, not by per-project agent_id.
      machineId: input.machineId,
    };
    writeCollectorSettings(settings);
    outcome.anyConfigured = true;
  }

  // Last, and only once something actually configured: recording an org for a
  // machine that connected to nothing would be a claim about where data goes
  // from a machine that sends none. Merged into whatever the two writers above
  // just wrote, so it cannot race them.
  if (outcome.anyConfigured && known && (known.orgId || known.orgSlug || known.orgName)) {
    writeCredentials({
      ...readCredentials(),
      org: { id: known.orgId, slug: known.orgSlug, name: known.orgName },
    });
  }

  return outcome;
}

/**
 * How to describe the outcome to someone at a terminal.
 *
 * The partial cases are the ones worth wording carefully: each names the
 * missing permission, because "connected, but the dashboard will stay empty"
 * without a cause is the message that sends people to support.
 */
export function describeOutcome(outcome: ConnectOutcome, machineId: string, url: string): string[] {
  const lines: string[] = [];

  // Named on every branch that connected, including the partial ones. A key
  // pasted from the wrong organisation authenticates perfectly and reports into
  // somewhere the user is not looking; the org is the only thing on screen that
  // makes that visible, and it is worth nothing if it only prints on success.
  const org = outcome.org
    ? outcome.org.name && outcome.org.slug
      ? `${outcome.org.name} (${outcome.org.slug})`
      : (outcome.org.name ?? outcome.org.slug ?? outcome.org.id)
    : undefined;
  const into = org ? ` into ${org}` : "";

  if (outcome.policy.ok && outcome.ingest.ok) {
    lines.push(`Connected to ${url} as ${machineId}${into}.`);
    const n = outcome.policy.policyCount ?? 0;
    lines.push(`  Policy    ${n} polic${n === 1 ? "y" : "ies"} assigned (generation ${outcome.policy.generation ?? 0}).`);
    lines.push(`  Dashboard hook activity will be sent to ${ingestUrlFor(url)}.`);
    return lines;
  }

  if (outcome.policy.ok && !outcome.ingest.ok) {
    const n = outcome.policy.policyCount ?? 0;
    lines.push(`Connected to ${url} as ${machineId}${into}, for policy only.`);
    lines.push(`  Policy    ${n} polic${n === 1 ? "y" : "ies"} assigned (generation ${outcome.policy.generation ?? 0}).`);
    lines.push(`  Dashboard NOT configured: ${outcome.ingest.reason}`);
    lines.push("");
    lines.push("  Enforcement works. Nothing will appear in the dashboard until this");
    lines.push("  key also carries `events:add`, or you re-run --connect with one that does.");
    return lines;
  }

  if (!outcome.policy.ok && outcome.ingest.ok) {
    lines.push(`Connected to ${url} as ${machineId}${into}, for dashboard reporting only.`);
    lines.push(`  Dashboard hook activity will be sent to ${ingestUrlFor(url)}.`);
    lines.push(`  Cloud policy NOT configured: ${outcome.policy.reason}`);
    lines.push("");
    lines.push("  This machine keeps enforcing its LOCAL policies and will report what");
    lines.push("  they decide, but will not receive centrally-managed ones.");
    return lines;
  }

  lines.push(`Could not connect to ${url}.`);
  lines.push(`  Policy:    ${outcome.policy.reason}`);
  lines.push(`  Dashboard: ${outcome.ingest.reason}`);
  return lines;
}

/** Paths written, for a closing note. Only those that exist. */
export function configuredPaths(outcome: ConnectOutcome): string[] {
  const paths: string[] = [];
  if (outcome.policy.ok) paths.push(cloudCredentialPath());
  if (outcome.ingest.ok) paths.push(ingestPath());
  // Deduplicated because layout 2 consolidated both credentials into
  // `credentials.toml`, so the two capabilities now name the SAME file and the
  // closing note read "stored in <path> and <path>" — the same path, twice.
  // They stay two entries above because the JSON override can still split them.
  return [...new Set(paths)];
}
