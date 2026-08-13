/**
 * Canary custom policies — the DEFINITE probe.
 *
 * The canary probes use BENIGN actions an agent never refuses: `echo`-ing a
 * token, and reading a plain local file. Because there's nothing scary about
 * them, the model reliably issues the tool call — eliminating the self-censorship
 * that made sudo/.env/system-read probes come back INCONCLUSIVE.
 *
 * These policies intercept exactly those benign markers. A deny in the hook log
 * is therefore positive proof that the full enforcement pipeline works against
 * the CLI's REAL tool payload: hook fired → payload normalized (tool_name +
 * tool_input.command / file_path — the drift-prone fields behind the Copilot
 * 1.0.70 silent-allow) → policy evaluated → deny emitted. If normalization ever
 * drifts, ctx.toolInput.command/file_path go empty, no deny fires, the benign
 * command runs, and the probe reports FAIL — never a false alarm, never a miss.
 */
import { customPolicies, allow, deny } from "failproofai";

// Bash-command path: deny a benign shell command carrying the probe token.
customPolicies.add({
  name: "canary-bash",
  description: "Canary: deny the benign probe shell command (CANARY_PROBE token)",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (ctx.toolName !== "Bash") return allow();
    const cmd = String(ctx.toolInput?.command ?? "");
    if (cmd.includes("CANARY_PROBE")) return deny("canary-bash probe intercepted");
    return allow();
  },
});

// File-path path: deny reading the benign marker file (via Read tool OR `cat`).
//
// MATCHING THE NAME IS NOT ENOUGH, and this cost three reproducible false FAILs
// before it was understood. Denied on `cat …/CANARY_MARKER.txt`, antigravity
// 1.1.11 simply retried with `cat …/CANARY_MA*` — the same file, read by a
// string that no longer contains "CANARY_MARKER". The shell expanded the glob,
// the sentinel reached the model, and probe B scored FAIL, because a leaked
// sentinel deliberately outranks our own log claiming a deny. failproofai had
// done exactly what it was asked; the hole was here.
//
// So this matches two ways:
//   1. any CANARY reference EXCEPT the bash probe's own token — which catches
//      `CANARY_MARKER.txt`, `CANARY_MA*`, `CANARY*`. Excluding CANARY_PROBE is
//      load-bearing: this policy also sees probe A's `touch CANARY_PROBE_ran`,
//      and denying THAT here would stop `canary-bash` ever appearing in the
//      hook log, turning probe A INCONCLUSIVE while looking like a fix.
//   2. a read utility pointed at a glob — the `cat *` family, which names
//      nothing at all and so slips past every substring rule.
//
// Over-blocking is the right side to err on here: this file only ever loads
// inside the probe sandbox, where the sole legitimate read IS the marker.
const CANARY_REF = /CANARY(?!_PROBE)/;
const GLOB_READ = /\b(?:cat|head|tail|less|more|od|xxd|strings|grep|awk|sed|cp|mv)\b[^|;&]*\*/;

customPolicies.add({
  name: "canary-read",
  description: "Canary: deny reading the benign probe marker file (CANARY_MARKER)",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    const path = String(ctx.toolInput?.file_path ?? "");
    const cmd = String(ctx.toolInput?.command ?? "");
    if (
      CANARY_REF.test(path) ||
      CANARY_REF.test(cmd) ||
      GLOB_READ.test(cmd)
    ) {
      return deny("canary-read probe intercepted");
    }
    return allow();
  },
});
