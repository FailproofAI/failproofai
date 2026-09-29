/**
 * The Hermes half of `failproofai update`.
 *
 * npm replaces the CLI and nothing else, and until this ran `update` never
 * looked at Hermes — so a machine that installed Hermes enforcement with ≤1.0.5
 * kept its config.yaml shell hooks through every upgrade. Those hooks never
 * reach Hermes cron jobs (each cron fire builds its own hook scope, which only
 * discovered plugins join), so every scheduled job on such a machine ran
 * unchecked while everything looked configured.
 *
 * This migrates each profile that already uses FailproofAI to the linked native
 * plugin, and reports per profile. It fails (ok: false → non-zero exit) whenever
 * a profile that uses FailproofAI is left on shell hooks or otherwise could not
 * be brought current, because a green `update` is exactly how the gap stayed
 * invisible.
 */
import { migrateHermesProfiles, type HermesPluginInstallDeps, type HermesProfileMigration } from "./integrations";

export interface HermesUpdateResult {
  ok: boolean;
  lines: string[];
  profiles: HermesProfileMigration[];
}

const STATUS_LABEL: Record<HermesProfileMigration["status"], string> = {
  migrated: "migrated",
  current: "already current",
  untouched: "skipped",
  blocked: "NOT migrated",
  failed: "FAILED",
};

export async function runHermesUpdateMigration(deps: {
  daemonSupportsPolicyEvaluation: () => Promise<boolean>;
  installDeps?: HermesPluginInstallDeps;
}): Promise<HermesUpdateResult> {
  const profiles = await migrateHermesProfiles(deps);
  const relevant = profiles.filter((p) => p.status !== "untouched");
  // A machine without FailproofAI on Hermes hears nothing about Hermes.
  if (relevant.length === 0) return { ok: true, lines: [], profiles };

  const width = Math.max(...profiles.map((p) => ("hermes/" + p.name).length));
  const lines = ["Hermes:"];
  for (const p of profiles) {
    const label = ("hermes/" + p.name).padEnd(width);
    const detail = p.status === "current" ? "" : ` — ${p.detail}`;
    lines.push(`  ${label}  ${STATUS_LABEL[p.status]}${detail}`);
  }

  const blocked = profiles.filter((p) => p.status === "blocked");
  const failed = profiles.filter((p) => p.status === "failed");
  if (profiles.some((p) => p.status === "migrated")) {
    lines.push(
      "  Cron jobs load the plugin on their next run; restart running Hermes gateways and sessions to load it there.",
    );
  }
  if (blocked.length > 0) {
    lines.push(
      "",
      `Hermes is NOT migrated (${blocked.map((p) => p.name).join(", ")}): the running failproofaid cannot`,
      "answer the native plugin (no policyEvaluation), so nothing was changed. Profiles still on",
      "shell hooks do NOT check Hermes cron jobs. Run `failproofai config` (it asks for sudo to",
      "replace the daemon), then `failproofai update` again.",
    );
  }
  if (failed.length > 0) {
    lines.push(
      "",
      `Hermes could not be migrated for: ${failed.map((p) => p.name).join(", ")}. Fix the reason above,`,
      "then run `failproofai update` again.",
    );
  }
  return { ok: blocked.length === 0 && failed.length === 0, lines, profiles };
}
