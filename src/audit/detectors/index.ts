/**
 * Registry of audit-only detectors.
 *
 * Detectors are pure functions over a NormalizedToolEvent (plus optional
 * per-session state). They detect "stupid behaviors" not currently covered by
 * the runtime builtin policies, with no real-time enforcement — counting only.
 *
 * Add a new detector by writing a sibling file and registering it here.
 */
import type { Detector } from "../types";
import { redundantCdCwd } from "./redundant-cd-cwd";
import { preferEditOverReadCat } from "./prefer-edit-over-read-cat";
import { preferEditOverSedAwk } from "./prefer-edit-over-sed-awk";
import { preferWriteOverHeredoc } from "./prefer-write-over-heredoc";
import { sleepPollingLoop } from "./sleep-polling-loop";
import { findFromRoot } from "./find-from-root";
import { gitCommitNoVerify } from "./git-commit-no-verify";
import { rereadAfterEdit } from "./reread-after-edit";

export const AUDIT_DETECTORS: Detector[] = [
  redundantCdCwd,
  preferEditOverReadCat,
  preferEditOverSedAwk,
  preferWriteOverHeredoc,
  sleepPollingLoop,
  findFromRoot,
  gitCommitNoVerify,
  rereadAfterEdit,
];

export function getDetectorByName(name: string): Detector | undefined {
  return AUDIT_DETECTORS.find((d) => d.name === name);
}
