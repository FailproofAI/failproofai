/**
 * `failproofai config --status`: what this machine is doing, on one screen.
 *
 *   THIS MACHINE   the daemon, the local dashboard, and any paused sessions
 *   CLOUD          where this machine's data goes, and whether it arrives
 *   ENFORCEMENT    which agents are traced, which policies are on, and what
 *                  they blocked or warned about today
 *
 * Then at most ONE line that needs attention, the most severe thing wrong with
 * its fix. Everything a reader could need to act on also stays in a row, so a
 * problem that loses the attention line to a worse one is still on screen.
 *
 * Split in two on purpose. `gatherStatusFacts` reads the machine, and is the
 * only part that touches disk, the service manager or a socket.
 * `renderStatusScreen` turns those facts into lines and is pure, so every row
 * and every priority between problems can be pinned without a daemon, a
 * terminal or a clock.
 *
 * The top-level names here are deliberately long. The CLI ships as one
 * scope-hoisted bundle, and a short one (`cmd`, `row`, `state`, …) that matches
 * a local inside a builtin policy or an audit detector makes the bundler rename
 * that local. That changes the source the audit cache keys on, and every user's
 * history is rescanned at upgrade.
 */
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { resolveDashboardHost } from "../../lib/dashboard-host";
import { readCloudCredentials } from "./cloud-enrollment";
import { describeMachine } from "./cloud-enrollment-cli";
import { cloudBaseFor } from "./cloud-connection";
import { readActiveCloudManagedPolicies } from "./cloud-managed-policies";
import { readIngestCredential } from "./collector-config";
import { discoverPolicyFiles } from "./custom-hooks-loader";
import { daemonSocketPresent, isDaemonConfigured } from "./daemon-client";
import {
  daemonServiceStatus,
  daemonStatusCommand,
  daemonVersionSkew,
  isDaemonSupportedPlatform,
  type DaemonServiceStatus,
} from "./daemon-service";
import { deliveryHealth, type DeliveryHealth } from "./delivery-health";
import { spoolBacklog } from "./flush-cli";
import { isAgentTraced, readConfig, readCredentials, readVersionFile } from "./fp-config";
import { collectorHealthFile, customPoliciesDir } from "./fp-home";
import { getHookActivityEntriesSince } from "./hook-activity-store";
import { configuredCustomPolicyPaths, findProjectConfigDir, readMergedHooksConfig } from "./hooks-config";
import { detectInstalledClis, hermesProfileStatusRows, listInstallableIds } from "./integrations";
import { notEnforcingReason, type NotEnforcingReason } from "./manager";
import { hasInstalledRegexPacks, readInstalledPacks } from "./pack-manifest";
import { CORE_SOURCE } from "./pack-store";
import { formatDuration, listActivePauses } from "./session-pause";
import { pauseClockTime, type PauseClock } from "./session-pause-cli";
import { optsFor, screenKit, type ScreenKitOpts, type TTYOut } from "./tui";
import type { IntegrationType } from "./types";

/** Where `failproofai` (no arguments) serves the dashboard unless told otherwise. */
export const STATUS_DASHBOARD_PORT = 8020;
/** The dashboard probe's whole budget. A status command must not hang on it. */
export const STATUS_PROBE_TIMEOUT_MS = 150;
/**
 * A health record older than this was left by a daemon that stopped writing it.
 * The daemon rewrites it every 30 s and deletes it on a clean shutdown, so four
 * missed beats is a daemon that died or hung, not one between writes.
 */
export const STATUS_HEALTH_STALE_MS = 2 * 60_000;
/**
 * A queued batch this old, with nothing delivered for as long, is stuck. The
 * collector sweeps a batch once it is two minutes old, every minute, so a
 * quarter of an hour is several passes that delivered nothing.
 */
export const STATUS_QUEUE_STUCK_MS = 15 * 60_000;

/** What `collector-health.json` says, in the units this side uses. */
export interface StatusCollectorHealth {
  /** When the daemon last rewrote the record, epoch ms. */
  writtenAt: number;
  /** The newest event any source produced since the daemon started, epoch ms. */
  lastEventAt?: number;
  /** The last upload the cloud accepted since the daemon started, epoch ms. */
  lastOkAt?: number;
  /** False when the record has no delivery block: the daemon holds no key. */
  delivering: boolean;
}

