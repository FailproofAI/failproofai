"use server";

import {
  readHooksConfig,
  readScopedHooksConfig,
  writeHooksConfig,
  writeScopedHooksConfig,
} from "@/src/hooks/hooks-config";
import { trackHookEvent } from "@/src/hooks/hook-telemetry";
import { getInstanceId } from "@/lib/telemetry-id";
import type { HooksConfig } from "@/src/hooks/policy-types";
import { HOOK_SCOPES } from "@/src/hooks/types";

export async function togglePolicyAction(name: string, enabled: boolean): Promise<void> {
  const config = readHooksConfig();
  const set = new Set(config.enabledPolicies);
  if (enabled) {
    set.add(name);
  } else {
    set.delete(name);
  }
  writeHooksConfig({ ...config, enabledPolicies: [...set] });

  // Telemetry: track policy toggle from the web UI (best-effort)
  try {
    const distinctId = getInstanceId();
    await trackHookEvent(distinctId, "policy_toggled", {
      policy_name: name,
      enabled,                                // new state: true = on, false = off
      action: enabled ? "enable" : "disable", // human-readable direction
      source: "web",
    });
  } catch {
    // Never block the operation
  }
}

export async function toggleCustomPolicyAction(id: string, enabled: boolean): Promise<void> {
  if (!id.startsWith("custom:") && !id.startsWith("convention:")) {
    throw new Error("Invalid custom policy ID");
  }
  const launchCwd = process.env.FAILPROOFAI_LAUNCH_CWD || process.cwd();
  if (enabled) {
    // Enforcement unions disabled IDs across every scope. Remove this ID from
    // every scope that contributes it; deleting it only from the user config
    // would make the dashboard report ON while runtime still keeps it OFF.
    for (const scope of HOOK_SCOPES) {
      const scoped = readScopedHooksConfig(scope, launchCwd);
      if (!scoped.disabledCustomPolicies?.includes(id)) continue;
      const disabled = scoped.disabledCustomPolicies.filter((value) => value !== id);
      const next: HooksConfig = { ...scoped, disabledCustomPolicies: disabled };
      if (!disabled.length) delete next.disabledCustomPolicies;
      writeScopedHooksConfig(next, scope, launchCwd);
    }
    return;
  }

  // New dashboard opt-outs live in user scope, preserving the existing
  // behavior while making them apply to every project using that source ID.
  const config = readHooksConfig();
  const disabled = new Set(config.disabledCustomPolicies ?? []);
  disabled.add(id);
  const next: HooksConfig = { ...config, disabledCustomPolicies: [...disabled] };
  if (!disabled.size) delete next.disabledCustomPolicies;
  writeHooksConfig(next);
}
