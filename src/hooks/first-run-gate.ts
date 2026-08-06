/**
 * Whether a given `failproofai` invocation may be interrupted by the
 * first-run wizard.
 *
 * Deliberately has NO imports. It is consulted from `bin/failproofai.mjs`,
 * which keeps its module graph small so the `--hook` fast path (one process
 * per tool call) does not pay for loading the world; and it lives outside that
 * file so it can be unit-tested without executing the CLI's top-level body.
 *
 * This decides only the SHAPE of the command. Whether the machine is actually
 * unconfigured, whether there is a TTY, and whether we are running under sudo
 * are decided later, in `maybeFirstRunConfigure`.
 */

/**
 * Subcommands that must never be interrupted by onboarding.
 *
 * All three are configuration actions in their own right: `config` IS the
 * wizard, and `policies` / `policy` are the non-interactive way to do setup.
 * Putting a wizard in front of them would override an intent the user just
 * stated, and would hang any script that calls them.
 */
export const FIRST_RUN_EXEMPT_SUBCOMMANDS: readonly string[] = [
  "config",
  "policies",
  "policy",
];

export function shouldOfferFirstRun(args: readonly string[]): boolean {
  // "What is this / how do I use it" must never require setup first.
  if (args.includes("--help") || args.includes("-h")) return false;
  if (args.includes("--version") || args.includes("-v")) return false;
  // `--hook` never reaches this check (the entry point handles and exits
  // above), but a stray one here would mean an agent's tool call sitting at an
  // interactive prompt it cannot answer. Cheap to be explicit.
  if (args.includes("--hook")) return false;
  if (args.length > 0 && FIRST_RUN_EXEMPT_SUBCOMMANDS.includes(args[0])) return false;
  return true;
}
