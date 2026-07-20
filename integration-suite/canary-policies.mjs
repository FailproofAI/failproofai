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
customPolicies.add({
  name: "canary-read",
  description: "Canary: deny reading the benign probe marker file (CANARY_MARKER)",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    const path = String(ctx.toolInput?.file_path ?? "");
    const cmd = String(ctx.toolInput?.command ?? "");
    if (path.includes("CANARY_MARKER") || cmd.includes("CANARY_MARKER")) {
      return deny("canary-read probe intercepted");
    }
    return allow();
  },
});
