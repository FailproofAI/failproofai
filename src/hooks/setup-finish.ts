/**
 * What `failproofai config` does after the wizard has applied: finish the
 * upgrade (restart a Hermes or OpenClaw gateway that still runs an older
 * plugin, or none) and bring every hooked agent's Self Reports MCP entry in
 * line with `self-report.json`.
 *
 * All of it runs behind one spinner line and leaves at most the Self Reports
 * line behind, plus a line for anything that needs the user: a gateway they
 * must restart themselves, a Hermes failure, an agent the sync could not
 * update. A gateway that is restarting by itself, and the per-agent MCP
 * changes, are not the user's to act on, so they are not printed (`self-report
 * sync` and `status` show those).
 */
import type { PluggedProfile } from "./update-run";
import type { TTYOut } from "./tui";

export interface FinishSetupOptions {
  /** This CLI's version. */
  version: string;
  /** The plugged gateway profiles before the wizard ran. */
  pluggedBefore: PluggedProfile[];
  out?: TTYOut;
}

/** Runs the steps; returns the exit code the upgrade part asks for (0 or 1). */
export async function finishSetup(opts: FinishSetupOptions): Promise<number> {
  const out = opts.out ?? process.stdout;
  const { runUpdateSteps, markUpdated, setupNeedsUpdateSteps, setupGatewayLine, restartNewlyPlugged } = await import("./update-run");
  const { progressLine, screenKit, colorsEnabled } = await import("./tui");
  const kit = screenKit({ color: colorsEnabled(out) });
  const keep: string[] = [];
  let exit = 0;
  const progress = progressLine(out, "Finishing setup…");
  try {
    if (!setupNeedsUpdateSteps(opts.version)) {
      // Already updated on this version: only a profile this run plugged in
      // (one created since) has a gateway still running without the plugin.
      const gateway = setupGatewayLine(await restartNewlyPlugged(opts.pluggedBefore).catch(() => []));
      if (gateway && !gateway.ok) keep.push(kit.caution(gateway.text));
    } else {
      progress.set("Restarting agent gateways…");
      const run = await runUpdateSteps({ layout: false, daemon: false, restart: true });
      keep.push(...run.lines.filter((l) => l.startsWith("✕")));
      const gateway = setupGatewayLine(run.restarts);
      if (gateway && !gateway.ok) keep.push(kit.caution(gateway.text));
      if (run.ok) markUpdated(opts.version);
      else exit = 1;
    }
    // Self Reports (on by default): write self-report.json when it is missing
    // off Cloud, then sync every hooked agent, also when setup found the
    // machine already configured and wrote no hooks. Best-effort.
    progress.set("Updating Self Reports…");
    const summary = await selfReportSetupSummary();
    if (summary) keep.push(summary.ok ? kit.ok(summary.text) : kit.caution(summary.text, summary.fix));
  } finally {
    progress.done(keep);
  }
  return exit;
}

/** Write the settings file if missing, sync, and say it in one line (or none). */
export async function selfReportSetupSummary(): Promise<{ ok: boolean; text: string; fix?: string } | null> {
  try {
    const { ensureSelfReportSettingsFile, selfReportSettingsState } = await import("./self-report");
    try {
      await ensureSelfReportSettingsFile();
    } catch {
      // the readers apply the same default without the file
    }
    const { syncSelfReportMcp, selfReportSummary } = await import("./self-report-install");
    const results = await syncSelfReportMcp({ quiet: true });
    return selfReportSummary(results, selfReportSettingsState());
  } catch {
    return null; // never fail setup over it
  }
}
