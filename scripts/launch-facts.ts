/**
 * What the launch screen states about this machine, read from disk.
 *
 * Files only: no daemon probe, no `systemctl`, no `which` (`detectInstalled()`
 * spawns one per agent), and no policy file imported. This runs on every bare
 * `failproofai`, while someone waits for a URL. Each fact is read on its own
 * and degrades on its own, so an unreadable file costs one row its detail and
 * never the screen.
 */
// Aliased for the same reason as the long names below: the CLI is one
// scope-hoisted bundle, where another plain `resolve` import renumbers every
// later module's `resolveN` binding.
import { resolve as resolveLaunchPath } from "node:path";
import { INTEGRATION_TYPES } from "../src/hooks/types";
import { getIntegration } from "../src/hooks/integrations";
import { integrationsInstalledAt, notEnforcingReason } from "../src/hooks/manager";
import { readConfig, readCredentials, type FpConfig } from "../src/hooks/fp-config";
import { readCloudCredentials } from "../src/hooks/cloud-enrollment";
import { readIngestCredential } from "../src/hooks/collector-config";
import { cloudBaseFor } from "../src/hooks/cloud-connection";
import { deliveryHealth } from "../src/hooks/delivery-health";
import { hasInstalledRegexPacks, readInstalledPacks } from "../src/hooks/pack-manifest";
import { readActiveCloudManagedPolicies } from "../src/hooks/cloud-managed-policies";
import { configuredCustomPolicyPaths, findProjectConfigDir, readMergedHooksConfig } from "../src/hooks/hooks-config";
import { discoverPolicyFiles } from "../src/hooks/custom-hooks-loader";
import { customPoliciesDir } from "../src/hooks/fp-home";
import {
  describeCloudConnection,
  describePoliciesOn,
  describeTracedAgents,
  type LaunchCloudSummary,
  type LaunchPoliciesSummary,
} from "./launch-screen";

export interface LaunchMachineFacts {
  policies: string;
  agents: string;
  cloud: string;
  notEnforcing: boolean;
}

export function gatherLaunchFacts(cwd: string): LaunchMachineFacts {
  const row = (read: () => string): string => {
    try {
      return read();
    } catch {
      return "could not be read";
    }
  };
  let notEnforcing = false;
  try {
    notEnforcing = notEnforcingReason(cwd) !== null;
  } catch {
    // Unknown is not a warning: `failproofai policies` is the full answer.
  }
  return {
    policies: row(() => describePoliciesOn(readLaunchPolicies(cwd))),
    agents: row(() => describeTracedAgents(readTracedAgentNames(cwd))),
    cloud: row(() => describeCloudConnection(readLaunchCloud())),
    notEnforcing,
  };
}

/**
 * Policies switched on, from the same inputs `notEnforcingReason` reads, so the
 * row and the warning under it cannot disagree: installed packs (minus the
 * per-version switches the dashboard used to write), the cloud deployment, the
 * legacy built-ins on a machine still on the pre-pack shim, and whether custom
 * policy files exist. Their contents are never imported to count them.
 */
export function readLaunchPolicies(cwd: string): LaunchPoliciesSummary {
  const config = readMergedHooksConfig(cwd);
  const disabled = new Set(config.disabledCustomPolicies ?? []);
  const sources: LaunchPoliciesSummary["sources"] = [];
  try {
    for (const pack of readInstalledPacks().packs) {
      const taken = pack.enabled ?? pack.policies.map((policy) => policy.name);
      const on = taken.filter((name) => !disabled.has(`pack:${pack.id}@${pack.version}:${name}`)).length;
      if (on > 0) sources.push({ label: `${pack.id}@${pack.version}`, count: on, pack: true });
    }
  } catch {
    // An unreadable manifest is reported by `failproofai policies`.
  }
  try {
    const managed = readActiveCloudManagedPolicies();
    if (managed.length > 0) sources.push({ label: "FailproofAI Cloud", count: managed.length, pack: false });
  } catch {
    // No deployment, or an unreadable one: nothing is on from there.
  }
  if (config.enabledPolicies.length > 0 && !hasInstalledRegexPacks()) {
    sources.push({ label: "built-in policies", count: config.enabledPolicies.length, pack: false });
  }
  const projectDir = resolveLaunchPath(findProjectConfigDir(cwd), ".failproofai", "policies");
  const customFiles =
    configuredCustomPolicyPaths(config).length > 0 ||
    discoverPolicyFiles(projectDir).length > 0 ||
    discoverPolicyFiles(customPoliciesDir()).length > 0;
  return { sources, customFiles };
}

/**
 * The agents failproofai traces, by display name in the canonical order: the
 * saved selection when there is one, else the agents hooked at user scope.
 */
export function readTracedAgentNames(cwd: string, config: FpConfig = readConfig()): string[] {
  const ids: readonly string[] = config.agents ? config.agents.selected : integrationsInstalledAt("user", cwd);
  return INTEGRATION_TYPES.filter((id) => ids.includes(id)).map((id) => {
    try {
      return getIntegration(id).displayName;
    } catch {
      return id;
    }
  });
}

/**
 * The connection, in the precedence `config --status` uses
 * (`connectionStatusReport`): the environment first, then either credential,
 * and the collector's record of refused uploads over the files' claim, because
 * a revoked key leaves both files byte-for-byte correct while nothing arrives.
 * The daemon's state is left out: reading it runs `systemctl`.
 */
export function readLaunchCloud(): LaunchCloudSummary {
  const envUrl = process.env.FAILPROOFAI_CLOUD_URL;
  if (envUrl) return { kind: "environment", url: envUrl };
  const creds = readCloudCredentials();
  const ingest = readIngestCredential();
  if (!creds && !ingest) return { kind: "none" };
  const org = readCredentials().org;
  const where = creds ? creds.url : cloudBaseFor(ingest!.url);
  let host = where;
  try {
    host = new URL(where).host || where;
  } catch {
    // Not a URL: show it as written.
  }
  let refused: { codes: number[]; credential: boolean } | null = null;
  if (ingest) {
    const health = deliveryHealth();
    if (health.rejected > 0) {
      refused = {
        codes: Object.keys(health.byStatus)
          .map(Number)
          .sort((a, b) => a - b),
        credential: health.credentialRejected > 0,
      };
    }
  }
  return {
    kind: "connected",
    org: org?.name || org?.slug || org?.id || null,
    host,
    pulling: Boolean(creds),
    sending: Boolean(ingest),
    refused,
  };
}
