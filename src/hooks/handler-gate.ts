/**
 * Which policy sources the daemon cannot answer for.
 *
 * Split out of `handler.ts` deliberately. That file runs on every hook event,
 * including this repository's own dogfood hooks, so reaching for filesystem
 * helpers inline there means one missing import takes out every tool call in a
 * session. It did, once. Delegating to a named function keeps `handler.ts`'s
 * import list short and its failure modes boring.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { discoverPolicyFiles } from "./custom-hooks-loader";
import { findProjectConfigDir } from "./hooks-config";

/**
 * Whether any convention policy file exists for this session.
 *
 * Convention policies live at `.failproofai/policies/*policies.{js,mjs,ts}` —
 * in the project and in the user's home — and are discovered from the
 * filesystem. They appear in **no configuration key**, which is precisely why
 * the daemon gate has to look for them here.
 *
 * The first version of that gate tested `customPoliciesPaths` and
 * `customPoliciesPath` only. A team keeping its policies in the convention
 * directory therefore had them silently stop enforcing the moment the daemon
 * answered: the gate saw nothing, the daemon evaluated the builtins, and the
 * `needs_user_context` safety net could not fire either, because the sealed
 * worker partitions the `enabled_policies` list it was handed and a convention
 * policy is never in that list — it self-registers at load. Reproduced
 * end-to-end: a convention policy denying a deploy denied with the daemon off
 * and allowed with it on.
 *
 * Two `readdirSync` calls on directories that usually do not exist, on a path
 * that already reads several JSON files. The cost is not the consideration; a
 * wrong verdict is.
 */
export function hasConventionPolicyFiles(sessionCwd: string | undefined): boolean {
  const cwd = sessionCwd ?? process.cwd();
  try {
    const projectDir = resolve(findProjectConfigDir(cwd), ".failproofai", "policies");
    if (discoverPolicyFiles(projectDir).length > 0) return true;
  } catch {
    // An unreadable project root is not a reason to hand the event to the
    // daemon; fall through and check user scope.
  }
  try {
    return discoverPolicyFiles(resolve(homedir(), ".failproofai", "policies")).length > 0;
  } catch {
    return false;
  }
}
