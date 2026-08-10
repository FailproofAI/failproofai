"use server";

import { listActivePauses } from "@/src/hooks/session-pause";
import type { ActivePause } from "@/src/hooks/session-pause";

/**
 * Sessions whose enforcement is paused right now.
 *
 * Read live rather than derived from activity rows: a pause set seconds ago has
 * produced no rows yet, and that is exactly the moment someone needs to be told
 * the machine is unguarded. Expiry is applied at read time, so an expired pause
 * simply stops appearing.
 */
export async function getActivePausesAction(): Promise<ActivePause[]> {
  return listActivePauses();
}
