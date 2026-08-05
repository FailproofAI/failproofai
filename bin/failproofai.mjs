#!/usr/bin/env bun
/**
 * failproofai — main entry point.
 *
 * Handles:
 *   --hook <event>        Hook event from Claude Code (minimal startup latency)
 *   --version / -v        Print version and exit
 *   --help / -h           Show usage and exit
 *   policies              Manage policies (list / install / uninstall)
 *   (default)             Launch production dashboard
 */
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../package.json";

// Resolve the real package root early (following any npm bin symlinks) so that
// scripts/launch.ts can locate .next/standalone/server.js correctly regardless
// of how bun resolves import.meta.url for dynamically-imported modules.
if (!process.env.FAILPROOFAI_PACKAGE_ROOT) {
  process.env.FAILPROOFAI_PACKAGE_ROOT = resolve(
    dirname(realpathSync(fileURLToPath(import.meta.url))),
    ".."
  );
}

if (!process.env.FAILPROOFAI_DIST_PATH) {
  process.env.FAILPROOFAI_DIST_PATH = resolve(
    dirname(realpathSync(fileURLToPath(import.meta.url))),
    "..",
    "dist"
  );
}

const args = process.argv.slice(2);

// Normalize 'p' → 'policies' (shorthand alias)
if (args[0] === "p") args[0] = "policies";
// Normalize 'configure' / 'setup' → 'config' (aliases), so every later check
// (SUBCOMMANDS, dispatch) mentions only the canonical name.
if (args[0] === "configure" || args[0] === "setup") args[0] = "config";

// Lightweight telemetry helper for CLI lifecycle events. Lazy-loads to avoid
// pulling in the hook-telemetry / telemetry-id modules on the fast --hook path.
let _telemetry;
let lastSubcommand = null;
// When `policy add|remove` is mid-execution we stash the action here so the
// top-level catch can emit `cli_policy_add_failure` / `cli_policy_remove_failure`
// with the right event name. Mirrors the cli_install_failure / cli_uninstall_failure
// pattern below for parity. Cleared back to null after the success track.
let lastPolicyAction = null;
async function track(name, props) {
  try {
    if (!_telemetry) {
      const [t, i] = await Promise.all([
        import("../src/hooks/hook-telemetry"),
        import("../lib/telemetry-id"),
      ]);
      _telemetry = { trackHookEvent: t.trackHookEvent, getInstanceId: i.getInstanceId };
    }
    await _telemetry.trackHookEvent(_telemetry.getInstanceId(), name, props);
  } catch {}
}

/**
 * Exits only once stdout/stderr have actually been flushed.
 *
 * Under every agent CLI a hook's stdout is a pipe, and pipe writes in Node
 * are asynchronous — `process.exit()` terminates without draining what's
 * still buffered. That stdout carries the decision payload, so a truncated
 * write silently changes the decision the CLI observes; on the fail-closed
 * path it would drop the deny reason entirely and leave the CLI with a bare
 * exit code and no explanation.
 */
async function exitAfterFlush(code) {
  const drain = (stream) =>
    new Promise((resolveDrain) => {
      // A zero-length write's callback still queues behind everything
      // already buffered, so this resolves after the real output lands.
      if (stream.writableLength === 0 || stream.destroyed) resolveDrain();
      else stream.write("", () => resolveDrain());
    });
  try {
    await Promise.all([drain(process.stdout), drain(process.stderr)]);
  } catch {
    // Never let a flush problem swallow the exit code itself.
  }
  process.exit(code);
}

