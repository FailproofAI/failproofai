/**
 * Decision D2: a command that installs or removes an agent's hooks keeps the
 * agent selection true.
 *
 * `agents.selected` in `config.json` is one list with three readers: which
 * agents `failproofai config` hooks, which harnesses the daemon collects, and
 * which ones `backfill` re-sends. Only `config` used to write it, so any other
 * command that changed an agent's hooks left the list saying the opposite:
 *
 *  - `policies --install --cli goose`, on a machine whose selection leaves Goose
 *    out, wired Goose — and the next `failproofai config`, which takes out the
 *    hooks of every agent it does not trace, silently removed them again.
 *  - `policies --uninstall --cli goose` took the hooks out and left Goose
 *    traced, so the daemon kept collecting its sessions and the next `config`
 *    put the hooks back.
 *
 * An install traces the agent at ANY scope: whichever file the hooks went into,
 * somebody asked for that agent to be guarded. A removal untraces it only at
 * user scope or every scope. The selection is per machine, and taking one
 * repository's project hooks out says nothing about whether this machine should
 * trace the agent — so that decision is the caller's, which knows the scope.
 *
 * Absent means every agent is traced, so an install has nothing to add. A
 * removal cannot be recorded without a list, so it writes one: the agents on
 * this machine — detected, or still hooked at user scope — but the ones
 * removed, and `seen` as detected now. Not "every agent but the ones removed":
 * `failproofai config` restores a saved list as it stands, so that list would
 * have it hook every agent this build knows, installed or not.
 *
 * An agent traced again starts fresh (`requestFreshStart`), exactly as one
 * re-ticked in `failproofai config` does.
 *
 * Only the commands that ask for it (`syncAgentSelection`) come here.
 * `failproofai config` writes the selection itself, and `failproofai uninstall`
 * leaves it alone.
 */
import { existsSync } from "node:fs";

import { machineCollectsSessions, requestFreshStart } from "./backfill-request";
import { readConfig, updateConfig } from "./fp-config";
import { detectInstalledClis, getIntegration, hermesProfileHealth, settingsPathsFor } from "./integrations";
import { optsFor, screenKit } from "./tui";
import { INTEGRATION_TYPES, type IntegrationType } from "./types";

/**
 * Whether an agent has failproofai hooks in its USER settings — the seed for an
 * upgrade in `failproofai config`, and what a removal on a machine with no
 * saved list keeps traced. User scope only: project hooks depend on the
 * directory a command happens to run from. A gateway with several profiles
 * counts when ANY profile is hooked; requiring all of them would drop a partly
 * hooked Hermes from the seed, and setup would then unhook every profile it has.
 *
 * Hooked means routed to failproofai, not healthy: a Hermes profile still on the
 * legacy shell hooks sends every tool call here today. Requiring the healthy
 * native plugin left such a gateway unticked, so setup stopped collecting it and
 * never ran the install that moves it onto the plugin.
 */
export function hookedAtUserScope(id: IntegrationType, cwd: string): boolean {
  const integration = getIntegration(id);
  try {
    if (integration.hooksInstalledInSettings("user", cwd)) return true;
    if (id === "hermes") {
      return hermesProfileHealth().some(
        (p) => existsSync(p.home) && ((p.pluginInstalled && p.pluginEnabled) || p.legacyShellHookPresent),
      );
    }
    const paths = settingsPathsFor(integration, "user", cwd);
    if (paths.length < 2) return false;
    return paths.some((one) =>
      integration.hooksInstalledInSettings.call({ ...integration, getSettingsPaths: () => [one] }, "user", cwd),
    );
  } catch {
    return false;
  }
}

/**
 * Bring the selection in line with hooks just installed for, or removed from,
 * `clis`, and return the one line that says so: a ✓ note, a ▲ when the change
 * could not be written, or null when the selection already agreed.
 *
 * The caller prints it after its own output, and only where the scope counts —
 * see the module comment.
 */
export function keepAgentSelectionTrue(
  change: "installed" | "removed",
  clis: readonly IntegrationType[],
): string | null {
  const touched = INTEGRATION_TYPES.filter((id) => clis.includes(id));
  if (touched.length === 0) return null;
  const saved = readConfig().agents;

  let moved: IntegrationType[];
  let next: { selected: string[]; seen: string[] };
  if (change === "installed") {
    if (!saved) return null;
    moved = touched.filter((id) => !saved.selected.includes(id));
    if (moved.length === 0) return null;
    // INTEGRATION_TYPES order. An id this build does not know is a newer
    // build's agent, so it is kept after them as written, never dropped.
    const inOrder = (ids: readonly string[]): string[] => [
      ...INTEGRATION_TYPES.filter((id) => ids.includes(id)),
      ...ids.filter((id) => !(INTEGRATION_TYPES as readonly string[]).includes(id)),
    ];
    const detected = detectInstalledClis();
    const nowSeen = moved.filter((id) => detected.includes(id) && !saved.seen.includes(id));
    next = {
      selected: inOrder([...saved.selected, ...moved]),
      seen: nowSeen.length > 0 ? inOrder([...saved.seen, ...nowSeen]) : saved.seen,
    };
  } else if (saved) {
    moved = touched.filter((id) => saved.selected.includes(id));
    if (moved.length === 0) return null;
    const gone = new Set<string>(moved);
    // Possibly empty, after every agent's hooks came out: an empty selection
    // traces nothing, which is exactly what was asked for.
    next = { selected: saved.selected.filter((id) => !gone.has(id)), seen: saved.seen };
  } else {
    moved = touched;
    const detected = detectInstalledClis();
    const cwd = process.cwd();
    next = {
      selected: INTEGRATION_TYPES.filter(
        (id) => !touched.includes(id) && (detected.includes(id) || hookedAtUserScope(id, cwd)),
      ),
      seen: detected,
    };
  }

  const kit = screenKit(optsFor(process.stdout));
  const names = moved.map((id) => getIntegration(id).displayName);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const one = names.length === 1;
  const setup = kit.cmd("failproofai config");
  // Before the selection that traces them, in the same order setup uses.
  if (change === "installed") requestFreshStart(moved, machineCollectsSessions());
  try {
    updateConfig({ agents: next });
  } catch (err) {
    // The hooks themselves are in place, so the command is not failed for
    // this. Said instead, because it is the exact drift this module exists to
    // stop, and nothing else would mention it.
    const why = err instanceof Error ? err.message : String(err);
    return kit.caution(
      change === "installed"
        ? `Couldn't record ${who} as traced (${why}), so ${setup} may remove ${one ? "its" : "their"} hooks again.`
        : `Couldn't record ${who} as no longer traced (${why}), so ${setup} may add ${one ? "its" : "their"} hooks back.`,
    );
  }
  return kit.ok(
    change === "installed"
      ? `${who} ${one ? "is" : "are"} traced again, so ${setup} keeps ${one ? "its" : "their"} hooks.`
      : `${who} ${one ? "is" : "are"} no longer traced, so ${setup} won't add ${one ? "its" : "their"} hooks back.`,
  );
}
