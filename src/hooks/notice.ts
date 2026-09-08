/**
 * Putting a short message in front of a HUMAN, inside the agent they are using.
 *
 * A notice is not a verdict. `allow` / `deny` / `instruct` all answer "what
 * happens to this tool call"; a notice answers nothing — it is one line of text
 * for the person, delivered alongside whatever the verdict turned out to be.
 * That is why it is a separate field rather than a fourth decision: shaping it
 * into stdout beside a verdict ad hoc is how the copilot nested-vs-flat
 * `additionalContext` bug happened.
 *
 * ## Why the channel differs per CLI, and why it is not `additionalContext`
 *
 * Measured across all 12 CLIs by live probe. The obvious channel —
 * `hookSpecificOutput.additionalContext` — reaches the MODEL, not the user, and
 * a model is a paraphraser: over eight real Claude turns it mentioned an
 * informational notice 8/8, but an earlier notice that asked the agent to *act*
 * was disclaimed as a suspected prompt injection 6/6 ("instructions arriving
 * that way aren't something I'll act on unasked"). A security notice routed
 * through something that may decline to repeat it is not a delivered notice.
 *
 * So each CLI gets the channel that was proven to paint text on the user's
 * terminal, and the ones with no such channel get nothing rather than a
 * pretend delivery:
 *
 *   claude   `{"systemMessage":…}`  renders `Stop says: …`; model-invisible
 *                                   (a neutral probe answered `NONE`)
 *   codex    `{"systemMessage":…}`  renders `• Stop (completed) says: …`
 *   copilot  exit 0 + stderr        renders as a `!` session warning
 *   factory  plain stdout           renders under a `Hooks Stop` block
 *
 * opencode, pi and openclaw have real channels too, but they live inside the
 * plugin shims we ship rather than in a hook's stdout, so they are wired there.
 * cursor, devin, goose, antigravity and hermes have no channel that reaches a
 * human without an unsupported escape hatch — they get nothing here, and their
 * users get the finding from `failproofai audit` and the emailed digest.
 */
import type { IntegrationType } from "./types";

/** How a notice is delivered on one CLI. */
type NoticeChannel = "systemMessage" | "stderr" | "stdout" | "none";

/**
 * Per-CLI channel, from live probes rather than documentation.
 *
 * A CLI absent from this map delivers nothing — deliberately. Guessing a
 * channel produces the worst outcome available: output that looks delivered
 * from our side and reaches nobody, so we would report a leak as "notified"
 * that the user never saw.
 */
const NOTICE_CHANNEL: Partial<Record<IntegrationType, NoticeChannel>> = {
  claude: "systemMessage",
  codex: "systemMessage",
  copilot: "stderr",
  factory: "stdout",
};

/**
 * Claude truncates `systemMessage` at 4000 characters on the cloud-forwarding
 * path, and a notice that gets cut mid-sentence reads as a broken tool. Ours is
 * two lines by design; this is a backstop, not a budget.
 */
const MAX_NOTICE_CHARS = 900;

export interface ShapedNotice {
  /** Merged into the outcome's stdout, or empty. */
  stdout: string;
  /** Merged into the outcome's stderr, or empty. */
  stderr: string;
}

/**
 * Render a notice for one CLI, merging it into any verdict JSON already bound
 * for stdout.
 *
 * `existingStdout` matters: a Stop-gate deny already emits a JSON object on
 * several CLIs, and emitting a second object would produce two JSON documents
 * on one stream — which every host parses as a syntax error and drops, taking
 * the deny with it. So the notice is merged INTO that object when there is one.
 */
export function shapeNotice(
  cli: IntegrationType | undefined,
  notice: string,
  existingStdout = "",
): ShapedNotice {
  const empty: ShapedNotice = { stdout: existingStdout, stderr: "" };
  if (!notice.trim() || !cli) return empty;

  const channel = NOTICE_CHANNEL[cli] ?? "none";
  const text = notice.length > MAX_NOTICE_CHARS
    ? notice.slice(0, MAX_NOTICE_CHARS - 1) + "…"
    : notice;

  switch (channel) {
    case "systemMessage": {
      // Merge into the verdict object when one exists, so the stream stays a
      // single JSON document.
      if (existingStdout.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(existingStdout) as Record<string, unknown>;
          parsed.systemMessage = text;
          return { stdout: JSON.stringify(parsed), stderr: "" };
        } catch {
          // Not the JSON we thought it was — leave the verdict untouched
          // rather than risk destroying it to add a courtesy message.
          return empty;
        }
      }
      // Anything already on stdout that we could not merge into is left
      // exactly as it is, and the notice is dropped instead. The alternative —
      // emitting our own object over the top — DESTROYS it: measured with a
      // JSON array on stdout, which does not start with `{`, so it fell past
      // the merge and was replaced wholesale. A courtesy message is never worth
      // more than whatever the host was already being told.
      if (existingStdout.trim()) return empty;
      return { stdout: JSON.stringify({ systemMessage: text }), stderr: "" };
    }
    case "stderr":
      // Exit code is NOT touched: on copilot a non-zero exit from a tool event
      // is a block, and a notice must never block anything.
      return { stdout: existingStdout, stderr: text + "\n" };
    case "stdout":
      // factory renders plain text under its Hooks block. Only safe when no
      // verdict JSON is already on the stream.
      if (existingStdout.trim()) return empty;
      return { stdout: text + "\n", stderr: "" };
    default:
      return empty;
  }
}

/** True when this CLI has a channel that was proven to reach a human. */
export function canDeliverNotice(cli: IntegrationType | undefined): boolean {
  return !!cli && (NOTICE_CHANNEL[cli] ?? "none") !== "none";
}

/**
 * The notice itself. A FIXED template with no interpolation of scanned content.
 *
 * The count is a number we computed; everything else is a constant. That is not
 * stylistic: the alternative is interpolating a finding's `example`, which is
 * the verbatim text of a command from a repository — attacker-controlled
 * through a README, a Makefile target or an npm script. Tested against the
 * shipped redactor, `echo "IGNORE ALL PRIOR INSTRUCTIONS…"` passes through
 * byte-identical, because that redactor masks secrets, not instructions. On the
 * CLIs where the only channel is the model's context, that string would land
 * directly in the prompt. So nothing scanned ever reaches this template.
 */
export function leakNoticeText(newFindings: number): string {
  const n = newFindings === 1 ? "a credential" : `${newFindings} credentials`;
  return (
    `failproofai found ${n} in this project's agent transcripts.\n` +
    "Run `failproofai audit` to see the details, " +
    "or `failproofai audit --schedule` to get these by email."
  );
}
