"use server";

import { installHooks, removeHooks } from "@/src/hooks/manager";
import { readHooksConfig } from "@/src/hooks/hooks-config";
import { BUILTIN_POLICIES } from "@/src/hooks/builtin-policies";
import { detectInstalledClis } from "@/src/hooks/integrations";
import type { HookScope, IntegrationType } from "@/src/hooks/types";

export async function installHooksWebAction(
  scope: HookScope = "user",
  cli?: IntegrationType[],
): Promise<void> {
  const config = readHooksConfig();
  // On first install (no config yet), default to all defaultEnabled non-beta policies.
  // Always pass an explicit array so installHooks never triggers the interactive TUI.
  const policies =
    config.enabledPolicies.length > 0
      ? config.enabledPolicies
      : BUILTIN_POLICIES.filter((p) => p.defaultEnabled && !p.beta).map((p) => p.name);
  // When the dashboard doesn't pass an explicit cli list, default to detected CLIs;
  // if none are detected (rare on a server-rendered dashboard), fall back to claude.
  const target = cli && cli.length > 0 ? cli : detectInstalledClis();
  const finalCli: IntegrationType[] = target.length > 0 ? target : ["claude"];
  // Ticking an agent here means "guard this agent", so it is traced from now on
  // and the next `failproofai config` keeps its hooks (decision D2). The panel
  // shows no success message, so the note lands in the server log only.
  await installHooks(policies, scope, undefined, false, "web", undefined, false, finalCli, {
    syncAgentSelection: true,
  });
}

export async function removeHooksWebAction(
  scope: HookScope | "all" = "user",
  cli?: IntegrationType[],
): Promise<void> {
  // Mirror the install-side resolution: if the dashboard didn't pin a CLI,
  // remove from every detected CLI so an uninstall doesn't silently leave
  // hooks behind for the other agent.
  const target = cli && cli.length > 0 ? cli : detectInstalledClis();
  const finalCli: IntegrationType[] = target.length > 0 ? target : ["claude"];
  // At user scope (the panel's only one) an unticked agent stops being traced
  // too: its sessions stop being collected, and `failproofai config` does not
  // put its hooks back.
  await removeHooks(undefined, scope, undefined, { source: "web", cli: finalCli, syncAgentSelection: true });
}