export type StatusCloud =
  | { kind: "none" }
  /** FAILPROOFAI_CLOUD_URL is set; it wins over the credential file in the daemon. */
  | { kind: "env"; url: string }
  | {
      kind: "file";
      host: string;
      /** The org as the server named it at connect time, when it did. */
      org?: string;
      machine?: string;
      pullsPolicies: boolean;
      sendsEvents: boolean;
    };

/** Where the policies on this machine come from, counted. */
export interface StatusPolicies {
  /** Policies switched on in enforcing packs. */
  packOn: number;
  /** `id@version` of the first enforcing pack with a policy on. */
  firstPack?: string;
  /** Other enforcing packs with a policy on. */
  morePacks: number;
  /** Enforcing cloud-managed policies. */
  cloudOn: number;
  /** Policies on in observe mode, packs and cloud alike: they log, never decide. */
  observing: number;
  /** Configured custom policy files plus convention files on disk. */
  customFiles: number;
  /** Builtins still run by the pre-pack migration shim. */
  legacy: number;
  /**
   * Enforcing packs that will not load. They fail CLOSED — every tool call
   * their policies cover is denied — so they are counted apart from "on", and
   * a machine holding one is never called "not enforcing".
   */
  refusedPacks: number;
  packsInstalled: number;
  /** `id@version` of the first installed pack, on or not. */
  anyPack?: string;
}

export interface StatusFacts {
  now: number;
  daemon: {
    supported: boolean;
    platform: string;
    service: DaemonServiceStatus;
    /** A daemon socket exists, so something answers hooks whatever the service manager says. */
    answering: boolean;
    /** `failproofai config` set this machine up to evaluate through the daemon only. */
    configured: boolean;
    /** The daemon version recorded at install. */
    version?: string;
    skew: { installed: string; expected: string } | null;
    checkCommand: string | null;
  };
  dashboard: { url: string; listening: boolean };
  pauses: Array<{ sessionId: string; expiresAt: number; cwd?: string }>;
  cloud: StatusCloud;
  /** Absent when nothing is connected. */
  delivery?: {
    health: StatusCollectorHealth | null;
    refused: DeliveryHealth;
    queued: number;
    oldestQueuedMs?: number;
  };
  /** notTraced: found on this machine and left out of the selection. */
  agents: { traced: number; notTraced?: number; notInstalled: number };
  policies: StatusPolicies;
  today: { blocked: number; warned: number };
  /** Hermes profiles that are not healthy, with what is wrong. Healthy ones are omitted. */
  hermes: Array<{ profile: string; problem: string }>;
  notEnforcing: NotEnforcingReason | null;
}

/** Seams for everything that would otherwise reach a service manager, PATH or the network. */
export interface StatusDeps {
  now?: number;
  cwd?: string;
  daemonStatus?: () => DaemonServiceStatus;
  daemonAnswering?: () => boolean;
  detectInstalled?: () => IntegrationType[];
  probeDashboard?: (host: string, port: number) => Promise<boolean>;
  hermesRows?: () => Array<[string, string]>;
  notEnforcing?: (cwd?: string) => NotEnforcingReason | null;
}

/**
 * `collector-health.json`, or null when there is none or it cannot be read.
 *
 * The daemon writes it (`crates/fpai-collect/src/health.rs`) and, until this,
 * nothing on this side read it. Timestamps there are Unix SECONDS, and zero
 * means "none since the daemon started", so zero is read as absent rather than
 * as 1970. Never throws: a status command that crashes on a half-written file
 * describes nothing.
 */
export function readCollectorHealth(file: string = collectorHealthFile()): StatusCollectorHealth | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const ms = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
  const writtenAt = ms(record.ts);
  if (writtenAt === undefined) return null;

  let lastEventAt: number | undefined;
  if (record.sources && typeof record.sources === "object") {
    for (const source of Object.values(record.sources as Record<string, unknown>)) {
      const at = source && typeof source === "object" ? ms((source as Record<string, unknown>).last_event_ts) : undefined;
      if (at !== undefined && (lastEventAt === undefined || at > lastEventAt)) lastEventAt = at;
    }
  }
  const delivery =
    record.delivery && typeof record.delivery === "object" ? (record.delivery as Record<string, unknown>) : undefined;
  const lastOkAt = delivery ? ms(delivery.last_ok_ts) : undefined;
  return {
    writtenAt,
    delivering: delivery !== undefined,
    ...(lastEventAt !== undefined ? { lastEventAt } : {}),
    ...(lastOkAt !== undefined ? { lastOkAt } : {}),
  };
}

