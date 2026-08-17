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

// ── one noun for policies ──────────────────────────────────────────────────
// `policies`, `policy` and `pack` were three commands for one idea, two of them
// a single letter apart and doing unrelated things. They are now three
// spellings of the same command. Rewritten HERE, above SUBCOMMANDS and every
// dispatch below, so the rest of this file mentions only the canonical name and
// no branch has to remember the aliases.
//
// Nothing anybody has typed before stops working — the old spellings are
// translated, not rejected — which matters because they are printed in shipped
// help output, in this repo's docs, and in the release notes of every pack
// published so far.
if (args[0] === "p" || args[0] === "policy") args[0] = "policies";
if (args[0] === "pack") {
  args[0] = "policies";
  if (args[1] === "list") {
    // `pack list` was two commands wearing one name: bare it listed what is
    // installed here, with an argument it previewed a pack that is not. Those
    // are different questions, so they are different words now — the bare form
    // and `show`.
    const hasSource = args[2] && !args[2].startsWith("-");
    if (hasSource) args.splice(1, 1, "show");
    else args.splice(1, 1);
  } else if (args[1] === "build") {
    // `pack build` produced the release assets and stopped. That is exactly
    // `publish` with nowhere to publish to, so it IS publish — the local half
    // of it. `publish` with no --repo does the same thing and says so.
    args.splice(0, 2, "publish");
  }
}
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
/**
 * Every CLI `policies --install/--uninstall/list --cli` accepts.
 *
 * ONE list, referenced from all three flag parsers below. It used to be three
 * hardcoded copies, and they drifted: grok and qwen were added to the `--hook
 * --cli` validation and to INTEGRATION_TYPES, but not here, so a real
 * `policies --install --cli grok` was rejected outright while every unit test
 * passed. __tests__/hooks/integrations.test.ts asserts this equals
 * INTEGRATION_TYPES so the next CLI cannot repeat it.
 */
const INSTALLABLE_CLIS = ["claude", "codex", "copilot", "cursor", "opencode", "pi", "hermes", "openclaw", "factory", "devin", "antigravity", "goose", "grok", "qwen"];
const VALID_CLIS_USAGE = `Missing value(s) for --cli. Usage: --cli ${INSTALLABLE_CLIS.join(" ")} (or any subset)`;

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
    console.error("Usage: failproofai --hook <event> [--cli <claude|codex|copilot|cursor|opencode|pi|hermes|openclaw|factory|devin|antigravity|goose|grok|qwen>]");
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
      || cliArg === "grok"
      || cliArg === "qwen"
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
/**
 * Every `--help` in this file, and the index itself, drawn by ONE renderer.
 *
 * They used to be twelve template literals: `USAGE` on one screen and `Usage:`
 * on the next, a description column hand-counted per screen, no version on any
 * of them, and no colour on any of them while the index they were reached from
 * had all three. The words are still each screen's own — this owns the shape,
 * so a screen cannot drift out of the family without editing the family.
 *
 * Capped at 80 columns by `helpOptsFor`, so help reads the same in a maximised
 * window as in a tmux pane, and narrows on a terminal smaller than that.
 */
/**
 * Lines a module ALREADY laid out with the kit — `harness`, `publish`,
 * `policies add`, the pack lane — printed with the outer margins every other
 * screen gets. They used to go out one `console.log` at a time, which is the
 * one thing `printBlock` exists to own: the block arrived flush against the
 * prompt above it while every neighbouring command was breathing.
 */
async function printLines(lines, ok = true) {
  const { printBlock } = await import("../src/hooks/tui");
  printBlock(ok ? process.stdout : process.stderr, lines);
}

/**
 * What an action surface prints when it is done: a heading naming the command,
 * then the lines it produced, indented and margined like every other screen.
 *
 * The modules keep returning bare facts — `runFlushCommand` says "2 batches
 * spooled", not how to draw it — so the presentation lives in exactly one
 * place instead of five, and a flush report and a `policies` listing stop
 * looking like output from two different programs.
 *
 * Lines that already carry their own leading space are passed through: those
 * are sub-items a module laid out on purpose, and re-wrapping them would
 * flatten the structure they were expressing.
 */
