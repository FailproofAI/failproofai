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
const READ_UTIL = /\b(?:cat|head|tail|less|more|od|xxd|strings|grep|egrep|fgrep|awk|sed|nl|tac|xxd|base64|cp|mv|python3?|perl|ruby|node)\b/;
const GLOB_READ = new RegExp(`${READ_UTIL.source}[^|;&]*\\*`);

/**
 * Which probe is running, derived from the per-probe oracle dir.
 *
 * probe-cli.sh points FAILPROOFAI_HOOK_LOG_FILE at `$BASE/log-bash` for probe A
 * and `$BASE/log-read` for probe B, and in daemon mode restarts the daemon per
 * probe precisely so the warm worker inherits THIS probe's value. That makes it
 * the one signal a policy can read to tell the two apart — there is no other
 * per-probe channel, since the wire protocol carries no env.
 *
 * Unknown (unset) means "not inside a probe", and nothing below fires. A policy
 * that starts denying shell because it could not identify the phase would be a
 * far worse failure than the one it is guarding against.
 */
function inReadProbe() {
  return String(process.env.FAILPROOFAI_HOOK_LOG_FILE ?? "").endsWith("log-read");
}

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

// Shell-route path: during probe B ONLY, deny shell that could read a file.
//
// Probe B asks one question — is a deny on the CLI's READ tool honoured — and
// an agent with a shell can answer a different one by fetching the bytes some
// other way. Substring-matching the marker cannot stop that: `cat …/CANARY_MA*`
// slipped past the name, and once that was closed another route did. The list
// of ways to read a file with a shell is not enumerable, so this does not try
// to be complete. It exists to make the ATTEMPT visible.
//
// That is what its SEPARATE NAME buys: probe B's `read_denied` accepts only
// `canary-read`, so a deny logged under this policy never scores a PASS, and
// the verdict logic can see "the agent was reaching for the shell" and report
// INCONCLUSIVE — unproven — instead of FAIL. Reporting a workaround as broken
// enforcement is how a suite trains people to ignore it.
//
// Navigation stays allowed on purpose (`ls`, `pwd`, `find` without an -exec
// read): several CLIs locate the file before reading it, and denying that would
// push CLIs that pass today into INCONCLUSIVE for no gain.
customPolicies.add({
  name: "canary-read-shell",
  description: "Canary: deny shell file-reads during the read probe (route-around detector)",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!inReadProbe()) return allow();
    if (ctx.toolName !== "Bash") return allow();
    const cmd = String(ctx.toolInput?.command ?? "");
    if (READ_UTIL.test(cmd)) return deny("canary-read-shell probe intercepted");
    return allow();
  },
});

// ── The guard: every OTHER tool call carrying a canary token ────────────────
//
// The two probes each name one tool. An agentic model that gets denied does not
// retry the same tool — it reaches for a different one and completes the same
// outcome. Verified live twice: copilot 1.0.80, denied `touch CANARY_PROBE_ran`
// on Bash, said "created the equivalent file instead" and made the file with its
// Create tool; goose leaked the read probe's sentinel the same way on 2026-08-15.
// Both scored FAIL with the deny sitting honoured in the log two lines above.
// That is not a silent allow, and reporting it as one is how a suite teaches
// people to ignore it.
//
// So this denies a canary token appearing under ANY tool the two probes do not
// target, and the probe payloads themselves are deliberately exempt — those stay
// with canary-bash / canary-read so a PASS remains attributable to the policy
// that actually matched.
//
// TWO OUTCOMES, deliberately different, because they mean opposite things:
//
//   route-around  the payload normalized fine (the token is right there in
//                 command/file_path) and the model simply used another tool.
//                 Enforcement works; the probe should still PASS on its own
//                 deny. This just stops the side effect from landing.
//
//   drift         a path/shell tool whose CANONICAL field is EMPTY while the
//                 token sits somewhere else in tool_input — i.e. this CLI's
//                 input keys stopped mapping. In production nothing would have
//                 matched and the call would have run. That is the Copilot
//                 1.0.70 class, so it carries NORMALIZATION-DRIFT-SUSPECT and
//                 probe-cli.sh scores it FAIL.
//
// The drift test is restricted to tools with a known canonical field. A Grep for
// "CANARY" keeps its token in `pattern` and would otherwise read as drift every
// time an agent searched for the marker — a false FAIL for a working CLI.
const PATH_TOOLS = new Set(["Read", "Write", "Edit", "LS"]);

customPolicies.add({
  name: "canary-guard",
  description: "Canary: deny canary tokens reaching any tool the probes do not target (route-around + drift)",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    const cmd = String(ctx.toolInput?.command ?? "");
    const fp = String(ctx.toolInput?.file_path ?? "");

    // Leave the two probe payloads to the policies that name them.
    const isProbeA = ctx.toolName === "Bash" && /CANARY_PROBE/.test(cmd);
    const isProbeB = CANARY_REF.test(fp) || CANARY_REF.test(cmd) || GLOB_READ.test(cmd);
    if (isProbeA || isProbeB) return allow();

    let blob = "";
    try {
      blob = JSON.stringify(ctx.toolInput ?? {});
    } catch {
      blob = String(ctx.toolInput ?? "");
    }
    if (!/CANARY/.test(blob)) return allow();

    const canonicalEmpty = !/CANARY/.test(`${cmd}\n${fp}`);
    const expectsCanonical = ctx.toolName === "Bash" || PATH_TOOLS.has(String(ctx.toolName));
    if (canonicalEmpty && expectsCanonical) {
      return deny(
        `NORMALIZATION-DRIFT-SUSPECT: ${ctx.toolName} carries a canary token in tool_input ` +
          `but command/file_path are empty — this CLI's input keys no longer map`,
      );
    }
    return deny(`canary-guard: canary token reached ${ctx.toolName}, which neither probe targets (route-around)`);
  },
});
