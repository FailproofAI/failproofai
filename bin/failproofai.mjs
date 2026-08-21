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

      // On a daemon-configured machine the daemon is the ONLY evaluator. Every
      // way of not getting an answer from it denies, and in-process evaluation
      // is never reached from this branch — that is what "all enforcement is
      // routed through the daemon" means, and a fallback here would be a second
      // policy engine reachable by breaking the first.
      //
      // The two failures still differ in what the USER has to do, so they are
      // told apart in the message and nowhere else:
      //
      //   protocol-mismatch: a daemon answered, so it is alive; the CLI and the
      //     daemon are different versions, which is what an `npm update` that
      //     has not been followed by `failproofai config` looks like. The remedy
      //     is an upgrade, and naming it is the difference between a one-command
      //     fix and a support ticket. `daemonVersionSkew()` has already been
      //     hinting this on every CLI command.
      //
      //   unreachable: nothing answered. A stopped service, a deleted socket and
      //     deliberate tampering are indistinguishable from here — and a machine
      //     where stopping one service silently disables every guardrail is not
      //     a guarded machine.
      let result;
      if (attempt.ok) {
        result = attempt.response;
      } else {
        const reason =
          attempt.failure === "protocol-mismatch"
            ? "failproofaid is running a different protocol version than this CLI, so it " +
              "cannot evaluate this call. Run `failproofai config` to update the daemon."
            : "failproofaid could not be reached. This machine is configured to run hooks through it " +
              "— check the daemon (see `failproofai config`) rather than retrying blindly.";
        result = await evaluateHookEvent(eventType, cli, stdinRead.payload, {
          forceDecision: { decision: "deny", reason },
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

    // The outer fail-closed boundary. This wrote NOTHING to stdout and exited 2,
    // which is a deny for Claude and Factory's non-Stop events and a silent
    // ALLOW for the eight CLIs that read their verdict from stdout JSON —
    // Cursor, Pi, Hermes, OpenClaw, Devin, Antigravity, Goose, and Factory's
    // Stop. Everything above can land here, INCLUDING the forced-deny call that
    // handles an unreachable daemon, so the one path whose entire job is to fail
    // closed failed open instead.
    //
    // Emitted BEFORE any telemetry: `flushHookTelemetry` loops until its queue
    // drains and is not bounded, so draining first meant a stuck send could hold
    // the verdict back indefinitely — and a verdict that arrives after the agent
    // has moved on is the same as no verdict.
    const reason =
      "failproofai could not evaluate this call and is failing closed. " +
      `Check the failproofai installation (\`failproofai config\`). Underlying error: ${msg}`;
    let emitted = false;
    let denyExitCode = 2;
    try {
      // The real evaluator does the shaping, exactly as the unreachable-daemon
      // path above does — that is what keeps this deny from being inert on some
      // CLI whose contract nobody remembered here. It can only work if the
      // handler module is loadable, which is why the fallback below exists.
      const { evaluateHookEvent } = await import("../src/hooks/handler");
      const forced = await evaluateHookEvent(eventType, cli, "", {
        forceDecision: { decision: "deny", reason },
      });
      if (forced.stdout) process.stdout.write(forced.stdout);
      if (forced.stderr) process.stderr.write(forced.stderr);
      emitted = true;
      denyExitCode = forced.exitCode;
    } catch {
      // Last ditch: the module that knows each CLI's exact deny shape is itself
      // the thing that just failed, so this emits the union of them — every CLI
      // reads only the keys it knows and ignores the rest. Deliberately NOT a
      // per-CLI table: a second copy of those twelve contracts would drift from
      // the real one, and this runs only when the install is already broken.
      // Imperfect enforcement beats the zero bytes that were written before.
      try {
        process.stdout.write(
          JSON.stringify({
            decision: "block",
            reason,
            permission: "deny",
            followup_message: reason,
            hookSpecificOutput: {
              hookEventName: eventType,
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          }),
        );
        emitted = true;
      } catch {}
    }
    if (!emitted) console.error(`Unexpected error: ${msg}`);
    else console.error(`[failproofai] failing closed: ${msg}`);

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
    // `exitAfterFlush`, not a bare `process.exit`: this was the one exit in
    // `--hook` handling that skipped it, so under load `process.exit` could
    // truncate the very bytes carrying the deny.
    await exitAfterFlush(denyExitCode);
  }
}

/**
 * Centralised error handler for all CLI subcommands.
 * CliError  → clean message, no stack trace, exit exitCode (1 or 2)
 * Error     → unexpected; shows message only, exits 2
 */
async function runCli() {
  // --help / -h  (only when not inside a subcommand that handles its own --help)
  const SUBCOMMANDS = ["policies", "policy", "audit", "config", "uninstall", "backfill", "flush", "harness", "pack"];
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
    --connect <url> --token <key>  Connect to FailproofAI Cloud non-interactively
    --machine-id <id>              Stable id for this machine
    --machine-label <name>         Human-readable name in the dashboard
    --no-transcripts               Report decisions only, never transcripts
    --disconnect                   Stop pulling policy and sending activity
    --status                       Show connection, daemon and pause state
    --pause / --resume             Pause or resume enforcement

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

  pack list                      Show installed policy packs
  pack add <owner/repo@tag>      Install a policy pack from a GitHub release
  pack remove <publisher/name>   Deactivate an installed pack
  harness list                   Show extra capture paths per agent CLI
  harness add-path <h> <path>    Also capture sessions from <path> for harness
                                 <h>. Accepts \`<label>=<path>\`; the label
                                 namespaces agent ids so two copies of one
                                 project stay distinct.
  harness remove-path <h> <p>    Stop capturing that path
  harness --help, -h             Show this help for the harness command

  audit                          Audit your agent's behavior, then open the
                                 dashboard at http://localhost:8020/audit
  audit --schedule [days]        Audit on a timer (default 7 days) and email you
                                 what it finds. Signs you in the first time;
                                 --email <address> skips that question
  audit --no-schedule            Stop auditing on a timer
  audit --status                 Whether scheduling is on, where reports go, and
                                 when the next scan is due
  audit --help, -h               Show this help for the audit command

  backfill                       Re-send history the collector already read past
                                 — after clearing the dashboard, re-enrolling a
                                 machine, or connecting later than the work
    --since <when>                 How far back: 30d, 6m, or YYYY-MM-DD
                                   (default: 30 days)
    --dry-run                      Report what would be re-read, change nothing

  flush                          Deliver everything already spooled, now,
                                 instead of waiting for the next sweep
    --wait                         Block until the spool drains (or --timeout)
    --timeout <secs>               How long to wait with --wait (default: 60)

  update                         Finish an upgrade npm cannot: migrate
                                 ~/.failproofai to this version's layout, put the
                                 matching daemon binary in place, restart it.
                                 Run after \`npm install -g failproofai@latest\`.
    --no-daemon                    Migrate the home only

  migrate                        Run pending layout migrations on their own,
                                 keyed on the layout in ~/.failproofai/VERSION
                                 (not the npm version, so skipping releases with
                                 no layout change runs nothing)
    --dry-run                      Print the steps and change nothing

  uninstall                      Remove failproofai from this machine: hook
                                 entries from every agent CLI, and the daemon
                                 service. Run this BEFORE \`npm rm -g failproofai\`
                                 — npm runs no uninstall script, so removing the
                                 package alone leaves both behind.
    --purge                        Also delete ~/.failproofai (settings,
                                   credentials, audit history, daemon binary)
    --dry-run                      Show what would be removed, change nothing
    --yes, -y                      Skip the confirmation prompt

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
  failproofai backfill --since 6m
  failproofai backfill --dry-run
  failproofai flush --wait
  failproofai config --status

LINKS
  ⭐ Star us:      https://github.com/failproofai/failproofai
  📖 Docs:         https://docs.befailproof.ai/introduction
  💬 Discord:      https://discord.befailproof.ai/
  👽 Reddit:       https://www.reddit.com/r/failproofai/
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
  //   policies/policy   explicit configuration actions. Intercepting these would
  //                     fight the intent the user just stated, and would break
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
  //
  // `audit --scheduled` is the exception, and it takes the HOOK's branch: it is
  // spawned by failproofaid on a timer, so "visibly, in a real command the user
  // typed" is exactly what it is not. `checkLayoutForCli()` deletes
  // config.toml and credentials.toml (see `resettablePaths`), so letting a
  // background process reach it would silently revoke a user's
  // `[telemetry] enabled = false`, erase their cloud enrolment, and switch off
  // `[audit] auto` — the setting that scheduled the run — with the explanation
  // going only to the service journal. Reachable on every machine at the next
  // LAYOUT_VERSION bump, when a home carrying `auto = true` is by definition
  // stale. Verified live: one scheduled tick took a home's whole config.
  //
  // `--help` / `--version` take the same exemption `first-run-gate.ts` gives
  // them, and for a stronger reason. Those two answer "what is this / how do I
  // use it"; the subcommands that parse their own help (`policies --help`) fall
  // past the help block above and reach here, so without this a user typing
  // `failproofai policies --help` had their home reset by a question. The
  // adjacent, far less destructive first-run gate exempted help from the start.
  {
    const isHelpOrVersion =
      args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-v");
    if (args[0] === "audit" && args.includes("--scheduled")) {
      // NOT `layoutWarningForHook` — that one answers the hook's question
      // ("are policies unenforced?") and deliberately stays quiet when the
      // global config is readable. This gate is about the LAYOUT, and must
      // fire whenever completing the run would reset the home.
      const { layoutBlockerForScheduledRun } = await import("../src/hooks/fp-reset");
      const warning = layoutBlockerForScheduledRun();
      if (warning) {
        // Exit 1, not 75: 75 means "another audit holds the lock" and is retried
        // in fifteen minutes, which here would just re-warn four times an hour
        // forever. A stale home is a real failure that `failproofai config`
        // fixes, so it is reported and retried at the ordinary cadence.
        console.error(warning);
        process.exit(1);
      }
    } else if (!isHelpOrVersion && args[0] !== "migrate" && args[0] !== "update") {
      // `migrate` and `update` are exempt because they ARE this step, and letting
      // it run first breaks them both. `migrate --dry-run` promises to change
      // nothing and print what would happen — with the check ahead of it, the home
      // was already migrated by the time the subcommand looked, so it reported
      // "nothing to migrate" on every stale machine it was ever pointed at, which
      // is the one answer a dry run must never give wrongly. Caught by a smoke
      // test on a seeded layout-2 home, not by a unit test: nothing below the CLI
      // entry point can see this ordering.
      const { checkLayoutForCli } = await import("../src/hooks/fp-reset");
      const check = await checkLayoutForCli();
      for (const line of check.lines) console.error(line);
      if (check.fatal) process.exit(1);
      // `check.didReset` is deliberately not read. It used to force the wizard
      // below; see the note at `shouldOfferFirstRun` for why a migrated machine
      // no longer needs setup re-run, and `didReset` in `fp-reset.ts` for what
      // the field means now.
    }
  }

  // Report a fresh install / upgrade. AFTER the layout check above, never
  // before: this writes the `last-version` marker, and while that file lived at
  // the root of the home it was one of the landmarks `detectLayout()` reads as
  // "layout 1". Running first meant the CLI created the file and then read it
  // back as evidence of an old layout, so every genuinely fresh machine had its
  // very first command open with "failproofai reorganised … Removed 1 item(s)
  // from the old layout." Nothing was lost — there was nothing there — but
  // training every new user to ignore that banner is expensive given what it
  // says on a real layout-1 home. The file has also moved under `state/`, so
  // the two are independent now; the order is kept because it is the correct
  // one regardless.
  //
  // Deliberately not at module scope: everything above the CLI entry is the
  // --hook fast path, which runs on every tool call. No-ops after the first run
  // on a given version.
  try {
    const { maybeReportInstall } = await import("../lib/install-check");
    await maybeReportInstall(version);
  } catch {
    // never block a command on reporting
  }

  const { shouldOfferFirstRun } = await import("../src/hooks/first-run-gate");
  // `|| layoutWasReset` stood here, with `force: layoutWasReset` below, because a
  // migration used to delete the home's policy config while leaving the agent
  // CLIs' settings files alone — so `isConfigured()` read true off
  // `hasGlobalHooks` and setup was skipped, leaving hooks firing against no
  // policies, silently and permanently.
  //
  // The migration keeps that file now (`HOME_CLASSES` classes it `user-typed`),
  // along with `config.json` and `credentials.json`, so a migrated machine is
  // configured in fact and not merely in appearance. Forcing the wizard here
  // would open an interactive prompt with nothing to answer — and on a fleet box,
  // a CI runner or a headless gateway, nobody to answer it. A home that never
  // finished setup still gets here on its own: `isConfigured()` is false for it.
  // See `didReset` in `fp-reset.ts`.
  if (shouldOfferFirstRun(args)) {
    try {
      const { maybeFirstRunConfigure } = await import("../src/hooks/configure-wizard");
      // `audit` runs its own scan immediately after this returns; firing the
      // post-setup audit too would scan the whole history twice in a row.
      await maybeFirstRunConfigure({}, { postSetupAudit: args[0] !== "audit" });
    } catch {
      // Onboarding is never allowed to block the command the user actually typed.
    }
  }

  // backfill [--since <YYYY-MM-DD|Nd>] [--dry-run]
  //
  // Hands off to the daemon rather than doing the work: the cursors it rewinds
  // are held in memory by the RUNNING collector, which would write them back
  // over. Every precondition a person can get wrong is still checked HERE,
  // synchronously, because reporting success and leaving the real failure in the
  // journal is what already cost twenty minutes on a live machine.
  if (args[0] === "flush") {
    const subArgs = args.slice(1);
    if (subArgs.includes("--help") || subArgs.includes("-h")) {
      console.log(`
failproofai flush — deliver what is already spooled, now

USAGE
  failproofai flush [--wait] [--timeout <secs>]

WHY
  The collector is unhurried on purpose: a batch is swept once it is older than
  two minutes, at most 64 per pass, on a 60-second cadence. That pacing keeps a
  backlog from stampeding the server, and it is exactly wrong when you are
  standing at a dashboard waiting to see your own events — "not delivered yet"
  and "not working" look identical from there.

  This asks the daemon to make a pass right now, with no minimum age and no
  per-pass cap. It re-sends nothing: only batches already spooled and not yet
  delivered. For history the collector has already read past, use \`backfill\`.

OPTIONS
  --wait             Block until the spool drains, or --timeout elapses.
  --timeout <secs>   How long --wait waits. Default: 60.
`);
      process.exit(0);
    }

    const KNOWN = new Set(["--wait", "--timeout"]);
    const unknown = subArgs.find(
      (a, i) => a.startsWith("-") && !KNOWN.has(a) && subArgs[i - 1] !== "--timeout",
    );
    if (unknown) {
      throw new CliError(`Unexpected argument: ${unknown}\nRun \`failproofai flush --help\` for usage.`);
    }

    let timeoutSecs;
    const tIdx = subArgs.indexOf("--timeout");
    if (tIdx >= 0) {
      const raw = subArgs[tIdx + 1];
      if (!raw || raw.startsWith("-")) throw new CliError("Missing value after --timeout.");
      const n = Number(raw);
      // Rejected rather than coerced: NaN would silently become "wait forever
      // or not at all" depending on the comparison, and neither is what was asked.
      if (!Number.isFinite(n) || n <= 0) {
        throw new CliError(`Could not read --timeout ${raw}. Give a number of seconds.`);
      }
      timeoutSecs = n;
    }

    lastSubcommand = "flush";
    const { runFlushCommand } = await import("../src/hooks/flush-cli");
    const result = await runFlushCommand({ wait: subArgs.includes("--wait"), timeoutSecs });
    for (const line of result.lines) {
      if (result.exitCode === 0) console.log(line);
      else console.error(line);
    }
    await track("cli_flush", {
      ok: result.exitCode === 0,
      waited: subArgs.includes("--wait"),
      pending: result.pending,
    });
    lastSubcommand = null;
    await exitAfterFlush(result.exitCode);
    return;
  }

  if (args[0] === "backfill") {
    const subArgs = args.slice(1);
    if (subArgs.includes("--help") || subArgs.includes("-h")) {
      console.log(`
failproofai backfill — re-send history the collector has already read past

USAGE
  failproofai backfill [--since <when>] [--dry-run]

WHY
  The collector never re-reads a file it has a cursor for, which is right until
  the dashboard's data is cleared, a machine is re-enrolled, or cursors advanced
  before there was anywhere to send. Then the history exists on disk and nowhere
  else, with no way to ask for it again.

  Re-sending is safe: redaction is deterministic, so a re-sent event hashes
  identically to its first send and collapses into the row already there.

OPTIONS
  --since <when>   How far back. \`30d\`, \`6m\`, or \`YYYY-MM-DD\`.
                   Default: 30 days.
  --dry-run        Report what would be re-read and change nothing.

  Which streams are sent follows [collector] in ~/.failproofai/config.toml —
  a backfill never sends something your config says you do not want.
`);
      process.exit(0);
    }

    const KNOWN = new Set(["--since", "--dry-run"]);
    const unknown = subArgs.find((a, i) => a.startsWith("-") && !KNOWN.has(a) && subArgs[i - 1] !== "--since");
    if (unknown) {
      throw new CliError(`Unexpected argument: ${unknown}\nRun \`failproofai backfill --help\` for usage.`);
    }

    let sinceMs;
    const sinceIdx = subArgs.indexOf("--since");
    if (sinceIdx >= 0) {
      const raw = subArgs[sinceIdx + 1];
      if (!raw || raw.startsWith("-")) throw new CliError("Missing value after --since.");
      // `30d` / `6m` / an ISO date. Rejected rather than guessed at: silently
      // reading an unparseable window as "the default" would send a different
      // amount of history than was asked for, and nothing would say so.
      const rel = /^(\d+)([dmy])$/.exec(raw);
      if (rel) {
        const n = Number(rel[1]);
        const days = rel[2] === "d" ? n : rel[2] === "m" ? n * 30 : n * 365;
        sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
      } else {
        const t = Date.parse(raw);
        if (Number.isNaN(t)) {
          throw new CliError(`Could not read --since ${raw}. Use 30d, 6m, or YYYY-MM-DD.`);
        }
        sinceMs = t;
      }
    }

    lastSubcommand = "backfill";
    const { runBackfillCommand } = await import("../src/hooks/backfill-cli");
    const result = runBackfillCommand({ sinceMs, dryRun: subArgs.includes("--dry-run") });
    for (const line of result.lines) {
      if (result.exitCode === 0) console.log(line);
      else console.error(line);
    }
    await track("cli_backfill", { ok: result.exitCode === 0, dry_run: subArgs.includes("--dry-run"), explicit_since: sinceIdx >= 0 });
    lastSubcommand = null;
    await exitAfterFlush(result.exitCode);
    return;
  }

  // harness list | add-path | remove-path
  //
  // Extra capture paths per harness. Writes ~/.failproofai/config.toml and
  // nothing else — no root, no daemon call — so it works on a machine whose
  // daemon is stopped, which is when someone is most likely to be fixing what
  // it captures.
  // pack list | add | remove
  //
  // Policies that did not ship compiled into this build. Fetches over the
  // network, so it is a CLI command only and is never reachable from the hook
  // path.
  if (args[0] === "pack") {
    const subArgs = args.slice(1);
    if (subArgs[0] === "--help" || subArgs[0] === "-h") {
      console.log(`
failproofai pack — install policy packs published as GitHub releases

Usage:
  failproofai pack list
  failproofai pack add <source> [--only <a,b>]
  failproofai pack remove <publisher/name>

A pack is one entry artifact plus a manifest, verified against the release's
SHA256SUMS at install time. The digest is recorded, and re-verified before every
import — so a pack cannot change under this machine after you installed it.

<source> is any of these — paste whichever you have:
  acme/support-agent                 newest release, pinned to its exact tag
  acme/support-agent@v2.1.0          that release
  github:acme/support-agent@v2.1.0   same, explicit
  https://github.com/acme/support-agent/releases/tag/v2.1.0

Naming no tag installs the newest release AND pins it, so what gets recorded
always names one version — running the same command later can install something
different, and it will tell you the tag it chose.

  --only a,b   Take only these policies from the pack. Re-adding at a newer
               version keeps your selection rather than switching the rest on.

Examples:
  failproofai pack add FailproofAI/policies
  failproofai pack add github:acme/support-agent@v2.1.0 --only block-refunds
  failproofai pack remove acme/support-agent

Offline: FAILPROOFAI_NO_DOWNLOAD=1 refuses to fetch, while packs already
installed keep enforcing.
`.trimStart());
      process.exit(0);
    }

    lastSubcommand = "pack";
    const { runPackCommand } = await import("../src/hooks/pack-cli");
    const result = await runPackCommand(subArgs);
    for (const line of result.lines) {
      if (result.exitCode === 0) console.log(line);
      else console.error(line);
    }
    await track("cli_pack", {
      ok: result.exitCode === 0,
      // The subcommand only — never the pack id, source or policy names. A pack
      // source is a value the user typed, and a third-party pack name is a
      // publisher-controlled string; we send shape, never value.
      sub: ["list", "add", "remove"].includes(subArgs[0]) ? subArgs[0] : "unknown",
    });
    lastSubcommand = null;
    await exitAfterFlush(result.exitCode);
    return;
  }

  if (args[0] === "harness") {
    const subArgs = args.slice(1);
    if (subArgs.length === 0 || subArgs.includes("--help") || subArgs.includes("-h")) {
      console.log(`
failproofai harness — capture sessions from more than one location per agent CLI

USAGE
  failproofai harness list [<harness>]
  failproofai harness add-path <harness> [<label>=]<path>
  failproofai harness remove-path <harness> <path|label>

WHY
  Each agent CLI is watched wherever its own installer put it — ~/.claude/projects,
  ~/.hermes/state.db, and so on. That misses every other arrangement: a second
  profile, a mounted team share, a container's home beside the host's, an agent
  an operator moved. Those hold real sessions and nothing collects them.

THE LABEL
  An entry is \`<path>\` or \`<label>=<path>\`. The label namespaces agent ids as
  <label>-<agentId>, and it matters: two locations holding the same project
  derive the SAME id (it comes from the cwd inside the transcript, identical in
  both copies), so without a label they merge into one agent whose sessions
  interleave from two machines' worth of history. Omit it and one is derived
  from the folder name.

HARNESSES
  claude, codex, copilot, openclaw, pi, factory, antigravity, cursor,
  goose, opencode, devin, hermes

  \`claude\` covers subagent transcripts too — they live under the same root.

NOTES
  • Session collection must be on for any of this to be read; extra paths live
    under "collector" in ~/.failproofai/config.json like the default ones do.
  • A path overlapping one already captured is REFUSED by the daemon at startup
    rather than collected twice under two ids. It says so in the journal.
  • Two entries sharing a LABEL are refused too: they would share one cursor
    directory, whose whole map is written at once, so each would clobber the
    other's watermark and re-read from zero after every restart.
  • Takes effect within seconds — the daemon re-reads config.json on an interval
    and cycles its collector. No restart, no sudo.

EXAMPLES
  failproofai harness add-path claude work=/srv/team/.claude/projects
  failproofai harness add-path hermes prod=/srv/hermes-prod/state.db
  failproofai harness add-path codex /mnt/other-home/.codex/sessions
  failproofai harness list
  failproofai harness remove-path claude work

  One home per person — label them, or both derive the same folder-name label
  and the second is refused:
  failproofai harness add-path openclaw user1=/srv/.openclaw-user1
  failproofai harness add-path openclaw user2=/srv/.openclaw-user2

  Containers: FAILPROOFAI_<HARNESS>_EXTRA_PATHS replaces the file's entries.
  FAILPROOFAI_OPENCLAW_EXTRA_PATHS="user1=/srv/.openclaw-user1,user2=/srv/.openclaw-user2"

`.trimStart());
      process.exit(0);
    }

    lastSubcommand = "harness";
    const { runHarnessCommand } = await import("../src/hooks/harness-cli");
    const result = runHarnessCommand(subArgs);
    for (const line of result.lines) {
      if (result.exitCode === 0) console.log(line);
      else console.error(line);
    }
    await track("cli_harness", {
      ok: result.exitCode === 0,
      // The subcommand only — never the harness name, the label or the path.
      // A path is a value the user typed, and `enterprise-docs/product-analytics.md`
      // promises we send shape, never value.
      sub: ["list", "add-path", "remove-path"].includes(subArgs[0]) ? subArgs[0] : "unknown",
    });
    lastSubcommand = null;
    await exitAfterFlush(result.exitCode);
    return;
  }

  // uninstall [--purge] [--dry-run] [--yes|-y]
  //
  // Top-level, and deliberately NOT a flag on `policies`. `policies --uninstall`
  // disables policies; this removes the product — hook entries across every
  // agent CLI plus the root-owned daemon service — and the two must not be one
  // keystroke apart.
  if (args[0] === "migrate") {
    const subArgs = args.slice(1);
    if (subArgs.includes("--help") || subArgs.includes("-h")) {
      console.log(`
failproofai migrate — bring ~/.failproofai up to the layout this version speaks

USAGE
  failproofai migrate [--dry-run]

WHY
  npm cannot update an installed package on its own, so a machine can sit on an
  old version for months and then jump several layouts at once. This runs the
  steps for that jump in order, keyed on the LAYOUT recorded in
  ~/.failproofai/VERSION rather than on the npm version — so skipping thirty
  releases with no layout change runs nothing at all.

  It normally happens by itself, on the first command after an upgrade. This is
  for running it deliberately, and for seeing what it would do first.

  Your settings, cloud enrolment, policy selection, your own policy files,
  decision history and undelivered events are carried across, not removed. The
  irreplaceable files are copied to migrations/backup-layout<n>/ before anything
  runs, and every step is recorded in migrations/applied.json.

OPTIONS
  --dry-run   Print the steps and the files that would be saved. Change nothing.
`);
      process.exit(0);
    }

    const KNOWN = new Set(["--dry-run"]);
    const unknown = subArgs.find((a) => a.startsWith("-") && !KNOWN.has(a));
    if (unknown) {
      throw new CliError(
        `Unexpected argument: ${unknown}\nRun \`failproofai migrate --help\` for usage.`,
      );
    }

    lastSubcommand = "migrate";
    const { detectLayout } = await import("../src/hooks/fp-config");
    const { LAYOUT_VERSION } = await import("../src/hooks/fp-home");
    const { describePlan, runMigrations } = await import("../src/hooks/migrations");
    const state = detectLayout();

    // A NEWER home is refused here exactly as `checkLayoutForCli` refuses it: the
    // data is fine and an upgrade would read it, so migrating "forward" from it
    // is not a thing that exists.
    if (state.kind === "future") {
      console.error(
        `This machine's failproofai directory was written by a newer version (layout ${state.found};`,
      );
      console.error(`this build speaks ${LAYOUT_VERSION}). Upgrade rather than migrate:`);
      console.error(`  npm install -g failproofai@latest`);
      await track("cli_migrate", { ok: false, reason: "future_layout" });
      lastSubcommand = null;
      await exitAfterFlush(1);
      return;
    }

    const from = state.kind === "stale" ? state.found : LAYOUT_VERSION;
    if (subArgs.includes("--dry-run")) {
      for (const line of describePlan(from)) console.log(line);
      await track("cli_migrate", { ok: true, dry_run: true, from });
      lastSubcommand = null;
      await exitAfterFlush(0);
      return;
    }

    if (state.kind !== "stale") {
      console.log(`Already at layout ${LAYOUT_VERSION}. Nothing to migrate.`);
      await track("cli_migrate", { ok: true, from, steps: 0 });
      lastSubcommand = null;
      await exitAfterFlush(0);
      return;
    }

    const run = runMigrations(from);
    for (const step of run.steps) {
      console.log(`${step.ok ? "migrated" : "FAILED  "} layout ${step.from} → ${step.to}`);
    }
    if (run.backedUp.length > 0) {
      console.log(`Saved first: ${run.backedUp.join(", ")}`);
    }
    if (run.failed) {
      console.error(`Step ${run.failed.from} → ${run.failed.to} did not finish: ${run.failed.error}`);
      console.error(`The home is still marked layout ${from} and will be retried.`);
    }
    await track("cli_migrate", {
      ok: !run.failed,
      from,
      steps: run.steps.length,
      removed: run.outcome.removed.length,
    });
    lastSubcommand = null;
    await exitAfterFlush(run.failed ? 1 : 0);
    return;
  }

  if (args[0] === "update") {
    const subArgs = args.slice(1);
    if (subArgs.includes("--help") || subArgs.includes("-h")) {
      console.log(`
failproofai update — finish an upgrade: migrate the home, match the daemon

USAGE
  npm install -g failproofai@latest && failproofai update [--no-daemon]

WHY
  npm replaces the CLI and nothing else. The daemon binary lives at
  ~/.failproofai/bin/failproofaid-<version> and stays exactly where it was, so
  after an npm upgrade the two halves are different versions — and failproofaid
  refuses to start against a layout it does not speak, which is the loud version
  of that problem rather than the silent one.

  This does the rest of the upgrade: runs any pending layout migrations, puts the
  matching daemon binary in place, and restarts the service.

OPTIONS
  --no-daemon   Migrate the home only. Leaves a version-skewed daemon in place,
                so prefer letting it run.
`);
      process.exit(0);
    }

    const KNOWN = new Set(["--no-daemon"]);
    const unknown = subArgs.find((a) => a.startsWith("-") && !KNOWN.has(a));
    if (unknown) {
      throw new CliError(
        `Unexpected argument: ${unknown}\nRun \`failproofai update --help\` for usage.`,
      );
    }

    lastSubcommand = "update";
    // Runs the migration itself rather than leaning on the check at the top of
    // this file, which this command is exempt from. Reading the ledger and
    // inferring "the top-level check must have done it" was the first version, and
    // it is the kind of indirection that reads fine and reports the wrong thing
    // the moment either half moves.
    const { detectLayout } = await import("../src/hooks/fp-config");
    const { LAYOUT_VERSION } = await import("../src/hooks/fp-home");
    const { runMigrations } = await import("../src/hooks/migrations");
    const state = detectLayout();

    if (state.kind === "future") {
      console.error(
        `This machine's failproofai directory was written by a NEWER version (layout ${state.found};`,
      );
      console.error(`this build speaks ${LAYOUT_VERSION}). This CLI is the stale half:`);
      console.error(`  npm install -g failproofai@latest`);
      await track("cli_update", { ok: false, reason: "future_layout" });
      lastSubcommand = null;
      await exitAfterFlush(1);
      return;
    }

    let migrationsRan = 0;
    let migrationFailed = false;
    if (state.kind === "stale") {
      const run = runMigrations(state.found);
      migrationsRan = run.steps.length;
      migrationFailed = Boolean(run.failed);
      for (const step of run.steps) {
        console.log(`${step.ok ? "migrated" : "FAILED  "} layout ${step.from} → ${step.to}`);
      }
      if (run.backedUp.length > 0) console.log(`Saved first: ${run.backedUp.join(", ")}`);
      if (run.failed) {
        console.error(
          `Step ${run.failed.from} → ${run.failed.to} did not finish: ${run.failed.error}`,
        );
        console.error(`The home is still marked layout ${state.found} and will be retried.`);
      }
    } else {
      console.log(`Home is at layout ${LAYOUT_VERSION}; no migration was needed.`);
    }

    // The daemon is refreshed even when a step failed, and deliberately: the
    // binary and the layout are independent halves, and leaving a version-skewed
    // daemon behind on top of a failed migration is strictly worse than fixing
    // the half that can be fixed. The exit code still reports the failure.
    let daemonOk = true;
    if (subArgs.includes("--no-daemon")) {
      console.log("Skipped the daemon (--no-daemon). Its version may not match this CLI.");
    } else {
      const svc = await import("../src/hooks/daemon-service");
      if (!svc.isDaemonSupportedPlatform()) {
        console.log(`failproofaid does not run on ${process.platform}; nothing to update.`);
      } else {
        // `refreshDaemonToCliVersion` answers "is there a service at all" itself,
        // so there is no separate installed check to get out of step with it.
        const result = await svc.refreshDaemonToCliVersion();
        for (const line of result.lines) console.log(line);
        daemonOk = result.ok;
      }
    }

    await track("cli_update", {
      ok: daemonOk && !migrationFailed,
      migrations: migrationsRan,
      migration_failed: migrationFailed,
    });
    lastSubcommand = null;
    await exitAfterFlush(daemonOk && !migrationFailed ? 0 : 1);
    return;
  }

  if (args[0] === "uninstall") {
    const subArgs = args.slice(1);
    if (subArgs.includes("--help") || subArgs.includes("-h")) {
      console.log(`
failproofai uninstall — remove failproofai from this machine

USAGE
  failproofai uninstall [--purge] [--dry-run] [--yes]

WHAT IT REMOVES
  • failproofai hook entries from every agent CLI that has them
  • the failproofaid daemon service — ASKED on a plain uninstall (kept unless
    you say yes); always removed with --purge, which prompts for your password
    rather than printing commands to paste
  • the "require the daemon" flag — cleared FIRST, so a partial uninstall can
    never leave this machine denying every tool call

OPTIONS
  --purge         Also delete ~/.failproofai — settings, credentials, audit
                  history and the downloaded daemon binary. Off by default so a
                  reinstall keeps your history.
  --dry-run       Print what would be removed and change nothing.
  --yes, -y       Skip the confirmation prompt. Required when there is no TTY.

WHY THIS EXISTS
  npm runs no uninstall script, so \`npm rm -g failproofai\` removes the package
  and leaves the hook entries and the service behind. Run this first, then:
      npm rm -g failproofai
`);
      process.exit(0);
    }

    const KNOWN = new Set(["--purge", "--dry-run", "--yes", "-y"]);
    const unknown = subArgs.find((a) => !KNOWN.has(a));
    if (unknown) {
      throw new CliError(
        `Unexpected argument: ${unknown}\nRun \`failproofai uninstall --help\` for usage.`,
      );
    }

    lastSubcommand = "uninstall_command";
    const { runUninstallCommand } = await import("../src/hooks/uninstall-cli");
    const purge = subArgs.includes("--purge");
    const dryRun = subArgs.includes("--dry-run");
    const yes = subArgs.includes("--yes") || subArgs.includes("-y");

    // Set only when the prompt actually rendered the plan, which is the one
    // case where printing it again would duplicate it.
    let planWasShown = false;
    const result = await runUninstallCommand({
      purge,
      dryRun,
      yes,
      cwd: process.cwd(),
      // Only offered when a person can actually answer. Without a TTY the
      // command requires --yes rather than assuming consent — see the module.
      confirm: process.stdin.isTTY
        ? async (planLines) => {
            planWasShown = true;
            const { selectOne } = await import("../src/hooks/tui");
            // "No" first, so the default landing position on Enter is the
            // non-destructive one.
            const answer = await selectOne({
              message: purge
                ? "Remove failproofai and DELETE ~/.failproofai?"
                : "Remove failproofai from this machine?",
              body: planLines,
              choices: [
                { label: "No, cancel", value: false },
                { label: purge ? "Yes, remove and purge" : "Yes, remove it", value: true },
              ],
            });
            return answer === true;
          }
        : undefined,
      // Only on a plain uninstall: `--purge` removes the service unconditionally
      // because it deletes the binary the service points at. Absent without a TTY,
      // which the module reads as "keep it".
      confirmDaemon:
        process.stdin.isTTY && !purge
          ? async () => {
              const { selectOne } = await import("../src/hooks/tui");
              const answer = await selectOne({
                message: "Remove the failproofaid background service too?",
                body: [
                  "It runs as a system service and needs sudo to remove, so you",
                  "will be asked for your password.",
                  "",
                  "Keeping it is fine if you plan to reinstall — the hooks are",
                  "already gone either way, so nothing is being enforced.",
                ],
                choices: [
                  { label: "Yes, remove the service", value: true },
                  { label: "No, leave it installed", value: false },
                ],
              });
              return answer === true;
            }
          : undefined,
    });

    // The prompt already rendered the plan as its body; re-printing it would
    // show the same block twice. `planLines` is reported by the command rather
    // than guessed from the text — see UninstallResult.
    const skip = planWasShown ? result.planLines : 0;
    for (const line of result.lines.slice(skip)) {
      if (result.exitCode === 0) console.log(line);
      else console.error(line);
    }
    // NOT after a purge. `track` resolves the instance id, and `getInstanceId()`
    // lazily WRITES ~/.failproofai/state/telemetry-id — which re-created the
    // whole directory seconds after the purge deleted it, leaving a machine the
    // user had just wiped holding a brand-new tracking identifier and making
    // the command's own "✓ deleted" line false. A purge means gone; nothing
    // gets to touch the home afterwards, least of all telemetry.
    if (!result.purged) {
      await track("cli_uninstall_command", {
        ok: result.exitCode === 0,
        purge,
        dry_run: dryRun,
      });
    }
    lastSubcommand = null;
    await exitAfterFlush(result.exitCode);
    return;
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
    2. Harnesses  — which agent CLIs to protect (Claude, Codex, ...)
    3. Policies   — presets (combine any), Everything, or a custom pick
    4. Review     — confirms the exact files it will change, then applies

FAILPROOF CLOUD
  failproofai config --connect <url> --token <key> [--machine-id <id>]
                                    Connect this machine to FailproofAI Cloud
                                    [--no-transcripts] decisions only, no transcripts
  failproofai config --disconnect   Stop pulling policy and sending activity
  failproofai config --status       Show connection, daemon and pause state
  failproofai config --pause [--session <id>]
                                    Pause enforcement, time-boxed
  failproofai config --resume [--all]
                                    Resume enforcement

    --machine-label <name>          Human-readable name in the dashboard
                                    (use alone to rename an already-connected machine)

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
    // `--machine-label` ALONE is a rename, not an enrolment. Alongside --connect it
    // keeps its old meaning (the name to enrol under); on its own it changes the
    // name of a machine that is already connected, which previously required
    // re-running enrolment with the url and token again just to fix a display name.
    const wantsRename =
      connectIdx < 0 && !wantsDisconnect && args.includes("--machine-label");
    if (connectIdx >= 0 || wantsDisconnect || wantsRename) {
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
      if (wantsRename) {
        const { runRenameCommand } = await import("../src/hooks/cloud-enrollment-cli");
        result = await runRenameCommand(valueAfter("--machine-label"));
      } else if (wantsDisconnect) {
        const { runDisconnectCommand } = await import("../src/hooks/cloud-enrollment-cli");
        result = runDisconnectCommand();
      } else {
        const { hostname } = await import("node:os");
        const { runConnectCommand } = await import("../src/hooks/cloud-enrollment-cli");
        result = await runConnectCommand({
          url: valueAfter("--connect"),
          token: valueAfter("--token"),
          machineId: valueAfter("--machine-id"),
          machineLabel: valueAfter("--machine-label"),
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
        action: wantsRename ? "rename" : wantsDisconnect ? "disconnect" : "connect",
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
        // Always printed, including where reports can never work: "why am I
        // not getting them?" is the question --status exists to answer, and an
        // omitted line answers it with silence.
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
      // `target` and `scopes`, not `scope`: the wizard rework replaced that
      // field and nothing caught it, because `.mjs` is outside the tsconfig
      // include so `tsc --noEmit` never type-checks this file. Every
      // `cli_configure_invoked` since has reported `scope: null`.
      target: result.target ?? null,
      scopes: result.scopes ?? [],
      cli_count: result.clis?.length ?? 0,
      abort: result.abort ?? null,
    });
    // `abort` is the field `WizardAbort` exists to expose, and exiting 0
    // regardless discarded it: a fleet script could not tell "the user pressed
    // Esc" from "this machine could not install the required daemon and is
    // unconfigured". Cancelling is not a failure; the other two are.
    await exitAfterFlush(!result.applied && result.abort && result.abort !== "cancelled" ? 1 : 0);
    return;
  }

  // Shared by both "unknown thing" guards below, so a mistyped SUBCOMMAND gets
  // the same nearest-match treatment a mistyped flag already got.
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

  // Unknown flag guard — must appear after all known-flag branches
  const knownFlags = ["--version", "-v", "--help", "-h", "--hook"];
  const unknownFlag = args.find(a => a.startsWith("-") && !knownFlags.includes(a));

  if (unknownFlag) {
    const primary = ["--version", "--help", "--hook", "policies", "policy", "audit"];
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
    // Nearest match rather than a hardcoded "policies", which was wrong for
    // every input that was not a typo of it. `auth` made that concrete: it was
    // a real subcommand until this release, so an old script or plain muscle
    // memory lands here, and answering "did you mean policies?" sends someone
    // to the one command that has nothing to do with what they typed.
    const nearest = SUBCOMMANDS.reduce(
      (best, name) => {
        const dist = levenshtein(unknownSubcommand, name);
        return dist < best.dist ? { name, dist } : best;
      },
      { name: SUBCOMMANDS[0], dist: Infinity },
    );
    throw new CliError(
      `Unknown command: ${unknownSubcommand}\n` +
      `Did you mean: failproofai ${nearest.name}?\n` +
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
