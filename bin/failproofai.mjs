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
  const SUBCOMMANDS = ["policies", "audit"];
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

  audit  (beta)                  Scan past agent CLI transcripts and count
                                   "stupid behaviors" (env-var checks, force
                                   pushes, redundant cd <cwd>, sleep loops,
                                   etc.) per policy / audit detector.
                                   Going live shortly — flags + output may
                                   still change between beta releases.
    --cli claude|codex|copilot|cursor|opencode|pi|gemini
                                   Restrict to one or more CLIs (default: all).
    --project <path>               Restrict to one cwd (repeatable).
    --since 7d|2026-04-01          Only sessions whose mtime is within window.
    --policy <name>                Restrict to one policy/detector (repeatable).
    --limit N                      Top-N rows in the table (default 20).
    --show-examples                Include one example per row.
    --report <path>                Markdown report path (default ./failproofai-audit.md).
    --no-report                    Skip writing the markdown file.
    --json                         Print JSON to stdout instead of the table.
    --no-cache                     Bypass the per-transcript cache.
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
  📖 Docs:         https://befailproof.ai
  💬 Slack:        https://join.slack.com/t/failproofai/shared_invite/zt-3v63b7k5e-O3NBHmj8X6n9gZSGDx6ggQ
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

  // audit — scan past transcripts for "stupid behaviors" caught by builtin
  // policies + a set of audit-only detectors.
  if (args[0] === "audit") {
    const subArgs = args.slice(1);

    if (subArgs.includes("--help") || subArgs.includes("-h")) {
      console.log(`
failproofai audit (beta) — scan past agent transcripts for stupid behaviors

  NOTE: This command is in beta. Flags, output format, and the audit-only
  detector catalog may change before the next stable cut. Going live shortly.

USAGE
  failproofai audit [options]

OPTIONS
  --cli claude|codex|copilot|cursor|opencode|pi|gemini
                                 Restrict to one or more CLIs (space-separated or repeated).
                                 Default: scan all 7.
  --project <path>               Restrict to sessions whose cwd matches this path. Repeatable.
  --since 7d|30d|2026-04-01      Only sessions whose mtime is within window.
  --policy <name>                Restrict to one policy/detector name. Repeatable.
  --limit N                      Top-N rows in the table (default 20).
  --show-examples                Include one example command per row in the table.
  --report <path>                Markdown report path (default: ./failproofai-audit.md).
  --no-report                    Skip writing the markdown report.
  --json                         Print JSON to stdout instead of the table.
  --no-cache                     Bypass the per-transcript result cache.
  --help, -h                     Show this help

EXAMPLES
  failproofai audit
  failproofai audit --cli claude --since 30d
  failproofai audit --policy protect-env-vars --policy block-force-push
  failproofai audit --json > audit.json
  failproofai audit --project /home/me/myrepo --show-examples
`.trimStart());
      process.exit(0);
    }

    const VALID_CLIS = new Set(["claude", "codex", "copilot", "cursor", "opencode", "pi", "gemini"]);
    /** Consume one or more values for a flag like `--cli a b c`, stopping at
     *  the next flag or an unknown token (when an allow-set is supplied).
     *  Throws when the flag appears with zero following values — a bare
     *  `--cli` would otherwise silently widen the scope to all CLIs. */
    function collectMulti(flag, allowSet) {
      const out = [];
      const consumed = new Set();
      for (let i = 0; i < subArgs.length; i++) {
        if (subArgs[i] !== flag) continue;
        let seenForThisFlag = 0;
        for (let j = i + 1; j < subArgs.length; j++) {
          const v = subArgs[j];
          if (v.startsWith("-")) break;
          if (allowSet && !allowSet.has(v)) break;
          out.push(v);
          consumed.add(j);
          seenForThisFlag++;
        }
        consumed.add(i);
        if (seenForThisFlag === 0) {
          throw new CliError(`Missing value(s) for ${flag}`);
        }
      }
      return { values: out, consumed };
    }
    /** Take the single value following a one-shot flag like `--since 7d`. */
    function takeOne(flag) {
      const i = subArgs.indexOf(flag);
      if (i < 0) return { value: undefined, consumed: new Set() };
      const v = subArgs[i + 1];
      if (v === undefined || v.startsWith("-")) {
        throw new CliError(`Missing value for ${flag}`);
      }
      return { value: v, consumed: new Set([i, i + 1]) };
    }

    const allConsumed = new Set();
    const cliRes = collectMulti("--cli", VALID_CLIS);
    cliRes.consumed.forEach((i) => allConsumed.add(i));
    const projectRes = collectMulti("--project", null);
    projectRes.consumed.forEach((i) => allConsumed.add(i));
    const policyRes = collectMulti("--policy", null);
    policyRes.consumed.forEach((i) => allConsumed.add(i));
    const sinceRes = takeOne("--since");
    sinceRes.consumed.forEach((i) => allConsumed.add(i));
    const limitRes = takeOne("--limit");
    limitRes.consumed.forEach((i) => allConsumed.add(i));
    const reportRes = takeOne("--report");
    reportRes.consumed.forEach((i) => allConsumed.add(i));

    const showExamples = subArgs.includes("--show-examples");
    if (showExamples) allConsumed.add(subArgs.indexOf("--show-examples"));
    const noReport = subArgs.includes("--no-report");
    if (noReport) allConsumed.add(subArgs.indexOf("--no-report"));
    const jsonOut = subArgs.includes("--json");
    if (jsonOut) allConsumed.add(subArgs.indexOf("--json"));
    const noCache = subArgs.includes("--no-cache");
    if (noCache) allConsumed.add(subArgs.indexOf("--no-cache"));

    // Reject unknown flags / positional args.
    for (let i = 0; i < subArgs.length; i++) {
      if (allConsumed.has(i)) continue;
      const arg = subArgs[i];
      throw new CliError(
        `Unexpected argument: ${arg}\nRun \`failproofai audit --help\` for usage.`,
      );
    }

    let parsedLimit;
    if (limitRes.value !== undefined) {
      parsedLimit = parseInt(limitRes.value, 10);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        throw new CliError(`Invalid value for --limit: "${limitRes.value}". Use a positive integer.`);
      }
    }
    const opts = {
      clis: cliRes.values.length > 0 ? cliRes.values : undefined,
      projects: projectRes.values.length > 0 ? projectRes.values : undefined,
      policies: policyRes.values.length > 0 ? policyRes.values : undefined,
      since: sinceRes.value,
      limit: parsedLimit,
      showExamples,
      reportPath: reportRes.value ?? "./failproofai-audit.md",
      noReport: noReport || jsonOut, // --json implies --no-report unless explicit --report
      json: jsonOut,
      noCache,
    };
    // Re-enable report when --report was passed alongside --json.
    if (jsonOut && reportRes.value) opts.noReport = false;

    const { runAudit } = await import("../src/audit");
    const { formatText, formatJson, formatMarkdown } = await import("../src/audit/report");
    const result = await runAudit(opts);

    if (jsonOut) {
      process.stdout.write(formatJson(result) + "\n");
    } else {
      process.stdout.write(formatText(result, opts));
    }

    if (!opts.noReport) {
      const { writeFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const reportPath = resolve(opts.reportPath);
      writeFileSync(reportPath, formatMarkdown(result), "utf-8");
      if (!jsonOut) process.stdout.write(`\nReport written: ${reportPath}\n`);
    }

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

    const primary = ["--version", "--help", "--hook", "policies", "audit"];
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
  } else {
    await track("cli_unexpected_error", {
      subcommand: lastSubcommand ?? (args[0] ?? null),
      error_type: err instanceof Error ? err.name : "unknown",
    });
  }
  console.error(`Unexpected error: ${msg}`);
  process.exit(2);
}