async function printReport(command, lines, opts = {}) {
  const { title, wrap, stack, printBlock, optsFor, INDENT, brandAnsi, ANSI_RESET } =
    await import("../src/hooks/tui");
  const ok = opts.ok !== false;
  const stream = ok ? process.stdout : process.stderr;
  const o = optsFor(stream);
  // `\`like this\`` becomes pink, and loses the backticks. These messages name
  // the command to run next more often than not, and pink is what you type
  // everywhere else on the CLI now — the help screens, the bullets, the next
  // steps. Applied AFTER wrapping, because an escape sequence has no width and
  // colouring first would make every wrap measure the wrong length.
  const paint = (line) =>
    o.color && (line.match(/`/g) || []).length % 2 === 0
      ? line.replace(/`([^`]+)`/g, `${brandAnsi("pink")}$1${ANSI_RESET}`)
      : line;
  const body = [];
  for (const line of lines) {
    if (line.trim() === "") body.push("");
    else if (line.startsWith(" ")) body.push(paint(`${INDENT}${line}`));
    else {
      for (const w of wrap(line, Math.max(20, o.cols - INDENT.length * 2))) {
        body.push(paint(`${INDENT}${w}`));
      }
    }
  }
  printBlock(stream, stack(title(`failproofai ${command}`, opts.meta, o), body));
}

async function printHelp(spec) {
  const { helpScreen, helpOptsFor, printBlock } = await import("../src/hooks/tui");
  printBlock(process.stdout, helpScreen({ version, ...spec }, helpOptsFor(process.stdout)));
}

async function runCli() {
  // --help / -h  (only when not inside a subcommand that handles its own --help)
  // `update` and `migrate` were missing here, so `failproofai update --help`
  // exited 1 with "Unexpected argument" — both commands had no reachable help
  // at all, only the paragraph in the top-level dump that this rewrite moved.
  // `help` and `publish` are new. `policy` and `pack` are canonicalized to
  // `policies` above and never reach this list.
  const SUBCOMMANDS = ["policies", "audit", "config", "uninstall", "backfill", "flush", "harness", "publish", "update", "migrate", "help"];
  // ── help ─────────────────────────────────────────────────────────────────
  //
  // The index and the reference manual used to be the same document: 152 lines,
  // six screens at 80x24, with every flag of every command inlined. That is a
  // help tier collapse — the thing you read to find a command was the thing you
  // read to use one — and the cost fell on the person who knew least.
  //
  // Now: ONE screen of what exists, and `help <command>` for everything else.
  // `help <command>` is literally `<command> --help`, dispatched below, so there
  // is exactly one copy of each command's documentation and the two spellings
  // cannot drift.
  const helpTopic = args[0] === "help" ? args[1] : undefined;
  if (args[0] === "help" && helpTopic) {
    // `--hook` is the entry point an agent CLI spawns per tool call. It is
    // documented in NO help output — only a module docblock and one error
    // string — so it gets a topic here rather than a line on the index, where a
    // machine-facing flag would only take space from the human-facing commands.
    if (helpTopic === "hook") {
      await printHelp({
        command: "--hook",
        tagline: "the entry point your agent CLI spawns, once per tool call",
        sections: [
          {
            label: "usage",
            entries: [["failproofai --hook <event> [--cli <name>]"]],
            after: [
              "You do not run this; `failproofai config` writes it into each CLI's",
              "hook configuration for you.",
            ],
          },
          {
            label: "options",
            entries: [
              ["--hook <event>", "PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop, SessionStart, SessionEnd, PreCompact, Notification, PermissionRequest"],
              ["--cli <name>", "claude, codex, copilot, cursor, opencode, pi, hermes, openclaw, factory, devin, antigravity, goose. Defaults to claude. It selects which payload shape to expect: each CLI names its events and tool arguments differently, and failproofai canonicalizes them."],
            ],
          },
          {
            label: "how it answers",
            lines: [
              "It reads the event as JSON on stdin and answers on stdout, in whatever",
              "shape that CLI honours. Exit codes and response shapes differ per CLI by",
              "necessity — see docs.befailproof.ai. Denials are reported to the agent,",
              "never to you.",
            ],
          },
        ],
      });
      process.exit(0);
      process.exit(0);
    }
    // Canonicalize the topic the same way a typed command is canonicalized, so
    // `help pack` and `help policy` answer instead of erroring.
    const canonical =
      helpTopic === "p" || helpTopic === "policy" || helpTopic === "pack"
        ? "policies"
        : helpTopic === "configure" || helpTopic === "setup"
          ? "config"
          : helpTopic;
    if (!SUBCOMMANDS.includes(canonical)) {
      throw new CliError(
        `No help for: ${helpTopic}\n` +
        `Run \`failproofai help\` to see every command.`,
      );
    }
    // `policies add|remove|show` has its own help, distinct from the listing's.
    args.splice(0, 2, canonical, ...(canonical === "policies" && !args[2] ? [] : []), "--help");
  }

  if (
    args[0] === "help" ||
    ((args.includes("--help") || args.includes("-h")) && !SUBCOMMANDS.includes(args[0]))
  ) {
    const extraArgs = args.filter((a) => a !== "--help" && a !== "-h" && a !== "help");
    if (extraArgs.length > 0) {
      throw new CliError(`Unexpected argument: ${extraArgs[0]}\nRun \`failproofai help\` for usage.`);
    }
    // The index is DATA, not a template literal: one renderer draws it and the
    // eleven `<command> --help` screens, so a row added here cannot end up in a
    // different dialect from the screen it points at. Colour is decoration and
    // never meaning — the column position already says which half is a command,
    // so this reads identically under NO_COLOR, piped to a file, or on a
    // terminal that has never heard of 24-bit.
    await printHelp({
      tagline: "guardrails for the coding agents on this machine",
      sections: [
        {
          label: "get it running",
          entries: [
            ["config", "Set this machine up: agents, daemon, cloud"],
            ["config --token <key>", "Set up and connect to Cloud, no questions asked"],
            ["update", "Finish an npm upgrade: migrate home, match the daemon"],
          ],
        },
        {
          label: "choose what it enforces",
          entries: [
            ["policies", "Every policy on this machine, and whether it is on"],
            ["policies add", "Turn one on, or install a pack: <owner>/<repo>"],
            ["policies remove", "Turn one off, or uninstall a whole pack"],
            ["publish", "Ship your own policies as a pack anyone can install"],
          ],
        },
        {
          label: "see what it caught",
          entries: [
            ["(no args)", "Open the policy dashboard on localhost:8020"],
            ["audit", "Scan your agents' history, then open the audit view"],
            ["config --status", "Cloud connection, daemon version, pause state"],
          ],
        },
        // Named, not described. Everything here is real and reachable through
        // `help <command>`; none of it is what anyone types on the first day,
        // and a full row each is what made this screen read as a manual.
        {
          label: "less often",
          lines: ["policies show, harness, flush, backfill, migrate, uninstall, config --pause"],
        },
      ],
      footer: [
        "failproofai <command> [options]     failproofai help <command> for detail",
        "docs.befailproof.ai   discord.befailproof.ai   -h this screen   -v version",
      ],
    });
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
      await printHelp({
        command: "flush",
        tagline: "deliver what is already spooled, now",
        sections: [
          { label: "usage", entries: [["failproofai flush [--wait] [--timeout <secs>]"]] },
          {
            label: "why",
            lines: [
              "The collector is unhurried on purpose: a batch is swept once it is older",
              "than two minutes, at most 64 per pass, on a 60-second cadence. That pacing",
              "keeps a backlog from stampeding the server, and it is exactly wrong when",
              "you are standing at a dashboard waiting to see your own events — \"not",
              "delivered yet\" and \"not working\" look identical from there.",
              "",
              "This asks the daemon to make a pass right now, with no minimum age and no",
              "per-pass cap. It re-sends nothing: only batches already spooled and not",
              "yet delivered. For history the collector has already read past, use",
              "`failproofai backfill`.",
            ],
          },
          {
            label: "options",
            entries: [
              ["--wait", "Block until the spool drains, or --timeout elapses."],
              ["--timeout <secs>", "How long --wait waits. Default: 60."],
            ],
          },
        ],
      });
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
    await printReport("flush", result.lines, { ok: result.exitCode === 0 });
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
      await printHelp({
        command: "backfill",
        tagline: "re-send history the collector has already read past",
        sections: [
          { label: "usage", entries: [["failproofai backfill [--since <when>] [--dry-run]"]] },
          {
            label: "why",
            lines: [
              "The collector never re-reads a file it has a cursor for, which is right",
              "until the dashboard's data is cleared, a machine is re-enrolled, or",
              "cursors advanced before there was anywhere to send. Then the history",
              "exists on disk and nowhere else, with no way to ask for it again.",
              "",
              "Re-sending is safe: redaction is deterministic, so a re-sent event hashes",
              "identically to its first send and collapses into the row already there.",
            ],
          },
          {
            label: "options",
            entries: [
              ["--since <when>", "How far back: `30d`, `6m`, `YYYY-MM-DD`. Default 30 days."],
              ["--dry-run", "Report what would be re-read and change nothing."],
            ],
          },
          {
            label: "note",
            lines: [
              "Which streams are sent follows [collector] in ~/.failproofai/config.toml —",
              "a backfill never sends something your config says you do not want.",
            ],
          },
        ],
      });
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
    await printReport("backfill", result.lines, { ok: result.exitCode === 0 });
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
  // There is no `pack` branch here on purpose. `pack`, `policy` and `p` are
  // rewritten to `policies` at the top of this file, above every dispatch, so
  // `args[0]` can never be "pack" by the time this runs. One lived here anyway
  // for a while, unreachable, carrying a sixty-line help screen that still
  // advertised `pack list`, `pack add` and `pack build` — three spellings this
  // CLI no longer has — in a third heading dialect nothing else used. Nobody
  // could reach it to notice. The pack lane is entered from
  // `policies add|remove|show` below, which is the only door it has.

  if (args[0] === "harness") {
    const subArgs = args.slice(1);
    if (subArgs.length === 0 || subArgs.includes("--help") || subArgs.includes("-h")) {
      await printHelp({
        command: "harness",
        tagline: "capture sessions from more than one location per agent CLI",
        sections: [
          {
            label: "usage",
            entries: [
              ["failproofai harness list [<harness>]"],
              ["failproofai harness add-path <harness> [<label>=]<path>"],
              ["failproofai harness remove-path <harness> <path|label>"],
            ],
          },
          {
            label: "why",
            lines: [
              "Each agent CLI is watched wherever its own installer put it —",
              "~/.claude/projects, ~/.hermes/state.db, and so on. That misses every",
              "other arrangement: a second profile, a mounted team share, a container's",
              "home beside the host's, an agent an operator moved. Those hold real",
              "sessions and nothing collects them.",
            ],
          },
          {
            label: "the label",
            lines: [
              "An entry is `<path>` or `<label>=<path>`. The label namespaces agent ids",
              "as <label>-<agentId>, and it matters: two locations holding the same",
              "project derive the SAME id (it comes from the cwd inside the transcript,",
              "identical in both copies), so without a label they merge into one agent",
              "whose sessions interleave from two machines' worth of history. Omit it",
              "and one is derived from the folder name.",
            ],
          },
          {
            label: "harnesses",
            lines: [
              "claude, codex, copilot, openclaw, pi, factory, antigravity, cursor,",
              "goose, opencode, devin, hermes",
              "",
              "`claude` covers subagent transcripts too — they live under the same root.",
            ],
          },
          {
            label: "notes",
            lines: [
              "• Session collection must be on for any of this to be read; extra paths",
              "  live under \"collector\" in ~/.failproofai/config.json like the defaults.",
              "• A path overlapping one already captured is REFUSED by the daemon at",
              "  startup rather than collected twice under two ids. It says so in the",
              "  journal.",
              "• Two entries sharing a LABEL are refused too: they would share one",
              "  cursor directory, whose whole map is written at once, so each would",
              "  clobber the other's watermark and re-read from zero after a restart.",
              "• Takes effect within seconds — the daemon re-reads config.json on an",
              "  interval and cycles its collector. No restart, no sudo.",
            ],
          },
          {
            label: "examples",
            lines: [
              "failproofai harness add-path claude work=/srv/team/.claude/projects",
              "failproofai harness add-path hermes prod=/srv/hermes-prod/state.db",
              "failproofai harness add-path codex /mnt/other-home/.codex/sessions",
              "failproofai harness list",
              "failproofai harness remove-path claude work",
              "",
              "One home per person — label them, or both derive the same folder-name",
              "label and the second is refused:",
              "failproofai harness add-path openclaw user1=/srv/.openclaw-user1",
              "failproofai harness add-path openclaw user2=/srv/.openclaw-user2",
              "",
              "Containers: FAILPROOFAI_<HARNESS>_EXTRA_PATHS replaces the file's entries.",
              "FAILPROOFAI_OPENCLAW_EXTRA_PATHS=\"user1=/srv/.a,user2=/srv/.b\"",
            ],
          },
        ],
      });
      process.exit(0);
    }

    lastSubcommand = "harness";
    const { runHarnessCommand } = await import("../src/hooks/harness-cli");
    const result = runHarnessCommand(subArgs);
    await printLines(result.lines, result.exitCode === 0);
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
      await printHelp({
        command: "migrate",
        tagline: "bring ~/.failproofai up to the layout this version speaks",
        sections: [
          { label: "usage", entries: [["failproofai migrate [--dry-run]"]] },
          {
            label: "why",
            lines: [
              "npm cannot update an installed package on its own, so a machine can sit",
              "on an old version for months and then jump several layouts at once. This",
              "runs the steps for that jump in order, keyed on the LAYOUT recorded in",
              "~/.failproofai/VERSION rather than on the npm version — so skipping",
              "thirty releases with no layout change runs nothing at all.",
              "",
              "It normally happens by itself, on the first command after an upgrade.",
              "This is for running it deliberately, and for seeing what it would do",
              "first.",
              "",
              "Your settings, cloud enrolment, policy selection, your own policy files,",
              "decision history and undelivered events are carried across, not removed.",
              "The irreplaceable files are copied to migrations/backup-layout<n>/ before",
              "anything runs, and every step is recorded in migrations/applied.json.",
            ],
          },
          {
            label: "options",
            entries: [
              ["--dry-run", "Print the steps and the files it would save. Change nothing."],
            ],
          },
        ],
      });
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
      await printReport("migrate", [
        `This machine's failproofai directory was written by a newer version ` +
          `(layout ${state.found}; this build speaks ${LAYOUT_VERSION}). Upgrade rather than migrate:`,
        "",
        "  npm install -g failproofai@latest",
      ], { ok: false, meta: `layout ${state.found}` });
      await track("cli_migrate", { ok: false, reason: "future_layout" });
      lastSubcommand = null;
      await exitAfterFlush(1);
      return;
    }

    const from = state.kind === "stale" ? state.found : LAYOUT_VERSION;
    if (subArgs.includes("--dry-run")) {
      await printReport("migrate", describePlan(from), { meta: "dry run" });
      await track("cli_migrate", { ok: true, dry_run: true, from });
      lastSubcommand = null;
      await exitAfterFlush(0);
      return;
    }

    if (state.kind !== "stale") {
      await printReport("migrate", [`Already at layout ${LAYOUT_VERSION}. Nothing to migrate.`]);
      await track("cli_migrate", { ok: true, from, steps: 0 });
      lastSubcommand = null;
      await exitAfterFlush(0);
      return;
    }

    const run = runMigrations(from);
    const report = run.steps.map(
      (step) => `  ${step.ok ? "migrated" : "FAILED  "} layout ${step.from} → ${step.to}`,
    );
    if (run.backedUp.length > 0) report.push("", `Saved first: ${run.backedUp.join(", ")}`);
    if (run.failed) {
      report.push(
        "",
        `Step ${run.failed.from} → ${run.failed.to} did not finish: ${run.failed.error}`,
        `The home is still marked layout ${from} and will be retried.`,
      );
    }
    await printReport("migrate", report, {
      ok: !run.failed,
      meta: `layout ${from} → ${LAYOUT_VERSION}`,
    });
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
      await printHelp({
        command: "update",
        tagline: "finish an upgrade: migrate the home, match the daemon",
        sections: [
          {
            label: "usage",
            entries: [["npm install -g failproofai@latest && failproofai update [--no-daemon]"]],
          },
          {
            label: "why",
            lines: [
              "npm replaces the CLI and nothing else. The daemon binary lives at",
              "~/.failproofai/bin/failproofaid-<version> and stays exactly where it was,",
              "so after an npm upgrade the two halves are different versions — and",
              "failproofaid refuses to start against a layout it does not speak, which",
              "is the loud version of that problem rather than the silent one.",
              "",
              "This does the rest of the upgrade: runs any pending layout migrations,",
              "puts the matching daemon binary in place, and restarts the service.",
            ],
          },
          {
            label: "options",
            entries: [
              ["--no-daemon", "Migrate the home only. Leaves a version-skewed daemon in place, so prefer letting it run."],
            ],
          },
        ],
      });
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
      await printReport("update", [
        `This machine's failproofai directory was written by a NEWER version ` +
          `(layout ${state.found}; this build speaks ${LAYOUT_VERSION}). This CLI is the stale half:`,
        "",
        "  npm install -g failproofai@latest",
      ], { ok: false, meta: `layout ${state.found}` });
      await track("cli_update", { ok: false, reason: "future_layout" });
      lastSubcommand = null;
      await exitAfterFlush(1);
      return;
    }

    // Collected rather than printed as it goes, so `update` closes with ONE
    // report — heading, then both halves of the upgrade under it — instead of
    // a run of bare sentences at column zero.
    const report = [];
    let migrationsRan = 0;
    let migrationFailed = false;
    if (state.kind === "stale") {
      const run = runMigrations(state.found);
      migrationsRan = run.steps.length;
      migrationFailed = Boolean(run.failed);
      for (const step of run.steps) {
        report.push(`  ${step.ok ? "migrated" : "FAILED  "} layout ${step.from} → ${step.to}`);
      }
      if (run.backedUp.length > 0) report.push("", `Saved first: ${run.backedUp.join(", ")}`);
      if (run.failed) {
        report.push(
          "",
          `Step ${run.failed.from} → ${run.failed.to} did not finish: ${run.failed.error}`,
          `The home is still marked layout ${state.found} and will be retried.`,
        );
      }
    } else {
      report.push(`Home is at layout ${LAYOUT_VERSION}; no migration was needed.`);
    }

    // The daemon is refreshed even when a step failed, and deliberately: the
    // binary and the layout are independent halves, and leaving a version-skewed
    // daemon behind on top of a failed migration is strictly worse than fixing
    // the half that can be fixed. The exit code still reports the failure.
    let daemonOk = true;
    if (subArgs.includes("--no-daemon")) {
      report.push("", "Skipped the daemon (--no-daemon). Its version may not match this CLI.");
    } else {
      const svc = await import("../src/hooks/daemon-service");
      if (!svc.isDaemonSupportedPlatform()) {
        report.push("", `failproofaid does not run on ${process.platform}; nothing to update.`);
      } else {
        // `refreshDaemonToCliVersion` answers "is there a service at all" itself,
        // so there is no separate installed check to get out of step with it.
        const result = await svc.refreshDaemonToCliVersion();
        report.push("", ...result.lines);
        daemonOk = result.ok;
      }
    }

    await printReport("update", report, {
      ok: daemonOk && !migrationFailed,
      meta: `v${version}`,
    });
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
      await printHelp({
        command: "uninstall",
        tagline: "remove failproofai from this machine",
        sections: [
          { label: "usage", entries: [["failproofai uninstall [--purge] [--dry-run] [--yes]"]] },
          {
            label: "what it removes",
            lines: [
              "• failproofai hook entries from every agent CLI that has them",
              "• the failproofaid daemon service — ASKED on a plain uninstall (kept",
              "  unless you say yes); always removed with --purge, which prompts for",
              "  your password rather than printing commands to paste",
              "• the \"require the daemon\" flag — cleared FIRST, so a partial uninstall",
              "  can never leave this machine denying every tool call",
            ],
          },
          {
            label: "options",
            entries: [
              ["--purge", "Also delete ~/.failproofai — settings, credentials, audit history and the downloaded daemon binary. Off by default so a reinstall keeps your history."],
              ["--dry-run", "Print what would be removed and change nothing."],
              ["--yes, -y", "Skip the confirmation prompt. Required when there is no TTY."],
            ],
          },
          {
            label: "why this exists",
            lines: [
              "npm runs no uninstall script, so `npm rm -g failproofai` removes the",
              "package and leaves the hook entries and the service behind. Run this",
              "first, then:",
              "    npm rm -g failproofai",
            ],
          },
        ],
      });
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
    await printReport("uninstall", result.lines.slice(skip), {
      ok: result.exitCode === 0,
      meta: subArgs.includes("--purge") ? "purge" : subArgs.includes("--dry-run") ? "dry run" : undefined,
    });
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

  // publish — build the release assets AND put them on a GitHub release.
  //
  // Top level rather than under `policies`, because it is a PRODUCER verb: the
  // four consumer words are what every user reads, and almost none of them will
  // ever ship a pack. `pack build` is canonicalized into this above.
  if (args[0] === "publish") {
    const subArgs = args.slice(1);
    // NOT `subArgs.length === 0`. A bare `failproofai publish` is the headline
    // of the help this used to print instead — "TWO COMMANDS, FROM NOTHING:
    // --init to start, publish to ship it" — and every argument it needs is
    // worked out from the directory and the git remote. Printing help there
    // made the one documented command the only one that did nothing.
    if (subArgs.includes("--help") || subArgs.includes("-h")) {
      await printHelp({
        command: "publish",
        tagline: "ship your policies as a pack anyone can install",
        sections: [
          {
            label: "two commands, from nothing",
            entries: [
              ["failproofai publish --init", "write a policy to start from"],
              ["failproofai publish", "ship it"],
            ],
            after: [
              "Write your policies in a git repo, run publish, answer one question,",
              "done. It asks WHERE only when nothing tells it — no remote to read —",
              "and works the rest out: which files hold policies, what version is",
              "next, who you are. Every flag below overrides something it would",
              "otherwise decide. None is required, and on a pipe or in CI the flags",
              "are all there is: nothing prompts where nobody can answer.",
            ],
          },
          {
            label: "what --init does",
            lines: [
              "Asks what the pack is called, writes <name>.mjs, and stops. No network,",
              "no git, nothing published. The file is not a template with blanks — it",
              "is one policy that already blocks git push --force, so the first thing",
              "you do is edit something that works. It refuses rather than overwriting",
              "a file that exists.",
              "",
              "Then try it on THIS machine, before anyone else can see it:",
              "",
              "    failproofai policies -i -c ./<name>.mjs",
              "",
              "That enforces the file right now — any path, any filename. Ask your",
              "agent to do the thing you blocked and watch it get refused. Nothing is",
              "published and nobody else is affected.",
            ],
          },
          {
            label: "what publish does",
            lines: [
              "In order, stopping before it touches GitHub if anything is wrong:",
              "",
              "1  Finds the policy file here by CONTENT — one that imports failproofai",
              "   and calls customPolicies.add — not by filename, so it finds",
              "   guards.mjs and ignores an unrelated policies.mjs. Not recursive:",
              "   publishing a fixture is worse than being asked. Two candidates and",
              "   it lists them.",
              "2  Reads the repo from git remote get-url origin, in the FILE's",
              "   directory rather than yours, and decides the version (see below).",
              "3  Finds your credential: GITHUB_TOKEN, GH_TOKEN, or gh auth login.",
              "   Needs release-write and nothing else. Never printed.",
              "4  Creates the repository if it does not exist — public, see below.",
              "5  Builds the three assets, validating with the LOADER's own rules: the",
              "   code that decides what may install on a stranger's machine. A pack",
              "   that could never install fails here, where you can fix it.",
              "6  Creates or reuses the release and uploads, replacing assets of the",
              "   same name — the install URL is built from fixed names, so a stale",
              "   copy is what somebody would fetch.",
            ],
          },
          {
            label: "how the version is decided",
            lines: [
              "The commit you are publishing from — its short sha, twelve",
              "characters: a1b2c3d4e5f6. Nothing to pick, nothing to count, and it",
              "names exactly where the bytes came from. Publish the same source",
              "twice and you get the same version, because there is nothing to",
              "increment.",
              "",
              "Twelve rather than git's seven: seven collides in a repository with",
              "enough objects, and a version that stops being unique means two",
              "artifacts claiming one name. The full sha is recorded beside it.",
              "",
              "Read from the tree in front of you, never from the repository's",
              "releases, so a fresh clone and an air-gapped machine compute the",
              "same answer and neither has to ask GitHub what happened before.",
              "",
              "It REFUSES rather than guessing, in two cases, because the version",
              "claims to name a commit and must not be minted where that is false:",
              "",
              "  no git checkout        there is no commit to name",
              "  uncommitted changes    those bytes are not in that commit",
              "",
              "--version overrides both, and a tag on HEAD wins over the sha —",
              "someone who tagged v1.2.0 has SAID what this release is.",
              "",
              "A sha does not order. `policies show <owner>/<repo> --releases` is",
              "where you see which came first, newest at the top.",
            ],
          },
          {
            label: "what a release records",
            lines: [
              "The commit you published from, when you are in a git checkout, in the",
              "manifest and in the release notes. Provenance, not verification —",
              "the artifact digest is still the only thing that decides whether the",
              "bytes are the ones that were published. It answers the question a",
              "digest cannot: which source produced them.",
              "",
              "Which is also how anyone installs that exact release:",
              "",
              "    failproofai policies add <owner>/<repo>@a1b2c3d",
              "",
              "and read the whole history with:",
              "",
              "    failproofai policies show <owner>/<repo> --releases",
            ],
          },
          {
            // This screen said "an existing private one still publishes, and
            // warns" for as long as that was true. It is REFUSED now — exit 1,
            // nothing created or uploaded — and `--allow-private` was named
            // nowhere in this help, so the one documented behaviour pointed a
            // publisher at a command that exits 1 and gave them no way through.
            label: "the repo must be public",
            lines: [
              "Installs are anonymous HTTPS with no credential to offer, so a private",
              "repository publishes to nobody. A repo created here is public for that",
              "reason; an existing private one is REFUSED, before anything is built,",
              "created or uploaded. --allow-private publishes to one anyway, for",
              "somebody who will hand the three assets over another way — it still",
              "says plainly that no `policies add` can reach them.",
              "",
              "Only the release matters. Installs read releases/download/<tag>/<asset>",
              "and never touch your git tree — pushing the source is for humans.",
            ],
          },
          {
            label: "your policy files",
            lines: [
              "Write as many as you like — one per category reads well. Every file",
              "here that registers policies is bundled into the single artifact a pack",
              "has to be: only the entry is digest-pinned, and a pack importing",
              "siblings could not honestly claim to be verified. Bundling needs bun;",
              "without it, name one self-contained file.",
              "",
              "Each policy may carry category and defaultEnabled alongside the usual",
              "fields. category is what --category selects on; defaultEnabled is what",
              "a bare `policies add` switches on, and it defaults to false.",
            ],
          },
          {
            label: "options",
            entries: [
              ["--init [file]", "Write a starter policy and stop."],
              ["--repo <owner>/<repo>", "Where to release it, created if missing."],
              ["--version <version>", "Name the version, instead of the commit it was built from."],
              ["--id <publisher/name>", "The pack's id. Defaults to --repo."],
              ["--tag <tag>", "Release tag. Defaults to the version; v prefix ok."],
              ["--notes <text>", "Release notes."],
              ["--out <dir>", "Where to write the assets. Default: dist-pack."],
              ["--effect <effect>", "enforce or observe. observe records and blocks nothing. Default: enforce."],
              ["--dry-run", "Build the assets, publish nothing. No credential."],
              ["--allow-private", "Publish to an already-private repo anyway. Nobody can install it."],
            ],
          },
          {
            label: "examples",
            lines: [
              "failproofai publish --init",
              "failproofai publish",
              "failproofai publish --dry-run",
              "failproofai publish ./guards.mjs --repo me/guards --version 2.0.0",
            ],
          },
        ],
      });
      process.exit(0);
    }

    lastSubcommand = "publish";
    const { runPublishCommand } = await import("../src/hooks/pack-cli");
    const result = await runPublishCommand(subArgs);
    await printLines(result.lines, result.exitCode === 0);
    // Shape, never value: whether it published and whether it worked. Never the
    // repo, the pack id or the entry path — all three are things the user typed.
    await track("cli_publish", { ok: result.exitCode === 0, dry_run: subArgs.includes("--dry-run") });
    lastSubcommand = null;
    await exitAfterFlush(result.exitCode);
    return;
  }

  // policies add | remove | show — one noun for policies.
  //
  // `policies`, `policy` and `pack` were three commands for one idea. They are
  // one now, and `add`/`remove` take EITHER a policy name or a pack source,
  // told apart by a SLASH: a policy name matches /^[A-Za-z0-9._-]+$/, so a
  // slash is already illegal in one and unambiguous in the other. That is the
  // rule npm and docker use, and it means nobody has to discover a flag before
  // they can install somebody else's policies.
  //
  // Honors the same --cli / --scope / --beta flags as `policies --install`.
  if (
    args[0] === "policies" &&
    (args[1] === "add" || args[1] === "remove" || args[1] === "show")
  ) {
    lastSubcommand = "policy";
    const subArgs = args.slice(1);

    if (subArgs.length === 0 || subArgs.includes("--help") || subArgs.includes("-h")) {
      await printHelp({
        command: "policies add|remove|show",
        tagline: "choose what your agents may do",
        sections: [
          {
            label: "usage",
            // Without the `failproofai policies` prefix, which the heading two
            // lines up already carries: repeating it costs 21 of the 80 columns
            // on every row and pushes each description into a second line. The
            // examples below are the copy-pasteable spelling.
            entries: [
              ["add", "Pick from what is installed here"],
              ["add <name>", "Turn one policy on"],
              ["add <owner>/<repo>", "Install someone's pack"],
              ["remove <name>", "Turn one policy off"],
              ["remove <pack-id>", "Uninstall a pack"],
              ["show <owner>/<repo>", "What a pack contains, before you take it"],
              ["show <owner>/<repo> --releases", "Every version it has published, and which one is here"],
            ],
          },
          {
            label: "a name or a source",
            lines: [
              "Anything with a slash is a pack source; anything without is a policy",
              "name. Policy names cannot contain a slash, so there is nothing to guess.",
              "",
              "  block-sudo                               a policy",
              "  FailproofAI/policies                     our pack, like any other",
              "  acme/deploy-guard                        newest release, pinned",
              "  acme/deploy-guard@a1b2c3d4e5f6           that release",
              "  acme/deploy-guard@a1b2c3d                the release built from",
              "                                           that commit",
              "  github:acme/deploy-guard@a1b2c3d4e5f6    same, explicit",
              "  https://github.com/acme/x/releases/tag/v2   the URL you copied",
            ],
          },
          {
            label: "choosing part of a pack",
            entries: [
              ["--policy a,b", "exactly these"],
              ["--category x,y", "whole categories (failproofai policies show <source>)"],
              ["--all", "everything it contains"],
            ],
          },
          {
            label: "options (policy names only)",
            entries: [
              ["--cli <agent>...", "Agent CLI(s) to apply to; space-separated or repeated. Omit to detect installed CLIs and prompt."],
              ["--scope user|project|local", "Config scope. Default: user."],
              ["--beta", "Allow beta policies"],
            ],
          },
          {
            label: "examples",
            lines: [
              "failproofai policies add",
              "failproofai policies add block-sudo",
              "failproofai policies add sanitize-api-keys --scope project",
              "failproofai policies add FailproofAI/policies --category sanitize,git",
              "failproofai policies add acme/deploy-guard --policy block-prod-deploy",
              "failproofai policies show acme/deploy-guard",
              "failproofai policies remove block-sudo",
            ],
          },
        ],
        footer: [
          "With no flags you get the pack's own defaults and are shown the rest.",
          "Re-adding at a newer version keeps what you chose.",
          "Agents: claude, codex, copilot, cursor, opencode, pi, hermes, openclaw,",
          "factory, devin, antigravity, goose.",
          "Publishing your own: failproofai publish --help",
          "Offline: FAILPROOFAI_NO_DOWNLOAD=1 refuses to fetch; packs already",
          "installed keep enforcing. FAILPROOFAI_PACK_BASE_URL points it at a mirror.",
        ],
      });
      process.exit(0);
    }

    const action = subArgs[0];
    const rest = subArgs.slice(1);

    // A policy name matches /^[A-Za-z0-9._-]+$/ (pack-manifest.ts owns that
    // rule), so a slash can only ever mean a pack. `core` is the one name
    // without a slash that is still a source — it is the short spelling of our
    // own pack, and is checked by the pack lane itself rather than duplicated
    // here.
    // The first positional that is NOT some flag's value.
    //
    // A plain `rest.find(a => !a.startsWith("-"))` reads the first VALUE it
    // meets instead: `policies add --cli claude codex acme/x` picked "claude",
    // decided that was not a source because it has no slash, and sent the whole
    // command down the policy lane — where it died on "Unknown flag: --policy".
    // The same shape works, and misroutes, for --scope and --custom.
    //
    // `--cli` takes SEVERAL values, bounded the way pack-cli.ts bounds them: a
    // pack source always carries a slash and an agent name never does, which
    // separates the list from what follows it exactly.
    const VALUE_TAKING = new Set(["--scope", "--policy", "--category", "--only", "--custom", "-c"]);
    const skip = new Set();
    for (let i = 0; i < rest.length; i += 1) {
      if (VALUE_TAKING.has(rest[i])) skip.add(i + 1);
      if (rest[i] !== "--cli") continue;
      for (let j = i + 1; j < rest.length && !rest[j].startsWith("-") && !rest[j].includes("/"); j += 1) {
        skip.add(j);
      }
    }
    const firstPositional = rest.find((a, i) => !a.startsWith("-") && !skip.has(i));
    let looksLikeSource =
      !!firstPositional &&
      (firstPositional.includes("/") || firstPositional.startsWith("github:"));
    if (!looksLikeSource && firstPositional) {
      // A retired spelling of our own pack — `core` and friends — is still
      // routed to the pack lane, which is the only layer that can say what to
      // type instead. Sent anywhere else it reads as an unknown POLICY name and
      // the reply lists 38 names, none of which is the answer.
      //
      // Read from the layer that owns the set rather than restated here, where
      // the copy would drift. That exact drift already shipped once, when the
      // dashboard could not resolve a name the CLI could.
      const { RETIRED_CORE_ALIASES } = await import("../src/hooks/pack-store");
      looksLikeSource = RETIRED_CORE_ALIASES.has(firstPositional.toLowerCase());
    }

    if (action === "show" || looksLikeSource) {
      if (action === "show" && !firstPositional) {
        throw new CliError(
          "Usage: failproofai policies show <owner>/<repo>\n" +
          "Run `failproofai policies` to see what is already installed here.",
        );
      }
      // One lane, one implementation. `show` is the pack lane's remote preview,
      // and add/remove of a source are its add/remove — routed by translating
      // the words rather than by growing a second copy of either.
      const packArgs =
        action === "show" ? ["list", ...rest] : [action, ...rest];
      const { runPackCommand } = await import("../src/hooks/pack-cli");
      const result = await runPackCommand(packArgs);
      await printLines(result.lines, result.exitCode === 0);
      await track("cli_pack", {
        ok: result.exitCode === 0,
        // The subcommand only — never the pack id, source or policy names. A
        // pack source is a value the user typed and a third-party pack name is
        // a publisher-controlled string; we send shape, never value.
        sub: action,
      });
      lastSubcommand = null;
      await exitAfterFlush(result.exitCode);
      return;
    }

    if (action !== "add" && action !== "remove") {
      throw new CliError(
        `Unknown policies subcommand: ${action}\n` +
        `Run \`failproofai policies --help\` for usage.`,
      );
    }

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
      // Naming nothing is a question, not a mistake. It used to be an error
      // telling you to go and read a list somewhere else and come back — so
      // the answer is to SHOW the list, here, with what is already on ticked.
      const { runPolicyPicker } = await import("../src/hooks/pack-cli");
      const result = await runPolicyPicker(action, { stdin: process.stdin, stdout: process.stdout });
      await printLines(result.lines, result.exitCode === 0);
      await track("cli_policy_picker", { ok: result.exitCode === 0, action });
      lastSubcommand = null;
      await exitAfterFlush(result.exitCode);
      return;
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
  // policies [--install|-i|--uninstall|-u|--help|-h] [names...] [--scope] [--beta] [--custom|-c <path>]
  if (args[0] === "policies") {
    const subArgs = args.slice(1);

    const isInstall   = subArgs.includes("--install")   || subArgs.includes("-i");
    const isUninstall = subArgs.includes("--uninstall")  || subArgs.includes("-u");
    const isHelp      = subArgs.includes("--help")       || subArgs.includes("-h");

    if (isHelp) {
      await printHelp({
        command: "policies",
        tagline: "manage the policies your agents run under",
        sections: [
          {
            label: "usage",
            entries: [
              ["(bare)", "List every policy here and whether it is on"],
              ["add [what]", "Turn one on, take a pack, or pick from a list"],
              ["remove <what>", "Turn one off, or uninstall a pack"],
              ["show <owner>/<repo>", "What a pack holds, before you take it"],
              ["--install, -i", "Wire policies into your agent CLIs"],
              ["--uninstall, -u", "Unwire them, or strip the hooks"],
            ],
          },
          {
            label: "options",
            entries: [
              ["[names...]", "Policy names. Omit for the interactive picker."],
              ["--cli <agent>...", "Agent CLI(s); space-separated or repeated. Omit to detect what is installed and prompt."],
              ["--scope <scope>", "user, project or local. Default: user. --uninstall also takes all."],
              ["--beta", "Include beta policies. On --uninstall, only those."],
              ["--custom, -c <path>", "Custom policy file; repeat for several. Bare on --uninstall, clears every explicit path."],
            ],
          },
          {
            // Enumerated ONCE. It used to be spelled out in full four times on
            // this screen — twice in the --cli lines, twice more as examples
            // differing only in which agent they named.
            label: "agents",
            lines: [
              "claude, codex, copilot, cursor, opencode, pi, hermes, openclaw,",
              "factory, devin, antigravity, goose",
              "",
              "Codex, Copilot, Cursor, OpenCode and Pi take user or project scope only.",
            ],
          },
          {
            label: "examples",
            lines: [
              "failproofai policies",
              "failproofai policies --install",
              "failproofai policies --install block-sudo sanitize-api-keys",
              "failproofai policies --install --cli codex --scope project",
              "failproofai policies --install --cli claude codex copilot cursor",
              "failproofai policies -i -c ./my-policies.js",
              "failproofai policies --uninstall block-sudo",
              "failproofai policies -u",
              "failproofai policies add FailproofAI/policies --category git,database",
            ],
          },
        ],
        footer: [
          "policy, pack and p are all spellings of policies.",
          "add, remove and show in full:  failproofai policies add --help",
        ],
      });
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
      const VALID_CLIS = new Set(INSTALLABLE_CLIS);
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
          throw new CliError(VALID_CLIS_USAGE);
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
      const VALID_CLIS = new Set(INSTALLABLE_CLIS);
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
          throw new CliError(VALID_CLIS_USAGE);
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


  // config — the interactive setup launcher (scope, agents, policies).
  // `configure` and `setup` are canonicalized to "config" up top. Running it
  // explicitly does NOT run the post-setup audit (that only fires on first-run
  // onboarding via bare `failproofai`).
  if (args[0] === "config") {
    if (args.includes("--help") || args.includes("-h")) {
      await printHelp({
        command: "config",
        tagline: "set this machine up",
        sections: [
          {
            label: "usage",
            entries: [
              ["(bare)", "Guided setup: agents, daemon, cloud"],
              ["--token <key>", "Set up and connect to Cloud, asking nothing"],
              ["--status", "Connection, daemon version and pause state"],
              ["--pause [<time>]", "Pause enforcement for one session"],
              ["--resume [--all]", "End a pause early"],
              ["--disconnect", "Stop pulling policy and sending activity"],
              ["configure, setup", "Aliases for config"],
            ],
          },
          {
            label: "what it does",
            lines: [
              "Installs the failproofaid service (needs root once), wires hooks into",
              "every agent CLI it supports, and optionally connects this machine to",
              "Cloud. It chooses NO policies — take some with:",
              "",
              "    failproofai policies add <owner>/<repo>",
            ],
          },
          {
            label: "with no terminal (CI, containers, an agent driving it)",
            lines: [
              "It just runs. There is nothing to confirm when nobody is watching, so it",
              "applies rather than asking — no flag needed.",
              "",
              "Exit 1 if anything it was asked to do did not happen — including a key",
              "the server refused, and a machine that could not reach root. sudo is",
              "never prompted for here; it either works without a password, or you are",
              "told the exact commands to run.",
            ],
          },
          {
            label: "failproof cloud",
            entries: [
              ["--token <key>", "The API key. Passing one IS the request to connect."],
              ["--url <url>", "Somewhere other than app.befailproof.ai"],
              ["--machine-id <id>", "Defaults to a stable per-machine key"],
              ["--machine-label <n>", "Dashboard name. Alone, renames a connected machine."],
              ["--no-transcripts", "Decisions only, no session transcripts"],
              ["--connect <url>", "Enrol only, on a machine already set up"],
              ["--disconnect", "Stop pulling policy and sending activity"],
            ],
          },
          {
            label: "what connecting means",
            lines: [
              "The key can come from FAILPROOFAI_CLOUD_TOKEN instead of the command",
              "line, and the url from FAILPROOFAI_CLOUD_URL — the same variable the",
              "daemon reads. Prefer the environment: an argument is readable from `ps`",
              "by every user on the box, and lands in shell history and CI logs.",
              "",
              "One connection, two capabilities: this machine PULLS centrally-managed",
              "policies and SENDS what its hooks decided. Both are checked against the",
              "server before anything is written, and reported separately — a key",
              "carrying policies:pull but not events:add connects for policy and says",
              "exactly why the dashboard is empty.",
              "",
              "Connecting sends BOTH policy decisions and full session transcripts. A",
              "transcript carries prompts, file contents and whatever was pasted into a",
              "terminal — that is the point of connecting, and it is stated here rather",
              "than buried behind a flag nobody finds. Use --no-transcripts for",
              "decisions only.",
              "",
              "Tokens are stored owner-only in ~/.failproofai/, never in the service",
              "unit — that file is world-readable. Connecting needs no sudo.",
            ],
          },
          {
            label: "pausing enforcement (one session, always time-boxed)",
            entries: [
              ["--pause", "This directory's newest agent session, for 30m"],
              ["--pause 10m", "A given time (max 8h; s/m/h, bare = minutes)"],
              ["--resume", "End the pause early"],
              ["--resume --all", "End every active pause"],
              ["--session <id>", "Target a specific session"],
              ["--status", "What is paused, and when it lifts"],
            ],
            after: [
              "A pause suspends builtin, custom and convention policies for that",
              "session only, and always expires on its own. Cloud-managed policies",
              "keep enforcing.",
            ],
          },
        ],
        footer: ["Prefer flags?  failproofai policies --help"],
      });
      process.exit(0);
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
      await printLines(result.lines, result.exitCode === 0);
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
        const { connectionStatusReport, versionStatusLines } = await import(
          "../src/hooks/cloud-enrollment-cli"
        );
        const { optsFor, printBlock, rows, stack, title, warning } = await import(
          "../src/hooks/tui"
        );
        const opts = optsFor(process.stdout);
        const report = connectionStatusReport();
        // The version line was written to be "the only place a user can find out
        // which daemon they are running" and then never called from anywhere. It
        // is the right thing for the heading to carry, and it retires a heading
        // that would otherwise have said the word "status" back to someone who
        // just typed it.
        printBlock(
          process.stdout,
          stack(
            title("failproofai config", versionStatusLines()[0], opts),
            // ONE rows() call over both blocks, so the connection facts and the
            // enforcement state share a label column. Rendered separately they
            // computed one column each and the window read as two commands'
            // output stacked up.
            //
            // Always printed, including where reports can never work: "why am I
            // not getting them?" is the question --status exists to answer, and
            // an omitted line answers it with silence.
            rows([...report.rows, ...(result.rows ?? [])], opts),
            report.warnings.length > 0 ? warning(report.warnings, opts) : null,
            // The trailer is not rows — it is the note and the resume command.
            // Rendering only `rows` dropped the one line that tells a paused
            // user how to get unpaused.
            result.rows ? (result.trailer ?? null) : result.lines,
          ),
        );
      } else {
        await printLines(result.lines, result.exitCode === 0);
      }
      await track("cli_pause_invoked", {
        action: pauseIdx >= 0 ? "pause" : wantsResume ? "resume" : "status",
        ok: result.exitCode === 0,
        affected: result.affected,
      });
      await exitAfterFlush(result.exitCode);
      return;
    }

    // Headless setup. `--token` IS the request to connect — there is no other
    // reason to pass a key — so there is no separate --connect to remember, and
    // the URL keeps the default the wizard already infers rather than being a
    // question the flag path alone asks.
    //
    // The key is taken from the environment when the flag is absent, because a
    // secret on argv is readable from `ps` by every user on the box and lands
    // in shell history and CI logs. FAILPROOFAI_CLOUD_TOKEN is the name the
    // Rust daemon already reads, so this unifies rather than invents.
    const valueFor = (flag) => {
      const i = args.indexOf(flag);
      if (i < 0) return undefined;
      const v = args[i + 1];
      if (!v || v.startsWith("-")) throw new CliError(`Missing value after ${flag}.`);
      return v;
    };
    const { runConfigureWizard } = await import("../src/hooks/configure-wizard");
    const result = await runConfigureWizard(
      {},
      {
        token: valueFor("--token") ?? process.env.FAILPROOFAI_CLOUD_TOKEN,
        url: valueFor("--url") ?? process.env.FAILPROOFAI_CLOUD_URL,
        machineId: valueFor("--machine-id"),
        machineLabel: valueFor("--machine-label"),
        noTranscripts: args.includes("--no-transcripts"),
      },
    );
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
