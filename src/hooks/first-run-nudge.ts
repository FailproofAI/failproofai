/**
 * First-run nudge for `failproofai` (no-args invocation).
 *
 * Fires when a user runs the bare CLI without having installed any policies on
 * any detected agent CLI. PostHog data showed only ~10% of npm-installed users
 * ran `failproofai policies --install`; this prompt closes the awareness gap
 * by offering to run that install inline.
 *
 * The hooks themselves are the sentinel — if any are installed for any
 * detected CLI, we never prompt again. No separate state file needed.
 *
 * Honors `FAILPROOFAI_NO_FIRST_RUN=1` for opt-out, falls back to a short
 * stderr hint in non-TTY contexts (CI, piped invocations).
 */
import * as readline from "node:readline";

import { detectInstalledClis, getIntegration } from "./integrations";
import { installHooks } from "./manager";
import { trackHookEvent } from "./hook-telemetry";
import { getInstanceId } from "../../lib/telemetry-id";
import type { IntegrationType } from "./types";

type TTYIn = NodeJS.ReadableStream & { isTTY?: boolean };
type TTYOut = NodeJS.WritableStream & { isTTY?: boolean };

export interface FirstRunNudgeOptions {
  stdin?: TTYIn;
  stdout?: TTYOut;
}

async function emit(event: string, props: Record<string, unknown>): Promise<void> {
  try {
    await trackHookEvent(getInstanceId(), event, props);
  } catch {
    // Telemetry must never break first-run UX.
  }
}

function anyHooksInstalled(detected: IntegrationType[]): boolean {
  for (const id of detected) {
    const integration = getIntegration(id);
    for (const scope of integration.scopes) {
      try {
        if (integration.hooksInstalledInSettings(scope)) return true;
      } catch {
        // A broken settings file shouldn't suppress the nudge.
      }
    }
  }
  return false;
}

function clisLabel(detected: IntegrationType[]): string {
  return detected.map((id) => getIntegration(id).displayName).join(", ");
}

async function promptYesNo(
  stdin: TTYIn,
  stdout: TTYOut,
): Promise<"yes" | "no" | "sigint"> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    let settled = false;
    const finish = (answer: "yes" | "no" | "sigint") => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    rl.on("SIGINT", () => finish("sigint"));
    rl.question("Install policies now? [Y/n] ", (raw) => {
      const a = (raw ?? "").trim().toLowerCase();
      if (a === "" || a === "y" || a === "yes") finish("yes");
      else finish("no");
    });
  });
}

export async function maybeRunFirstRunNudge(opts: FirstRunNudgeOptions = {}): Promise<void> {
  if (process.env.FAILPROOFAI_NO_FIRST_RUN === "1") return;

  const stdin: TTYIn = opts.stdin ?? process.stdin;
  const stdout: TTYOut = opts.stdout ?? process.stdout;

  let detected: IntegrationType[];
  try {
    detected = detectInstalledClis();
  } catch {
    return;
  }
  if (detected.length === 0) return;

  if (anyHooksInstalled(detected)) return;

  const detectedProps = { detected_clis: detected, detected_count: detected.length };

  if (!stdin.isTTY || !stdout.isTTY) {
    stdout.write(
      `\n[failproofai] No policies are installed. Run \`failproofai policies --install\` to set them up.\n` +
        `[failproofai] Launching dashboard…\n\n`,
    );
    await emit("first_run_nudge_skipped_noninteractive", detectedProps);
    return;
  }

  stdout.write(
    `\n┌─ Failproof AI — first-run setup ────────────────────────────────────\n` +
      `│  Detected agent CLI(s): ${clisLabel(detected)}\n` +
      `│  Policies block unsafe actions (sudo, rm -rf /, secret leaks, …)\n` +
      `│  before your agent runs them. Nothing is installed yet.\n` +
      `└──────────────────────────────────────────────────────────────────────\n\n` +
      `  Disable this prompt anytime: FAILPROOFAI_NO_FIRST_RUN=1\n\n`,
  );

  await emit("first_run_nudge_shown", detectedProps);

  const answer = await promptYesNo(stdin, stdout);

  if (answer === "sigint") {
    await emit("first_run_nudge_declined", { ...detectedProps, reason: "sigint" });
    process.exit(130);
  }

  if (answer === "no") {
    await emit("first_run_nudge_declined", { ...detectedProps, reason: "user_no" });
    return;
  }

  await emit("first_run_nudge_accepted", {
    ...detectedProps,
    target_scope: "user",
    source: "first-run-nudge",
  });

  await installHooks(
    undefined,
    "user",
    undefined,
    false,
    "first-run-nudge",
    undefined,
    false,
    detected,
  );
  process.exit(0);
}