// --hook <event> [--cli <name>] — called by an agent CLI hook; fast path, outside
// runCli() because it has its own exit code contract with the calling agent.
const hookIdx = args.indexOf("--hook");
if (hookIdx >= 0) {
  if (!args[hookIdx + 1]) {
    console.error("Error: Missing event type after --hook");
    console.error("Usage: failproofai --hook <event> [--cli <claude|codex|copilot|cursor|opencode|pi|hermes|openclaw|factory|devin|antigravity|goose>]");
    process.exit(1);
  }
  const eventType = args[hookIdx + 1];
  const cliIdx = args.indexOf("--cli");
  const cliArg = cliIdx >= 0 ? args[cliIdx + 1] : undefined;
  // Default cli=claude preserves back-compat for hooks installed before
  // multi-CLI support landed.
  const cli =
    cliArg && (
      cliArg === "claude"
      || cliArg === "codex"
      || cliArg === "copilot"
      || cliArg === "cursor"
      || cliArg === "opencode"
      || cliArg === "pi"
      || cliArg === "hermes"
      || cliArg === "openclaw"
      || cliArg === "factory"
      || cliArg === "devin"
      || cliArg === "antigravity"
      || cliArg === "goose"
    )
      ? cliArg
      : "claude";
  try {
    // Daemon-aware path — inert (and this whole block skipped) on every
    // machine until `failproofai config` has installed failproofaid AND
    // written the daemonConfigured marker (Stage 4). Until then this is
    // byte-for-byte the same handleHookEvent(...) call below.
    const { isDaemonConfigured, attemptDaemonHook } = await import("../src/hooks/daemon-client");
    if (isDaemonConfigured()) {
      const { readStdinPayload } = await import("../src/hooks/read-stdin");
      const { evaluateHookEvent } = await import("../src/hooks/handler");
      const stdinRead = await readStdinPayload();

      const attempt = await attemptDaemonHook({
        hookEvent: eventType,
        cli,
        stdin: stdinRead.payload,
        // The client's own cwd IS the originating CLI session's cwd — this
        // process is spawned fresh, at that location, by the calling agent
        // CLI's own hook mechanism. See daemon-client.ts / PROTOCOL.md.
        cwd: process.cwd(),
      });

      // A failed attempt gets one of two opposite answers, and which one turns
      // entirely on WHY it failed.
      //
      // protocol-mismatch: a daemon answered, so it is demonstrably alive — we
      // just cannot speak its wire format, which happens when the CLI upgrades
      // via npm and the daemon has not been reinstalled yet. Falling back to
      // in-process costs latency and NOTHING else: it is the same policy engine
      // producing the same decisions. Denying here would take a working machine
      // offline to protect nothing, on an upgrade the user never asked to be
      // interrupted by — and it would do it to every machine in a fleet at once,
      // the moment PROTOCOL_VERSION is ever bumped.
      //
      // unreachable: nothing answered. A stopped service, a deleted socket,
      // tampering — indistinguishable from here, so this keeps failing closed.
      // That is the whole point of `daemonConfigured`.
      let result;
      if (attempt.ok) {
        result = attempt.response;
      } else if (attempt.failure === "protocol-mismatch") {
        console.error(
          "[failproofai] failproofaid speaks a different protocol version than this CLI — " +
            "evaluating in-process instead (slower, identical policies). " +
            "Run `failproofai config` to update the daemon.",
        );
        result = await evaluateHookEvent(eventType, cli, stdinRead.payload);
      } else {
        result = await evaluateHookEvent(eventType, cli, stdinRead.payload, {
          forceDecision: {
            decision: "deny",
            reason:
              "failproofaid could not be reached. This machine is configured to run hooks through it " +
              "— check the daemon (see `failproofai config`) rather than retrying blindly.",
          },
        });
      }

      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      await exitAfterFlush(result.exitCode);
    }

    const { handleHookEvent } = await import("../src/hooks/handler");
    const exitCode = await handleHookEvent(eventType, cli);
    // handleHookEvent already flushes its own telemetry before returning; this
    // is the normal, reliable exit.
    await exitAfterFlush(exitCode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await track("hook_dispatch_error", {
      event_type: eventType,
      cli,
      error_type: err instanceof Error ? err.name : "unknown",
    });
    // handleHookEvent threw before its own flush ran, so any events it fired
    // with `void trackHookEvent(...)` are still in flight — drain them (plus the
    // hook_dispatch_error above) before exiting so they aren't dropped.
    try {
      const { flushHookTelemetry } = await import("../src/hooks/hook-telemetry");
      await flushHookTelemetry();
    } catch {}
    console.error(`Unexpected error: ${msg}`);
    process.exit(2);
  }
}

/**
 * Centralised error handler for all CLI subcommands.
 * CliError  → clean message, no stack trace, exit exitCode (1 or 2)
 * Error     → unexpected; shows message only, exits 2
 */
async function runCli() {
  // Report a fresh install / upgrade. Deliberately here rather than at module
  // scope: everything above this point is the --hook fast path, which runs on
  // every tool call. No-ops after the first run on a given version.
  try {
    const { maybeReportInstall } = await import("../lib/install-check");
    await maybeReportInstall(version);
  } catch {
    // never block a command on reporting
  }

  // --help / -h  (only when not inside a subcommand that handles its own --help)
  const SUBCOMMANDS = ["policies", "policy", "auth", "audit", "config"];
  if ((args.includes("--help") || args.includes("-h")) && !SUBCOMMANDS.includes(args[0])) {
    const extraArgs = args.filter((a) => a !== "--help" && a !== "-h");
    if (extraArgs.length > 0) {
      throw new CliError(`Unexpected argument: ${extraArgs[0]}\nRun \`failproofai --help\` for usage.`);
    }
    console.log(`
failproofai v${version}

USAGE
  failproofai [command] [options]

COMMANDS
  (no args)                      Launch the policy dashboard
  config                         Interactive setup — pick scope, agents & policies

  policy add <name>              Enable a single policy (see \`policy --help\`)
  policy remove <name>           Disable a single policy

  policies, p                    List all available policies and their status
  policies --install, -i         Enable policies in agent CLI settings
    [names...]                     Specific policy names to enable
    --cli claude|codex|copilot|cursor|opencode|pi|hermes|openclaw|factory|devin|antigravity|goose
                                   Agent CLI(s) to install for; space-separated
                                   (e.g. --cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose) or repeated.
                                   Default: detect installed CLIs and prompt.
    --scope user|project|local     Config scope to write to (default: user)
                                   (Codex / Copilot / Cursor / OpenCode / Pi support user|project only)
    --beta                         Include beta policies
    --custom, -c <path>            Custom policy file (repeat for multiple files)

  policies --uninstall, -u       Disable policies or remove hooks
    [names...]                     Specific policy names to disable
    --cli claude|codex|copilot|cursor|opencode|pi|hermes|openclaw|factory|devin|antigravity|goose
                                   Agent CLI(s) to uninstall from
    --scope user|project|local|all Config scope to remove from (default: user)
    --beta                         Remove only beta policies
    --custom, -c                   Clear all explicit custom policy paths

  policies --help, -h            Show this help for the policies command

  auth                           Sign in / out of FailproofAI from the CLI.
    login                          Email + OTP flow; writes ~/.failproofai/auth.json
    logout                         Revoke this session and remove auth.json
    whoami                         Print the currently authenticated identity
  auth --help, -h                Show this help for the auth command

  audit                          Audit your agent's behavior, then open the
                                 dashboard at http://localhost:8020/audit
  audit --help, -h               Show this help for the audit command

  --version, -v                  Print version and exit
  --help, -h                     Show this help message

CONVENTION POLICIES
  Drop *policies.{js,mjs,ts} files into .failproofai/policies/ for auto-loading.
  Works at project level (.failproofai/policies/) and user level (~/.failproofai/policies/).
  No --custom flag or config changes needed — just drop files and they're picked up.

EXAMPLES
  failproofai policies
  failproofai policies --install
  failproofai policies --install block-sudo sanitize-api-keys --scope project
  failproofai policies --install --cli codex --scope project
  failproofai policies --install --cli copilot --scope project
  failproofai policies --install --cli cursor --scope project
  failproofai policies --install --cli opencode --scope project
  failproofai policies --install --cli pi --scope project
  failproofai policies --install --cli factory --scope project
  failproofai policies --install --cli devin --scope project
  failproofai policies --install --cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose
  failproofai policies --install --custom ./my-policies.js
  failproofai policies -i -c ./my-policies.js
  failproofai policies --uninstall block-sudo
  failproofai policies --uninstall --cli codex
  failproofai policies --uninstall --cli copilot
  failproofai policies --uninstall --cli cursor
  failproofai policies --uninstall --cli opencode
  failproofai policies --uninstall --cli pi
  failproofai policies --uninstall --custom

LINKS
  ⭐ Star us:      https://github.com/failproofai/failproofai
  📖 Docs:         https://docs.befailproof.ai/introduction
  💬 Discord:      https://discord.befailproof.ai/
`.trimStart());
    process.exit(0);
  }

  // --version / -v
  if ((args.includes("--version") || args.includes("-v")) && !SUBCOMMANDS.includes(args[0])) {
    const extraArgs = args.filter((a) => a !== "--version" && a !== "-v");
    if (extraArgs.length > 0) {
      throw new CliError(`Unexpected argument: ${extraArgs[0]}\nRun \`failproofai --help\` for usage.`);
    }
    console.log(version);
    process.exit(0);
  }

  // First-run onboarding — before any subcommand runs its own work.
  //
  // On a machine that has never been set up, the first thing the user typed is
  // almost never the thing they need first, so we run the wizard and then let
  // their original command proceed. Exemptions matter more than the rule:
  //
  //   --hook            never reaches here (it exits above) — it runs on every
  //                     tool call, and a wizard on that path would hang an agent
  //   --version/--help  answering "what is this" must not require setup
  //   config            IS the wizard
  //   policies/policy/  explicit configuration actions. Intercepting these would
  //   auth              fight the intent the user just stated, and would break
  //                     non-interactive scripts that call them to do setup.
  //
  // `maybeFirstRunConfigure` is itself a no-op on a configured machine, on a
  // non-TTY, and under sudo — so this is a cheap check, not a second gate.
  // Layout check, before onboarding decides anything. A home written by an
  // older layout is reset here — visibly, in a real command the user typed —
  // rather than from a hook, which runs unattended once per tool call. A home
  // written by a NEWER layout stops the command instead: that data is fine and
  // an upgrade would read it, so deleting it would destroy something
  // recoverable.
  {
    const { checkLayoutForCli } = await import("../src/hooks/fp-reset");
    const check = checkLayoutForCli();
    for (const line of check.lines) console.error(line);
    if (check.fatal) process.exit(1);
  }

  const { shouldOfferFirstRun } = await import("../src/hooks/first-run-gate");
  if (shouldOfferFirstRun(args)) {
    try {
      const { maybeFirstRunConfigure } = await import("../src/hooks/configure-wizard");
      // `audit` runs its own scan immediately after this returns; firing the
      // post-setup audit too would scan the whole history twice in a row.
      await maybeFirstRunConfigure({ postSetupAudit: args[0] !== "audit" });
    } catch {
      // Onboarding is never allowed to block the command the user actually typed.
    }
  }

  // policies [--install|-i|--uninstall|-u|--help|-h] [names...] [--scope] [--beta] [--custom|-c <path>]
  if (args[0] === "policies") {
    const subArgs = args.slice(1);

    const isInstall   = subArgs.includes("--install")   || subArgs.includes("-i");
    const isUninstall = subArgs.includes("--uninstall")  || subArgs.includes("-u");
    const isHelp      = subArgs.includes("--help")       || subArgs.includes("-h");

    if (isHelp) {
      console.log(`
failproofai policies — manage Failproof AI policies

USAGE
  failproofai policies                       List all policies and their status
  failproofai policies --install, -i         Enable policies
  failproofai policies --uninstall, -u       Disable policies or remove hooks

OPTIONS (install)
  [names...]                     Specific policy names to enable (omit for interactive)
  --cli claude|codex|copilot|cursor|opencode|pi|hermes|openclaw|factory|devin|antigravity|goose
                                 Agent CLI(s) to install for; space-separated
                                 (e.g. --cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose) or repeated.
                                 Omit to detect installed CLIs and prompt (or
                                 auto-pick if only one is found).
  --scope user|project|local     Config scope to write to (default: user)
                                 (Codex / Copilot / Cursor / OpenCode / Pi support user|project only)
  --beta                         Include beta policies
  --custom, -c <path>            Custom policy file (repeat for multiple files)
                                 (skips interactive prompt; validates file first)

OPTIONS (uninstall)
  [names...]                     Specific policy names to disable (omit to remove hooks)
  --cli claude|codex|copilot|cursor|opencode|pi|hermes|openclaw|factory|devin|antigravity|goose
                                 Agent CLI(s) to uninstall from
  --scope user|project|local|all Config scope to remove from (default: user)
  --beta                         Remove only beta policies
  --custom, -c                   Clear all explicit custom policy paths

EXAMPLES
  failproofai policies
  failproofai policies --install
  failproofai policies --install block-sudo sanitize-api-keys
  failproofai policies --install --cli codex --scope project
  failproofai policies --install --cli copilot --scope project
  failproofai policies --install --cli cursor --scope project
  failproofai policies --install --cli opencode --scope project
  failproofai policies --install --cli pi --scope project
  failproofai policies --install --cli factory --scope project
  failproofai policies --install --cli devin --scope project
  failproofai policies --install --cli claude codex copilot cursor opencode pi hermes openclaw factory devin antigravity goose
  failproofai policies --install --custom ./my-policies.js
  failproofai policies --install --custom ./security.js --custom ./workflow.js
  failproofai policies -i -c ./my-policies.js
  failproofai policies --uninstall block-sudo
  failproofai policies --uninstall --cli codex
  failproofai policies --uninstall --cli copilot
  failproofai policies --uninstall --cli cursor
  failproofai policies --uninstall --cli opencode
  failproofai policies --uninstall --cli pi
  failproofai policies -u
  failproofai policies --uninstall --custom
`.trimStart());
      process.exit(0);
    }

    if (isInstall) {
      lastSubcommand = "install";
      const { installHooks } = await import("../src/hooks/manager");
      const { resolveTargetClis } = await import("../src/hooks/install-prompt");

      const scopeIdx = subArgs.indexOf("--scope");
      const scope = scopeIdx >= 0 ? subArgs[scopeIdx + 1] : "user";
      if (scopeIdx >= 0 && (!scope || scope.startsWith("-"))) {
        throw new CliError("Missing value for --scope. Valid values: user, project, local");
      }
      if (scopeIdx >= 0 && !["user", "project", "local"].includes(scope)) {
        throw new CliError(`Invalid scope: ${scope}. Valid values: user, project, local`);
      }

      const customIdxs = subArgs
        .map((arg, index) => (arg === "--custom" || arg === "-c" ? index : -1))
        .filter((index) => index >= 0);
      const customPoliciesPaths = customIdxs.map((index) => subArgs[index + 1]);
      if (customPoliciesPaths.some((path) => !path || path.startsWith("-"))) {
        throw new CliError("Missing path after --custom/-c\nUsage: --custom <path>  (e.g. --custom ./my-policies.js)");
      }

      // --cli accepts one or more space-separated values, optionally repeated:
      //   --cli claude codex copilot
      //   --cli claude --cli codex
      // Values are consumed greedily until the next flag or end of argv.
      const VALID_CLIS = new Set(["claude", "codex", "copilot", "cursor", "opencode", "pi", "hermes", "openclaw", "factory", "devin", "antigravity", "goose"]);
      const cliFlagValues = [];
      const cliConsumedIdxs = new Set();
      const cliFlagIdxs = subArgs.map((a, i) => (a === "--cli" ? i : -1)).filter((i) => i >= 0);
      for (const idx of cliFlagIdxs) {
        let consumed = 0;
        for (let j = idx + 1; j < subArgs.length; j++) {
          const v = subArgs[j];
          if (v.startsWith("-")) break;
          // Stop at the first non-CLI token so a policy name following --cli
          // (e.g. `--cli claude block-sudo`) is not mis-consumed as a CLI.
          if (!VALID_CLIS.has(v)) break;
          cliFlagValues.push(v);
          cliConsumedIdxs.add(j);
          consumed++;
        }
        if (consumed === 0) {
          throw new CliError("Missing value(s) for --cli. Usage: --cli claude codex copilot cursor opencode pi hermes openclaw (or any subset)");
        }
      }

      const includeBeta = subArgs.includes("--beta");

      // Collect positional policy names — args that don't start with - and aren't
      // values consumed by --scope, --custom/-c, or --cli (tracked by index, not value,
      // so a policy named "user" isn't incorrectly dropped by the default scope).
      const consumedIdxs = new Set();
      if (scopeIdx >= 0) consumedIdxs.add(scopeIdx + 1);
      for (const customIdx of customIdxs) consumedIdxs.add(customIdx + 1);
      for (const i of cliConsumedIdxs) consumedIdxs.add(i);
      const flags = new Set(["--install", "-i", "--scope", "--beta", "--custom", "-c", "--cli"]);
      const unknownInstallFlag = subArgs.find((a) => a.startsWith("-") && !flags.has(a));
      if (unknownInstallFlag) {
        throw new CliError(`Unknown flag: ${unknownInstallFlag}\nRun \`failproofai policies --help\` for usage.`);
      }

      const explicitPolicyNames = subArgs.filter(
        (a, idx) => !a.startsWith("-") && !consumedIdxs.has(idx)
      );

      // When --custom/-c is present but no explicit policy names, pass [] so
      // installHooks uses the existing enabled policies and skips the interactive
      // prompt — validation of the custom file happens inside installHooks.
      const policyNames =
        explicitPolicyNames.length > 0 ? explicitPolicyNames
        : customPoliciesPaths.length > 0 ? []
        : undefined;

      const cli = await resolveTargetClis(
        cliFlagValues.length > 0 ? cliFlagValues : undefined,
        "install",
      );

      await installHooks(
        policyNames,
        scope,
        undefined,
        includeBeta,
        undefined,
        customPoliciesPaths.length > 0 ? customPoliciesPaths : undefined,
        false,
        cli,
      );
      await track("cli_install_success", {
        scope,
        cli,
        cli_count: cli.length,
        explicit_policies: explicitPolicyNames.length > 0,
        include_beta: includeBeta,
        has_custom_path: customPoliciesPaths.length > 0,
      });
      process.exit(0);
    }

    if (isUninstall) {
      lastSubcommand = "uninstall";
      const { removeHooks } = await import("../src/hooks/manager");
      const { resolveTargetClis } = await import("../src/hooks/install-prompt");

      const scopeIdx = subArgs.indexOf("--scope");
      const scope = scopeIdx >= 0 ? subArgs[scopeIdx + 1] : "user";
      if (scopeIdx >= 0 && (!scope || scope.startsWith("-"))) {
        throw new CliError("Missing value for --scope. Valid values: user, project, local, all");
      }
      if (scopeIdx >= 0 && !["user", "project", "local", "all"].includes(scope)) {
        throw new CliError(`Invalid scope: ${scope}. Valid values: user, project, local, all`);
      }

      // --cli accepts one or more space-separated values; same parser as install.
      const VALID_CLIS = new Set(["claude", "codex", "copilot", "cursor", "opencode", "pi", "hermes", "openclaw", "factory", "devin", "antigravity", "goose"]);
      const cliFlagValues = [];
      const cliConsumedIdxs = new Set();
      const cliFlagIdxs = subArgs.map((a, i) => (a === "--cli" ? i : -1)).filter((i) => i >= 0);
      for (const idx of cliFlagIdxs) {
        let consumed = 0;
        for (let j = idx + 1; j < subArgs.length; j++) {
          const v = subArgs[j];
          if (v.startsWith("-")) break;
          // Stop at the first non-CLI token so a policy name following --cli
          // (e.g. `--cli claude block-sudo`) is not mis-consumed as a CLI.
          if (!VALID_CLIS.has(v)) break;
          cliFlagValues.push(v);
          cliConsumedIdxs.add(j);
          consumed++;
        }
        if (consumed === 0) {
          throw new CliError("Missing value(s) for --cli. Usage: --cli claude codex copilot cursor opencode pi hermes openclaw (or any subset)");
        }
      }

      const betaOnly = subArgs.includes("--beta");
      const removeCustomHooks = subArgs.includes("--custom") || subArgs.includes("-c");

      const consumedIdxs = new Set();
      if (scopeIdx >= 0) consumedIdxs.add(scopeIdx + 1);
      for (const i of cliConsumedIdxs) consumedIdxs.add(i);
      const flags = new Set(["--uninstall", "-u", "--scope", "--beta", "--custom", "-c", "--cli"]);
      const unknownUninstallFlag = subArgs.find((a) => a.startsWith("-") && !flags.has(a));
      if (unknownUninstallFlag) {
        throw new CliError(`Unknown flag: ${unknownUninstallFlag}\nRun \`failproofai policies --help\` for usage.`);
      }

      const policyNames = subArgs.filter(
        (a, idx) => !a.startsWith("-") && !consumedIdxs.has(idx)
      );

      const cli = await resolveTargetClis(
        cliFlagValues.length > 0 ? cliFlagValues : undefined,
        "uninstall",
      );

      await removeHooks(
        policyNames.length > 0 ? policyNames : undefined,
        scope,
        undefined,
        { betaOnly, removeCustomHooks, cli },
      );
      await track("cli_uninstall_success", {
        scope,
        cli,
        cli_count: cli.length,
        beta_only: betaOnly,
        remove_custom_hooks: removeCustomHooks,
        explicit_policies: policyNames.length > 0,
      });
      process.exit(0);
    }

    // Default: list policies
    // Accept --list as a no-op alias (common intuition), reject all other unknown flags
    // and unexpected positional args (e.g. "hi").
    const knownListFlags = new Set(["--install", "-i", "--uninstall", "-u", "--help", "-h", "--list"]);
    const unknownListArg = subArgs.find((a) => a.startsWith("-") && !knownListFlags.has(a));
    if (unknownListArg) {
      throw new CliError(
        `Unknown flag: ${unknownListArg}\n` +
        `Run \`failproofai policies --help\` for usage.`
      );
    }
    const positionalArgs = subArgs.filter((a) => !a.startsWith("-"));
    if (positionalArgs.length > 0) {
      throw new CliError(
        `Unexpected argument: ${positionalArgs[0]}\n` +
        `Run \`failproofai policies --help\` for usage.`
      );
    }

    lastSubcommand = "list";
    const { listHooks } = await import("../src/hooks/manager");
    await listHooks();
    await track("cli_list_invoked", {});
    process.exit(0);
  }

  // auth — email-OTP login flow against the FailproofAI api-server.
  if (args[0] === "auth") {
    lastSubcommand = "auth";
    const { runAuthCli } = await import("../src/auth/cli");
    await runAuthCli(args.slice(1));
    await track("cli_auth_invoked", {
      args_count: args.length - 1,
      subcommand: args[1] ?? "help",
      exit_code: process.exitCode ?? 0,
    });
    process.exit(process.exitCode ?? 0);
  }

  // audit — scan local agent-CLI history, then launch the dashboard at /audit.
  if (args[0] === "audit") {
    lastSubcommand = "audit";
    const { runAuditCli } = await import("../src/audit/cli");
    await runAuditCli(args.slice(1));
    // No process.exit(): on the success path runAuditCli calls launch(), which
    // keeps this process alive running the dashboard. The --help / no-sessions
    // paths exit inside runAuditCli; failures throw a CliError handled below.
    return;
  }

  // policy — single-policy shortcut over `policies --install <name>`.
  //   failproofai policy add <name>     enable one policy (defaults: claude/user)
  //   failproofai policy remove <name>  disable one policy
  // Honors the same --cli / --scope / --beta flags as `policies --install`.
  if (args[0] === "policy") {
    lastSubcommand = "policy";
    const subArgs = args.slice(1);

    if (subArgs.length === 0 || subArgs.includes("--help") || subArgs.includes("-h")) {
      console.log(`
failproofai policy — manage a single FailproofAI policy

USAGE
  failproofai policy add <name>      Enable one policy
  failproofai policy remove <name>   Disable one policy

OPTIONS
  --cli claude|codex|copilot|cursor|opencode|pi|hermes|openclaw|factory|devin|antigravity|goose
                                     Agent CLI(s) to apply to; space-separated or repeated.
                                     Omit to detect installed CLIs and prompt.
  --scope user|project|local         Config scope (default: user)
  --beta                             Allow beta policies

EXAMPLES
  failproofai policy add block-sudo
  failproofai policy add sanitize-api-keys --scope project
  failproofai policy add block-force-push --cli claude codex
  failproofai policy remove block-sudo
`.trimStart());
      process.exit(0);
    }

    const action = subArgs[0];
    if (action !== "add" && action !== "remove") {
      throw new CliError(
        `Unknown policy subcommand: ${action}\n` +
        `Run \`failproofai policy --help\` for usage.`,
      );
    }

    const rest = subArgs.slice(1);

    const scopeIdx = rest.indexOf("--scope");
    const scope = scopeIdx >= 0 ? rest[scopeIdx + 1] : "user";
    if (scopeIdx >= 0 && (!scope || scope.startsWith("-"))) {
      throw new CliError("Missing value for --scope. Valid values: user, project, local");
    }
    const validScopes = action === "remove"
      ? ["user", "project", "local", "all"]
      : ["user", "project", "local"];
    if (scopeIdx >= 0 && !validScopes.includes(scope)) {
      throw new CliError(`Invalid scope: ${scope}. Valid values: ${validScopes.join(", ")}`);
    }

    // --cli accepts one or more space-separated values, optionally repeated.
    const VALID_CLIS = new Set(["claude", "codex", "copilot", "cursor", "opencode", "pi", "hermes", "openclaw", "factory", "devin", "antigravity", "goose"]);
    const cliFlagValues = [];
    const cliConsumedIdxs = new Set();
    const cliFlagIdxs = rest.map((a, i) => (a === "--cli" ? i : -1)).filter((i) => i >= 0);
    for (const idx of cliFlagIdxs) {
      let consumed = 0;
      for (let j = idx + 1; j < rest.length; j++) {
        const v = rest[j];
        if (v.startsWith("-")) break;
        if (!VALID_CLIS.has(v)) break;
        cliFlagValues.push(v);
        cliConsumedIdxs.add(j);
        consumed++;
      }
      if (consumed === 0) {
        throw new CliError("Missing value(s) for --cli. Usage: --cli claude codex copilot cursor opencode pi hermes openclaw (or any subset)");
      }
    }

    const includeBeta = rest.includes("--beta");

    // Reject unknown flags.
    const knownFlags = new Set(["--scope", "--cli", "--beta"]);
    const unknownFlag = rest.find((a) => a.startsWith("-") && !knownFlags.has(a));
    if (unknownFlag) {
      throw new CliError(`Unknown flag: ${unknownFlag}\nRun \`failproofai policy --help\` for usage.`);
    }

    // Positional policy names = anything not consumed by --scope / --cli.
    const consumedIdxs = new Set();
    if (scopeIdx >= 0) consumedIdxs.add(scopeIdx + 1);
    for (const i of cliConsumedIdxs) consumedIdxs.add(i);
    const positional = rest.filter(
      (a, idx) => !a.startsWith("-") && !consumedIdxs.has(idx),
    );

    if (positional.length === 0) {
      throw new CliError(
        `Missing policy name.\n` +
        `Usage: failproofai policy ${action} <name>\n` +
        `Run \`failproofai policies\` to see available names.`,
      );
    }
    if (positional.length > 1) {
      throw new CliError(
        `\`policy ${action}\` takes exactly one policy name (got ${positional.length}).\n` +
        `For multiple policies use \`failproofai policies --${action === "add" ? "install" : "uninstall"} ${positional.join(" ")}\`.`,
      );
    }
    const policyName = positional[0];

    const { resolveTargetClis } = await import("../src/hooks/install-prompt");
    const cli = await resolveTargetClis(
      cliFlagValues.length > 0 ? cliFlagValues : undefined,
      action === "add" ? "install" : "uninstall",
    );

    lastPolicyAction = action;
    if (action === "add") {
      const { installHooks } = await import("../src/hooks/manager");
      await installHooks(
        [policyName],
        scope,
        undefined,
        includeBeta,
        undefined,
        undefined,
        false,
        cli,
      );
      await track("cli_policy_add_success", {
        scope,
        cli,
        cli_count: cli.length,
        policy_name: policyName,
        include_beta: includeBeta,
      });
    } else {
      // `policy remove <name>` always removes the named policy regardless
      // of whether it's beta or not — passing `betaOnly: includeBeta`
      // here was a mislabel that only affected the telemetry field, not
      // the actual remove. Drop the `--beta` semantic for remove and
      // emit beta_only: false unconditionally so dashboards don't see
      // ghost "beta removal" events.
      const { removeHooks } = await import("../src/hooks/manager");
      await removeHooks(
        [policyName],
        scope,
        undefined,
        { betaOnly: false, removeCustomHooks: false, cli },
      );
      await track("cli_policy_remove_success", {
        scope,
        cli,
        cli_count: cli.length,
        policy_name: policyName,
        beta_only: false,
      });
    }
    lastPolicyAction = null;
    process.exit(0);
  }

  // config — the interactive setup launcher (scope, agents, policies).
  // `configure` and `setup` are canonicalized to "config" up top. Running it
  // explicitly does NOT run the post-setup audit (that only fires on first-run
  // onboarding via bare `failproofai`).
  if (args[0] === "config") {
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`
failproofai config — interactive setup

USAGE
  failproofai config             Guided setup: choose scope, agents, and policies
  failproofai configure          Alias for config
  failproofai setup              Alias for config

WHAT IT DOES
  Walks you through 4 quick steps and writes everything for you:
    1. Where      — global (all projects) or just this project
    2. Assistants — which agent CLIs to protect (Claude, Codex, ...)
    3. Policies   — presets (combine any), Everything, or a custom pick
    4. Review     — confirms the exact files it will change, then applies

FAILPROOF CLOUD
  failproofai config --connect <url> --token <key> [--machine-id <id>]
                                    Connect this machine to Failproof Cloud
                                    [--no-transcripts] decisions only, no transcripts
  failproofai config --disconnect   Stop pulling policy and sending activity
  failproofai config --status       Show connection and pause state

  One connection, two capabilities: this machine PULLS centrally-managed
  policies and SENDS what its hooks decided, so the dashboard shows the fleet
  it is enforcing on. Both are checked against the server before anything is
  written, and reported separately — a key carrying policies:pull but not
  events:add connects for policy and says exactly why the dashboard is empty.

  Tokens are stored owner-only in ~/.failproofai/, never in the service unit —
  that file is world-readable. Connecting needs no sudo, and the machine id
  defaults to this host's name.

  Connecting sends BOTH policy decisions and full session transcripts. A
  transcript carries prompts, file contents and whatever was pasted into a
  terminal — that is the point of connecting, and it is stated here rather than
  buried behind a flag nobody finds. Use --no-transcripts for decisions only.

PAUSING ENFORCEMENT (one session, always time-boxed)
  failproofai config --pause         Pause this directory's newest agent session (30m)
  failproofai config --pause 10m     Pause for a given time (max 8h; s/m/h, bare = minutes)
  failproofai config --resume        End the pause early
  failproofai config --status        Show what is paused and when it lifts
    --session <id>                     Target a specific session
    --all                              With --resume, end every active pause

  A pause suspends builtin, custom and convention policies for that session
  only, and always expires on its own. Cloud-managed policies keep enforcing.

  Prefer flags? See \`failproofai policies --help\`.
`.trimStart());
      process.exit(0);
    }
    lastSubcommand = "config";

    // --pause / --resume / --status are non-interactive session actions that
    // share `config`'s surface but not the wizard. They write session state,
    // never the config file — a pause that reached policies-config.json would
    // be committed and outlive the session that asked for it.
    // Cloud enrolment. Deliberately writes a credential file the daemon reads
    // rather than an Environment= line in the service unit: that unit is
    // installed world-readable (0644, /etc/systemd/system), so a token there
    // would be readable by every local user. Keeping it out also means no
    // sudo, and lets an already-installed daemon be connected.
    const connectIdx = args.indexOf("--connect");
    const wantsDisconnect = args.includes("--disconnect");
    if (connectIdx >= 0 || wantsDisconnect) {
      if (connectIdx >= 0 && wantsDisconnect) {
        throw new CliError("--connect and --disconnect cannot be combined.");
      }
      const valueAfter = (flag) => {
        const i = args.indexOf(flag);
        if (i < 0) return undefined;
        const v = args[i + 1];
        if (!v || v.startsWith("-")) throw new CliError(`Missing value after ${flag}.`);
        return v;
      };
      let result;
      if (wantsDisconnect) {
        const { runDisconnectCommand } = await import("../src/hooks/cloud-enrollment-cli");
        result = runDisconnectCommand();
      } else {
        const { hostname } = await import("node:os");
        const { runConnectCommand } = await import("../src/hooks/cloud-enrollment-cli");
        result = await runConnectCommand({
          url: valueAfter("--connect"),
          token: valueAfter("--token"),
          machineId: valueAfter("--machine-id"),
          defaultMachineId: hostname(),
          // Transcripts are what connecting is FOR, so they default on and the
          // disclosure is made at the point of connection rather than hidden
          // behind an opt-in flag most people never discover — a dashboard
          // showing only decisions is the empty-dashboard problem in a
          // different costume. --no-transcripts is the explicit way out, and
          // `failproofai config --status` always says which is in effect.
          sessions: !args.includes("--no-transcripts"),
        });
      }
      for (const line of result.lines) {
        if (result.exitCode === 0) console.log(line);
        else console.error(line);
      }
      await track("cli_cloud_enrollment", {
        action: wantsDisconnect ? "disconnect" : "connect",
        ok: result.exitCode === 0,
      });
      await exitAfterFlush(result.exitCode);
      return;
    }

    const pauseIdx = args.indexOf("--pause");
    const wantsResume = args.includes("--resume");
    const wantsStatus = args.includes("--status");
    if (pauseIdx >= 0 || wantsResume || wantsStatus) {
      const chosen = [pauseIdx >= 0 && "--pause", wantsResume && "--resume", wantsStatus && "--status"].filter(Boolean);
      if (chosen.length > 1) {
        throw new CliError(`${chosen.join(" and ")} cannot be combined.`);
      }
      const sessionIdx = args.indexOf("--session");
      if (sessionIdx >= 0 && !args[sessionIdx + 1]) {
        throw new CliError("Missing session id after --session.");
      }
      // A bare `--pause` takes the default duration, so only treat the next
      // token as a duration when it isn't another flag.
      const next = pauseIdx >= 0 ? args[pauseIdx + 1] : undefined;
      const duration = next && !next.startsWith("-") ? next : undefined;

      const { runPauseCommand } = await import("../src/hooks/session-pause-cli");
      const result = runPauseCommand({
        action: pauseIdx >= 0 ? "pause" : wantsResume ? "resume" : "status",
        duration,
        sessionId: sessionIdx >= 0 ? args[sessionIdx + 1] : undefined,
        all: args.includes("--all"),
        cwd: process.cwd(),
      });
      // `--status` answers "what is this machine's state?", which is both
      // halves: whether enforcement is paused AND whether cloud is connected.
      if (wantsStatus) {
        const { connectionStatusLines } = await import("../src/hooks/cloud-enrollment-cli");
        for (const line of connectionStatusLines()) console.log(line);
        console.log("");
      }
      for (const line of result.lines) {
        if (result.exitCode === 0) console.log(line);
        else console.error(line);
      }
      await track("cli_pause_invoked", {
        action: pauseIdx >= 0 ? "pause" : wantsResume ? "resume" : "status",
        ok: result.exitCode === 0,
        affected: result.affected,
      });
      await exitAfterFlush(result.exitCode);
      return;
    }

    const { runConfigureWizard } = await import("../src/hooks/configure-wizard");
    const result = await runConfigureWizard();
    await track("cli_configure_invoked", {
      applied: result.applied,
      scope: result.scope ?? null,
      cli_count: result.clis?.length ?? 0,
    });
    process.exit(0);
  }

  // Unknown flag guard — must appear after all known-flag branches
  const knownFlags = ["--version", "-v", "--help", "-h", "--hook"];
  const unknownFlag = args.find(a => a.startsWith("-") && !knownFlags.includes(a));

  if (unknownFlag) {
    function levenshtein(a, b) {
      const m = a.length, n = b.length;
      const dp = Array.from({ length: m + 1 }, (_, i) =>
        Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
      );
      for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
          dp[i][j] = a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      return dp[m][n];
    }

    const primary = ["--version", "--help", "--hook", "policies", "policy", "auth", "audit"];
    const closest = primary.reduce((best, flag) => {
      const dist = levenshtein(unknownFlag, flag);
      return dist < best.dist ? { flag, dist } : best;
    }, { flag: primary[0], dist: Infinity });

    throw new CliError(
      `Unknown flag: ${unknownFlag}\n` +
      `Did you mean: ${closest.flag}?\n` +
      `Run \`failproofai --help\` for usage details.`
    );
  }

  // Unknown subcommand guard (non-flag args that aren't a known subcommand)
  const unknownSubcommand = args.find(a => !a.startsWith("-") && !SUBCOMMANDS.includes(a));
  if (unknownSubcommand) {
    throw new CliError(
      `Unknown command: ${unknownSubcommand}\n` +
      `Did you mean: failproofai policies?\n` +
      `Run \`failproofai --help\` for usage details.`
    );
  }

  // Dashboard launch — always production mode. Runs on every bare `failproofai`
  // (first-run onboarding, if any, already ran above).
  const { launch } = await import("../scripts/launch");
  launch("start");
}