/**
 * Whether anything accepts a TCP connection at `host:port`, within the budget.
 *
 * Nothing records that the dashboard is running — it runs in the foreground with
 * no pid file — so the only honest answer is to knock. Connect only: nothing is
 * sent, so a stranger listening on the port learns nothing from it.
 */
export function probeDashboardListening(
  host: string,
  port: number,
  timeoutMs: number = STATUS_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((done) => {
    let settled = false;
    const socket = createConnection({ host, port });
    const finish = (up: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(up);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Local midnight of the day `now` falls in — where "today" starts for a reader. */
export function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Tool calls blocked (`deny`) and warned about (`instruct`) since `sinceMs`.
 *
 * Read through the store the dashboard's activity tab reads, with its windowed
 * reader, so a long-lived machine pays for today's pages and not its history.
 * Observe-mode verdicts are not counted: they decided nothing.
 */
export function countDecisionsSince(sinceMs: number): { blocked: number; warned: number } {
  let blocked = 0;
  let warned = 0;
  try {
    for (const entry of getHookActivityEntriesSince(sinceMs)) {
      if (entry.decision === "deny") blocked++;
      else if (entry.decision === "instruct") warned++;
    }
  } catch {
    // An unreadable store is no activity, not a failed status command.
  }
  return { blocked, warned };
}

/**
 * Count where this machine's policies come from.
 *
 * The same sources, read the same way, as `notEnforcingReason` — installed
 * packs minus what was switched off, cloud-managed policies, custom and
 * convention files (counted, never imported), and the legacy shim — so the
 * policies row and the "not enforcing" line can never disagree.
 */
export function summarizePolicySources(cwd?: string): StatusPolicies {
  const summary: StatusPolicies = {
    packOn: 0,
    morePacks: 0,
    cloudOn: 0,
    observing: 0,
    customFiles: 0,
    legacy: 0,
    refusedPacks: 0,
    packsInstalled: 0,
  };
  let config: ReturnType<typeof readMergedHooksConfig>;
  try {
    config = readMergedHooksConfig(cwd);
  } catch {
    config = { enabledPolicies: [] };
  }
  const disabled = new Set(config.disabledCustomPolicies ?? []);

  try {
    const { packs, errors } = readInstalledPacks();
    // The refusals that deny, as `failproofai policies` counts them: an observe
    // pack or a Jev-checks-only one has nothing to fail closed on.
    summary.refusedPacks = errors.filter((err) => err.effect !== "observe" && !err.semanticOnly).length;
    summary.packsInstalled = packs.length;
    if (packs[0]) summary.anyPack = `${packs[0].id}@${packs[0].version}`;
    let enforcing = 0;
    for (const pack of packs) {
      const taken = pack.enabled ?? pack.policies.map((policy) => policy.name);
      const on = taken.filter((name) => !disabled.has(`pack:${pack.id}@${pack.version}:${name}`)).length;
      if (on === 0) continue;
      if (pack.effect === "observe") {
        summary.observing += on;
        continue;
      }
      if (enforcing === 0) summary.firstPack = `${pack.id}@${pack.version}`;
      summary.packOn += on;
      enforcing++;
    }
    summary.morePacks = Math.max(0, enforcing - 1);
  } catch {
    // An unreadable manifest is reported by `failproofai policies`.
  }

  try {
    for (const artifact of readActiveCloudManagedPolicies()) {
      if (artifact.effect === "observe") summary.observing++;
      else summary.cloudOn++;
    }
  } catch {
    // No deployment, or an unreadable one: nothing comes from there.
  }

  // Deduplicated by path: run from the home directory, the project's convention
  // folder IS the global one.
  const projectDir = resolve(findProjectConfigDir(cwd ?? process.cwd()), ".failproofai", "policies");
  const conventionFiles = new Set([...discoverPolicyFiles(projectDir), ...discoverPolicyFiles(customPoliciesDir())]);
  summary.customFiles = configuredCustomPolicyPaths(config).length + conventionFiles.size;

  if (config.enabledPolicies.length > 0 && !hasInstalledRegexPacks()) summary.legacy = config.enabledPolicies.length;
  return summary;
}

/** Read everything the status screen shows. The only part of it that touches the machine. */
export async function gatherStatusFacts(deps: StatusDeps = {}): Promise<StatusFacts> {
  const now = deps.now ?? Date.now();
  const cwd = deps.cwd ?? process.cwd();

  // Started first and awaited last: the probe is the one read that waits, and
  // everything else here is a file. A wildcard bind is reached on loopback.
  const bind = resolveDashboardHost(undefined, process.env.FAILPROOFAI_DASHBOARD_HOST).replace(/^\[(.*)\]$/, "$1");
  const probeHost = bind === "0.0.0.0" ? "127.0.0.1" : bind === "::" ? "::1" : bind;
  const dashboardUrl = `http://${probeHost.includes(":") ? `[${probeHost}]` : probeHost}:${STATUS_DASHBOARD_PORT}`;
  const listening = (deps.probeDashboard ?? probeDashboardListening)(probeHost, STATUS_DASHBOARD_PORT).catch(() => false);

  const daemon: StatusFacts["daemon"] = {
    supported: isDaemonSupportedPlatform(),
    platform: process.platform,
    service: (deps.daemonStatus ?? daemonServiceStatus)(),
    answering: (deps.daemonAnswering ?? daemonSocketPresent)(),
    configured: isDaemonConfigured(),
    version: readVersionFile()?.daemon,
    skew: daemonVersionSkew(),
    checkCommand: daemonStatusCommand(),
  };

  let cloud: StatusCloud = { kind: "none" };
  const envUrl = process.env.FAILPROOFAI_CLOUD_URL;
  if (envUrl) {
    // The daemon takes the environment over the file, so the file's org and
    // machine may describe a connection that is not the one in effect.
    cloud = { kind: "env", url: envUrl };
  } else {
    const creds = readCloudCredentials();
    const ingest = readIngestCredential();
    if (creds || ingest) {
      const org = readCredentials().org;
      const orgName = org
        ? org.name && org.slug && org.name !== org.slug
          ? `${org.name} (${org.slug})`
          : (org.name ?? org.slug ?? org.id)
        : undefined;
      const base = creds?.url ?? cloudBaseFor(ingest!.url);
      let host = base;
      try {
        host = new URL(base).host || base;
      } catch {
        // Not a URL we can parse: show it as written.
      }
      const machineId = creds?.machineId ?? readConfig().collector.machineId;
      cloud = {
        kind: "file",
        host,
        ...(orgName ? { org: orgName } : {}),
        ...(machineId ? { machine: describeMachine(machineId, creds?.machineLabel) } : {}),
        pullsPolicies: Boolean(creds),
        sendsEvents: Boolean(ingest),
      };
    }
  }

  let delivery: StatusFacts["delivery"];
  if (cloud.kind !== "none") {
    const backlog = spoolBacklog(undefined, now);
    delivery = {
      health: readCollectorHealth(),
      refused: deliveryHealth(undefined, now),
      queued: backlog.count,
      ...(backlog.oldestAgeMs !== undefined ? { oldestQueuedMs: backlog.oldestAgeMs } : {}),
    };
  }

  const config = readConfig();
  const known = listInstallableIds();
  let detected: Set<string>;
  try {
    detected = new Set((deps.detectInstalled ?? detectInstalledClis)());
  } catch {
    detected = new Set();
  }

  // hermesProfileStatusRows keeps its own wording for each problem, and its
  // rows are pinned by its own tests; only the unhealthy ones are shown here.
  const unhealthy = "UNHEALTHY — ";
  let hermes: StatusFacts["hermes"] = [];
  try {
    hermes = (deps.hermesRows ?? hermesProfileStatusRows)()
      .filter(([, value]) => value.startsWith(unhealthy))
      .map(([label, value]) => ({ profile: label.replace(/^hermes\//, ""), problem: value.slice(unhealthy.length) }));
  } catch {
    // Hermes config unreadable as a whole: its own commands report that.
  }

  let notEnforcing: NotEnforcingReason | null = null;
  try {
    notEnforcing = (deps.notEnforcing ?? notEnforcingReason)(cwd);
  } catch {
    notEnforcing = null;
  }

  return {
    now,
    daemon,
    dashboard: { url: dashboardUrl, listening: await listening },
    pauses: listActivePauses(now).map((pause) => ({
      sessionId: pause.sessionId,
      expiresAt: pause.expiresAt,
      ...(pause.cwd ? { cwd: pause.cwd } : {}),
    })),
    cloud,
    ...(delivery ? { delivery } : {}),
    agents: {
      traced: known.filter((id) => isAgentTraced(id, config)).length,
      notTraced: known.filter((id) => detected.has(id) && !isAgentTraced(id, config)).length,
      notInstalled: known.filter((id) => !detected.has(id)).length,
    },
    policies: summarizePolicySources(cwd),
    today: countDecisionsSince(startOfLocalDay(now)),
    hermes,
    notEnforcing,
  };
}

/** The one line that needs attention, before it is painted. */
export interface StatusAttention {
  severity: "fail" | "caution";
  text: string;
  fix?: string;
}

/**
 * The most severe thing wrong, or null.
 *
 * Ordered by what it costs the user: tool calls being denied (all of them, then
 * the ones a refused pack covers), then data refused outright, then enforcement
 * that is not happening (the whole machine, then one Hermes profile), then the
 * cloud connection standing idle, then refusals that lose some batches, then a
 * daemon older or newer than this CLI.
 */
export function pickStatusAttention(facts: StatusFacts): StatusAttention | null {
  const { daemon, cloud, delivery, policies } = facts;
  if (daemon.configured && !daemon.answering) {
    return { severity: "fail", text: "failproofaid is not answering, so every tool call is denied.", fix: "failproofai config" };
  }
  if (policies.refusedPacks > 0) {
    return {
      severity: "fail",
      text:
        policies.refusedPacks === 1
          ? "A pack will not load, so the tool calls it covers are denied."
          : `${policies.refusedPacks} packs will not load, so the tool calls they cover are denied.`,
      fix: "failproofai policies",
    };
  }
  if (delivery && delivery.refused.credentialRejected > 0) {
    return {
      severity: "fail",
      text: "The cloud is refusing this machine's key, so nothing reaches the dashboard.",
      fix: "failproofai config",
    };
  }
  if (facts.notEnforcing) {
    const fix =
      facts.notEnforcing === "no-hooks"
        ? "failproofai config"
        : facts.notEnforcing === "observe-only"
          ? "failproofai policies"
          : policies.packsInstalled > 0
            ? "failproofai policies add"
            : `failproofai policies add ${CORE_SOURCE}`;
    return { severity: "caution", text: "Policies are not enforcing yet.", fix };
  }
  if (facts.hermes.length > 0) {
    return {
      severity: "caution",
      text:
        facts.hermes.length === 1
          ? `Hermes profile ${facts.hermes[0].profile} is unhealthy.`
          : `${facts.hermes.length} Hermes profiles are unhealthy.`,
      fix: "failproofai update",
    };
  }
  if (cloud.kind !== "none" && !daemon.answering && daemon.service !== "running") {
    const idle =
      cloud.kind === "file" && !cloud.sendsEvents
        ? "no cloud policy is pulled"
        : cloud.kind === "file" && !cloud.pullsPolicies
          ? "nothing is delivered"
          : "nothing is pulled or delivered";
    if (!daemon.supported) return { severity: "caution", text: `failproofaid does not run on this platform, so ${idle}.` };
    if (daemon.service === "unknown") {
      return {
        severity: "caution",
        text: `No daemon is answering, so ${idle}.`,
        ...(daemon.checkCommand ? { fix: daemon.checkCommand } : {}),
      };
    }
    return {
      severity: "caution",
      text: `failproofaid is ${daemon.service === "not-installed" ? "not installed" : "not running"}, so ${idle}.`,
      fix: "failproofai config",
    };
  }
  if (delivery && delivery.refused.rejected > 0) {
    const n = delivery.refused.rejected;
    const codes = Object.keys(delivery.refused.byStatus).map(Number).sort((a, b) => a - b).join("/");
    return {
      severity: "caution",
      text: `The cloud refused ${n} batch${n === 1 ? "" : "es"} (${codes}); they are not retried.`,
    };
  }
  if (daemon.skew) {
    return {
      severity: "caution",
      text: `failproofaid ${daemon.skew.installed} does not match this CLI (${daemon.skew.expected}).`,
      fix: "failproofai update",
    };
  }
  return null;
}

/**
 * The screen, as lines without outer margins (`printBlock` adds those).
 *
 * Every kv row of every section goes through ONE `kv` call, so the three
 * sections share a value column derived from the widest label rather than each
 * computing its own. Values are never cut: they are ids, URLs and counts.
 */
export function renderStatusScreen(facts: StatusFacts, opts: ScreenKitOpts & { clock?: PauseClock } = {}): string[] {
  const kit = screenKit(opts);
  const { now, daemon, cloud, delivery, policies, agents } = facts;
  const ago = (at: number) => `${formatDuration(Math.max(0, now - at))} ago`;
  const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;

  const daemonValue = (): string => {
    if (!daemon.supported) return `${kit.off} Not supported on ${daemon.platform}`;
    if (daemon.service === "running") {
      // The mismatch stays on the row, not only in the attention line: a worse
      // problem can take that line, and this one still needs `failproofai update`.
      const skew = daemon.skew ? `, this CLI is ${daemon.skew.expected}` : "";
      return `${kit.on} Running failproofaid${daemon.version ? ` ${daemon.version}` : ""}${skew}`;
    }
    if (daemon.service === "unknown") {
      return daemon.answering
        ? `${kit.on} Answering, its service state needs root to read`
        : `${kit.off} Not answering, its service state needs root to read`;
    }
    if (daemon.answering) return `${kit.on} Running outside the service manager`;
    if (daemon.service === "stopped") return `${kit.off} Installed, not running`;
    if (daemon.service === "condition-failed") return `${kit.off} Installed, will not start: its binary or worker is missing`;
    return `${kit.off} Not installed`;
  };

  const deliveryValue = (): string => {
    if (!delivery) return `${kit.off} Not sending`;
    if (cloud.kind === "file" && !cloud.sendsEvents) return `${kit.off} Not sending, connected for policy only`;
    const { refused, health, queued, oldestQueuedMs } = delivery;
    if (refused.rejected > 0) {
      const codes = Object.keys(refused.byStatus).map(Number).sort((a, b) => a - b).join("/");
      const oldest = refused.oldestAgeMs !== undefined ? `, oldest ${formatDuration(refused.oldestAgeMs)}` : "";
      return kit.caution(`${many(refused.rejected, "batch", "batches")} refused (${codes})${oldest}`);
    }
    if (!health) return `${kit.off} No report from failproofaid yet`;
    if (now - health.writtenAt > STATUS_HEALTH_STALE_MS) {
      return kit.caution(`No report from failproofaid for ${formatDuration(now - health.writtenAt)}`);
    }
    if (!health.delivering) return `${kit.off} Not delivering, failproofaid has no key`;
    const backlog = queued === 0 ? "nothing queued" : `${many(queued, "batch", "batches")} queued`;
    const stuck =
      queued > 0 &&
      (oldestQueuedMs ?? 0) > STATUS_QUEUE_STUCK_MS &&
      (health.lastOkAt === undefined || now - health.lastOkAt > STATUS_QUEUE_STUCK_MS);
    if (stuck) {
      const last = health.lastOkAt !== undefined ? `last delivered ${ago(health.lastOkAt)}` : "nothing delivered since failproofaid started";
      return kit.caution(`${many(queued, "batch", "batches")} queued, oldest ${formatDuration(oldestQueuedMs ?? 0)}, ${last}`);
    }
    const lastEvent = health.lastEventAt !== undefined ? `last event ${ago(health.lastEventAt)}` : "no events since failproofaid started";
    return `${kit.on} Healthy, ${lastEvent}, ${backlog}`;
  };

  const policiesValue = (): string => {
    const clauses: string[] = [];
    if (policies.packOn > 0) {
      const more = policies.morePacks > 0 ? ` and ${many(policies.morePacks, "more pack")}` : "";
      clauses.push(`${policies.packOn} on from ${policies.firstPack}${more}`);
    }
    if (policies.cloudOn > 0) clauses.push(`${policies.cloudOn} ${clauses.length > 0 ? "" : "on "}from cloud`);
    if (policies.legacy > 0) clauses.push(`${policies.legacy} ${clauses.length > 0 ? "" : "on from "}legacy builtins`);
    if (policies.customFiles > 0) {
      clauses.push(`${clauses.length > 0 ? "custom" : "Custom"} policies from ${many(policies.customFiles, "file")}`);
    }
    if (policies.observing > 0) clauses.push(`${policies.observing} observing`);
    if (policies.refusedPacks > 0) clauses.push(`${many(policies.refusedPacks, "pack")} will not load`);
    if (clauses.length > 0) return clauses.join(", ");
    return policies.anyPack ? `0 on from ${policies.anyPack}` : "None installed";
  };

  const machineRows: Array<[string, string]> = [
    ["daemon", daemonValue()],
    ["dashboard", facts.dashboard.listening ? `${kit.on} ${kit.cmd(facts.dashboard.url)}` : `${kit.off} Not running`],
    ["paused", facts.pauses.length === 0 ? "No" : many(facts.pauses.length, "session")],
    // One row per pause, under the value column: the id is what
    // `--resume --session <id>` needs, so it is never folded into a count.
    ...facts.pauses.map((pause): [string, string] => [
      "",
      `${pause.sessionId}  ${formatDuration(Math.max(0, pause.expiresAt - now))} left, until ` +
        `${pauseClockTime(pause.expiresAt, opts.clock)}${pause.cwd ? `${kit.sep}${pause.cwd}` : ""}`,
    ]),
    // An enforcement fact, not fine print: a pause suspends local policy only.
    ...(facts.pauses.length > 0 ? [["", "Cloud-managed policies keep enforcing."] as [string, string]] : []),
  ];

  const cloudRows: Array<[string, string]> =
    cloud.kind === "none"
      ? [["account", `Not connected${kit.sep}${kit.cmd("failproofai config")}`]]
      : cloud.kind === "env"
        ? [
            ["account", `Set by FAILPROOFAI_CLOUD_URL to ${cloud.url}`],
            ["delivery", deliveryValue()],
          ]
        : [
            [
              "account",
              `${cloud.org ? `${cloud.org} on ${cloud.host}` : `Connected to ${cloud.host}`}` +
                `${cloud.pullsPolicies ? "" : ", for reporting only"}`,
            ],
            ...(cloud.machine ? [["machine", cloud.machine] as [string, string]] : []),
            ["delivery", deliveryValue()],
          ];

  const enforcementRows: Array<[string, string]> = [
    [
      "agents",
      `${agents.traced} traced` +
        (agents.notTraced ? `, ${agents.notTraced} not traced` : "") +
        (agents.notInstalled > 0 ? `, ${agents.notInstalled} not installed` : ""),
    ],
    ["policies", policiesValue()],
    ["today", `${facts.today.blocked} blocked, ${facts.today.warned} warned`],
    // The problem keeps hermesProfileStatusRows' own words; a `command` in them
    // is painted as one, the way every command on this screen is.
    ...facts.hermes.map((profile, i): [string, string] => [
      i === 0 ? "hermes" : "",
      kit.caution(`${profile.profile}: ${profile.problem.replace(/`([^`]+)`/g, (_, typed: string) => kit.cmd(typed))}`),
    ]),
  ];

  const sections: Array<[string, Array<[string, string]>]> = [
    ["This machine", machineRows],
    ["Cloud", cloudRows],
    ["Enforcement", enforcementRows],
  ];
  const aligned = kit.kv(sections.flatMap(([, items]) => items));
  const screen = [kit.header("Status")];
  let taken = 0;
  for (const [heading, items] of sections) {
    screen.push("", kit.head(heading), ...aligned.slice(taken, taken + items.length));
    taken += items.length;
  }

  const attention = pickStatusAttention(facts);
  if (attention) {
    screen.push("", attention.severity === "fail" ? kit.fail(attention.text, attention.fix) : kit.caution(attention.text, attention.fix));
  }
  if (facts.pauses.length > 0) {
    const id = facts.pauses.length === 1 ? facts.pauses[0].sessionId : "<id>";
    screen.push("", `Resume early:  ${kit.cmd(`failproofai config --resume --session ${id}`)}`);
  }
  return screen;
}

/** `config --status`: read the machine, draw it for `stdout`. */
export async function runStatusCommand(
  opts: { cwd?: string; stdout?: TTYOut; deps?: StatusDeps } = {},
): Promise<{ lines: string[]; paused: number }> {
  const facts = await gatherStatusFacts({ ...opts.deps, cwd: opts.cwd ?? opts.deps?.cwd });
  return { lines: renderStatusScreen(facts, optsFor(opts.stdout ?? process.stdout)), paused: facts.pauses.length };
}
