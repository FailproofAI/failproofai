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

// --hook <event> [--cli <name>] — called by an agent CLI hook; fast path, outside
// runCli() because it has its own exit code contract with the calling agent.
const hookIdx = args.indexOf("--hook");
if (hookIdx >= 0) {
  if (!args[hookIdx + 1]) {
    console.error("Error: Missing event type after --hook");
    console.error("Usage: failproofai --hook <event> [--cli <claude|codex|copilot|cursor|opencode|pi|gemini>]");
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
      || cliArg === "gemini"
    )
      ? cliArg
      : "claude";
  try {
    const { handleHookEvent } = await import("../src/hooks/handler");
    const exitCode = await handleHookEvent(eventType, cli);
    process.exit(exitCode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await track("hook_dispatch_error", {
      event_type: eventType,
      cli,
      error_type: err instanceof Error ? err.name : "unknown",
    });
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
  // --help / -h  (only when not inside a subcommand that handles its own --help)
  const SUBCOMMANDS = ["policies", "policy", "auth", "audit"];
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

  policy add <name>              Enable a single policy (see \`policy --help\`)
  policy remove <name>           Disable a single policy

  policies, p                    List all available policies and their status
  policies --install, -i         Enable policies in agent CLI settings
    [names...]                     Specific policy names to enable
    --cli claude|codex|copilot|cursor|opencode|pi|gemini
                                   Agent CLI(s) to install for; space-separated
                                   (e.g. --cli claude codex copilot cursor opencode pi gemini) or repeated.
                                   Default: detect installed CLIs and prompt.
    --scope user|project|local     Config scope to write to (default: user)
                                   (Codex / Copilot / Cursor / OpenCode / Pi / Gemini support user|project only)
    --beta                         Include beta policies
    --custom, -c <path>            Path to a JS file of custom policies

  policies --uninstall, -u       Disable policies or remove hooks
    [names...]                     Specific policy names to disable
    --cli claude|codex|copilot|cursor|opencode|pi|gemini
                                   Agent CLI(s) to uninstall from
    --scope user|project|local|all Config scope to remove from (default: user)
    --beta                         Remove only beta policies
    --custom, -c                   Clear the customPoliciesPath from config

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
  failproofai policies --install --cli gemini --scope project
  failproofai policies --install --cli claude codex copilot cursor opencode pi gemini
  failproofai policies --install --custom ./my-policies.js
  failproofai policies -i -c ./my-policies.js
  failproofai policies --uninstall block-sudo
  failproofai policies --uninstall --cli codex
  failproofai policies --uninstall --cli copilot
  failproofai policies --uninstall --cli cursor
  failproofai policies --uninstall --cli opencode
  failproofai policies --uninstall --cli pi
  failproofai policies --uninstall --cli gemini
  failproofai policies --uninstall --custom

LINKS
  ⭐ Star us:      https://github.com/failproofai/failproofai
  📖 Docs:         https://docs.befailproof.ai/introduction
  💬 Discord:      https://discord.gg/2zjBZP7yQJ
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
  --cli claude|codex|copilot|cursor|opencode|pi|gemini
                                 Agent CLI(s) to install for; space-separated
                                 (e.g. --cli claude codex copilot cursor opencode pi gemini) or repeated.
                                 Omit to detect installed CLIs and prompt (or
                                 auto-pick if only one is found).
  --scope user|project|local     Config scope to write to (default: user)
                                 (Codex / Copilot / Cursor / OpenCode / Pi / Gemini support user|project only)
  --beta                         Include beta policies
  --custom, -c <path>            Path to a JS file of custom policies
                                 (skips interactive prompt; validates file first)

OPTIONS (uninstall)
  [names...]                     Specific policy names to disable (omit to remove hooks)
  --cli claude|codex|copilot|cursor|opencode|pi|gemini
                                 Agent CLI(s) to uninstall from
  --scope user|project|local|all Config scope to remove from (default: user)
  --beta                         Remove only beta policies
  --custom, -c                   Clear the customPoliciesPath from config

EXAMPLES
  failproofai policies
  failproofai policies --install
  failproofai policies --install block-sudo sanitize-api-keys
  failproofai policies --install --cli codex --scope project
  failproofai policies --install --cli copilot --scope project
  failproofai policies --install --cli cursor --scope project
  failproofai policies --install --cli opencode --scope project
  failproofai policies --install --cli pi --scope project
  failproofai policies --install --cli gemini --scope project
  failproofai policies --install --cli claude codex copilot cursor opencode pi gemini
  failproofai policies --install --custom ./my-policies.js
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

      const customIdx = subArgs.includes("--custom") ? subArgs.indexOf("--custom")
                      : subArgs.includes("-c")        ? subArgs.indexOf("-c")
                      : -1;
      const customPoliciesPath = customIdx >= 0 ? subArgs[customIdx + 1] : undefined;
      if (customIdx >= 0 && (!customPoliciesPath || customPoliciesPath.startsWith("-"))) {
        throw new CliError("Missing path after --custom/-c\nUsage: --custom <path>  (e.g. --custom ./my-policies.js)");
      }

      // --cli accepts one or more space-separated values, optionally repeated:
      //   --cli claude codex copilot
      //   --cli claude --cli codex
      // Values are consumed greedily until the next flag or end of argv.
      const VALID_CLIS = new Set(["claude", "codex", "copilot", "cursor", "opencode", "pi", "gemini"]);
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
          throw new CliError("Missing value(s) for --cli. Usage: --cli claude codex copilot cursor opencode pi gemini (or any subset)");
        }
      }

      const includeBeta = subArgs.includes("--beta");

      // Collect positional policy names — args that don't start with - and aren't
      // values consumed by --scope, --custom/-c, or --cli (tracked by index, not value,
      // so a policy named "user" isn't incorrectly dropped by the default scope).
      const consumedIdxs = new Set();
      if (scopeIdx >= 0) consumedIdxs.add(scopeIdx + 1);
      if (customIdx >= 0) consumedIdxs.add(customIdx + 1);
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
        : customPoliciesPath !== undefined ? []
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
        customPoliciesPath,
        false,
        cli,
      );
      await track("cli_install_success", {
        scope,
        cli,
        cli_count: cli.length,
        explicit_policies: explicitPolicyNames.length > 0,
        include_beta: includeBeta,
        has_custom_path: !!customPoliciesPath,
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
      const VALID_CLIS = new Set(["claude", "codex", "copilot", "cursor", "opencode", "pi", "gemini"]);
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
          throw new CliError("Missing value(s) for --cli. Usage: --cli claude codex copilot cursor opencode pi gemini (or any subset)");
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
  --cli claude|codex|copilot|cursor|opencode|pi|gemini
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
    const VALID_CLIS = new Set(["claude", "codex", "copilot", "cursor", "opencode", "pi", "gemini"]);
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
        throw new CliError("Missing value(s) for --cli. Usage: --cli claude codex copilot cursor opencode pi gemini (or any subset)");
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

  // First-run nudge — only on truly bare `failproofai` invocations. Best-effort:
  // any thrown error must not block the dashboard from launching.
  if (args.length === 0) {
    try {
      const { maybeRunFirstRunNudge } = await import("../src/hooks/first-run-nudge");
      await maybeRunFirstRunNudge();
    } catch {
      // Nudge is non-critical; fall through to dashboard.
    }
  }

  // Dashboard launch — always production mode
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