// ── Import CliError for use in the guard above ────────────────────────────────
const { CliError } = await import("../src/cli-error");

// ── Run ───────────────────────────────────────────────────────────────────────
try {
  await runCli();
} catch (err) {
  if (err instanceof CliError) {
    if (lastSubcommand === "install") {
      await track("cli_install_failure", { error_type: "cli_error", exit_code: err.exitCode });
    } else if (lastSubcommand === "uninstall") {
      await track("cli_uninstall_failure", { error_type: "cli_error", exit_code: err.exitCode });
    } else if (lastSubcommand === "policy" && lastPolicyAction) {
      // Mid-action failure: `policy add|remove` parsed but installHooks /
      // removeHooks threw a CliError (e.g. unknown policy name, invalid scope).
      await track(`cli_policy_${lastPolicyAction}_failure`, {
        error_type: "cli_error",
        exit_code: err.exitCode,
      });
    } else {
      await track("cli_parse_error", {
        subcommand: lastSubcommand ?? (args[0] ?? null),
        exit_code: err.exitCode,
      });
    }
    console.error(`Error: ${err.message}`);
    process.exit(err.exitCode);
  }
  // Unexpected internal error — show message only, no stack trace
  const msg = err instanceof Error ? err.message : String(err);
  if (lastSubcommand === "install") {
    await track("cli_install_failure", { error_type: err instanceof Error ? err.name : "unknown" });
  } else if (lastSubcommand === "uninstall") {
    await track("cli_uninstall_failure", { error_type: err instanceof Error ? err.name : "unknown" });
  } else if (lastSubcommand === "policy" && lastPolicyAction) {
    await track(`cli_policy_${lastPolicyAction}_failure`, {
      error_type: err instanceof Error ? err.name : "unknown",
    });
  } else {
    await track("cli_unexpected_error", {
      subcommand: lastSubcommand ?? (args[0] ?? null),
      error_type: err instanceof Error ? err.name : "unknown",
    });
  }
  console.error(`Unexpected error: ${msg}`);
  process.exit(2);
}
