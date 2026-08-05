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
import { updateConfig } from "./fp-config";
import {
  ingestPath,
  validateIngestKey,
  writeCollectorSettings,
  writeIngestCredential,
  type CollectorSettings,
} from "./collector-config";

/** The path ingest is served on, appended to the cloud base URL. */
export const INGEST_PATH = "/events";

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
  return trimmed.endsWith(INGEST_PATH) ? trimmed.slice(0, -INGEST_PATH.length) : trimmed;
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
}

export interface CapabilityOutcome {
  ok: boolean;
  reason?: string;
}

export interface ConnectOutcome {
  policy: CapabilityOutcome & { policyCount?: number; generation?: number };
  ingest: CapabilityOutcome;
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
  const ingestUrl = ingestUrlFor(input.url);

  // Both checks run regardless of the other's result: reporting "cannot pull
  // policy" while staying silent about ingest would send someone to fix one
  // permission and hit the next one afterwards.
  const [policyResult, ingestResult] = await Promise.all([
    verifyPolicy(creds),
    verifyIngest({ url: ingestUrl, key: input.token }),
  ]);

  const outcome: ConnectOutcome = {
    policy: policyResult.ok
      ? { ok: true, policyCount: policyResult.policyCount, generation: policyResult.generation }
      : { ok: false, reason: policyResult.reason },
    ingest: ingestResult.ok ? { ok: true } : { ok: false, reason: ingestResult.reason },
    anyConfigured: false,
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

  if (outcome.policy.ok && outcome.ingest.ok) {
    lines.push(`Connected to ${url} as ${machineId}.`);
    const n = outcome.policy.policyCount ?? 0;
    lines.push(`  Policy    ${n} polic${n === 1 ? "y" : "ies"} assigned (generation ${outcome.policy.generation ?? 0}).`);
    lines.push(`  Dashboard hook activity will be sent to ${ingestUrlFor(url)}.`);
    return lines;
  }

  if (outcome.policy.ok && !outcome.ingest.ok) {
    const n = outcome.policy.policyCount ?? 0;
    lines.push(`Connected to ${url} as ${machineId} for policy only.`);
    lines.push(`  Policy    ${n} polic${n === 1 ? "y" : "ies"} assigned (generation ${outcome.policy.generation ?? 0}).`);
    lines.push(`  Dashboard NOT configured: ${outcome.ingest.reason}`);
    lines.push("");
    lines.push("  Enforcement works. Nothing will appear in the dashboard until this");
    lines.push("  key also carries `events:add`, or you re-run --connect with one that does.");
    return lines;
  }

  if (!outcome.policy.ok && outcome.ingest.ok) {
    lines.push(`Connected to ${url} as ${machineId} for dashboard reporting only.`);
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
  return paths;
}
