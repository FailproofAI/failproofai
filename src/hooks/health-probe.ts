/**
 * The daemon health probe's marker (`probeDaemon` in `daemon-service.ts`).
 *
 * The probe is a SessionStart sent through the daemon to the warm worker, so a
 * reply proves the whole path answers. It is not an agent's session: the
 * handler answers it before any scope, policy or activity logic, or every
 * probe recorded `agent_scope_unresolved` in `errors.json` (it carries no cwd
 * and no `--agent-scope`) and wrote a fake SessionStart activity row.
 */
export const HEALTH_PROBE_SOURCE = "failproofai-health-probe";

/** Whether a parsed hook payload is the daemon health probe. */
export function isHealthProbe(eventType: string, parsed: Record<string, unknown>): boolean {
  return eventType === "SessionStart" && parsed.source === HEALTH_PROBE_SOURCE && parsed.session_id === undefined;
}
