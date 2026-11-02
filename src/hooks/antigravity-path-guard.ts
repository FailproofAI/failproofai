/**
 * Refuses an Antigravity file tool call whose path failproofai cannot read.
 *
 * Antigravity has renamed its file tools' path arguments between releases, and a
 * key `ANTIGRAVITY_TOOL_INPUT_MAP` does not know leaves `file_path` empty. Every
 * path policy then has nothing to check and allows the call, which is how #961
 * stayed silent: `.env` was readable and writable with those policies enabled.
 * Refusing is loud on the next rename, and allowing is a silent bypass.
 *
 * Registered by `handler.ts`, not declared as a builtin, for three reasons:
 *   - Policies come from packs, and a pack's copy of `block-env-files` is not
 *     this build's, so a check there would not reach most machines.
 *   - `block-failproofai-commands` runs everywhere but is pinned never to route
 *     on Read, because a guard that blocks diagnosis gets worked around. This
 *     refuses only a call nothing could check, not reading.
 *   - It is one CLI's contract, not a policy anyone would enable or configure.
 *
 * A tool NAME the map does not know still passes through, as on every CLI: an
 * unknown name could be anything, and most of Antigravity's are not file tools.
 *
 * Registered only for a call that lacks a path, so every normal call's activity
 * row and evaluation stay exactly as they were, with no entry for a check that
 * had nothing to say.
 */
import { deny, allow } from "./policy-helpers";
import type { PolicyContext, PolicyMatcher, PolicyResult } from "./policy-types";
import type { HookEventType } from "./types";

export const ANTIGRAVITY_PATH_GUARD_NAME = "failproofai/antigravity-file-path-required";

export const ANTIGRAVITY_PATH_GUARD_DESCRIPTION =
  "Refuse an Antigravity file tool call with no file path failproofai can check.";

export const ANTIGRAVITY_PATH_GUARD_MATCH: PolicyMatcher = {
  events: ["PreToolUse"],
  toolNames: ["Read", "Write", "Edit"],
};

/** Whether this canonicalized call is a file tool with no path anything could check. */
export function antigravityCallLacksPath(
  eventType: HookEventType | string,
  toolName: string | undefined,
  toolInput: unknown,
): boolean {
  if (eventType !== "PreToolUse") return false;
  if (!toolName || !ANTIGRAVITY_PATH_GUARD_MATCH.toolNames?.includes(toolName)) return false;
  const path = (toolInput as Record<string, unknown> | null | undefined)?.file_path;
  return typeof path !== "string" || path.trim() === "";
}

export function antigravityPathGuard(ctx: PolicyContext): PolicyResult {
  if (!antigravityCallLacksPath(ctx.eventType, ctx.toolName, ctx.toolInput)) return allow();
  return deny(
    `failproofai could not find a file path in this ${ctx.toolName ?? "file"} call, so it cannot check it against your policies. ` +
      "Your Antigravity version may have changed its tool arguments: update failproofai.",
  );
}
