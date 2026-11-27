/**
 * Text an agent types into a shell that is already running.
 *
 * Codex's `write_stdin` and Copilot's `write_bash` / `write_powershell` send
 * keystrokes to a shell an earlier call started. They are canonicalized to
 * `Bash` so the shell policies judge them, but their text is not in `command`,
 * the one field those policies read: Codex sends it as `chars`
 * (`{session_id, chars}`, codex-cli 0.172) and Copilot as `input`
 * (`{shellId, input, delay}`, Copilot CLI 1.0.114). With `command` empty every
 * shell policy allowed what was typed.
 *
 * So `handler.ts` moves the text into `command`, as far as it can be read as
 * whole command lines, and refuses the rest:
 *   - An empty write reads a shell's output (Codex polls that way): nothing to judge.
 *   - Text that ends a line is the lines it runs.
 *   - Keys alone (Ctrl-C, Ctrl-D, an arrow key, Enter) add no text of their own;
 *     a line they bring back from history was judged when it was first typed.
 *   - Everything else is refused: text that does not end its command (no line
 *     end, a trailing backslash, an open quote or heredoc), because the
 *     shell runs it once a later write adds the rest, which is then judged
 *     without it (`rm -rf ~/.fail` now, `proofai` and Enter next); and text
 *     mixed with editing keys (Tab completion, Ctrl-W, Ctrl-Y, a cursor key),
 *     because the line the shell runs is then not the text sent.
 *
 * Text typed into a program the shell started (a REPL, an editor) is judged as
 * shell text too: the payload does not say what reads it.
 */
import { deny, allow } from "./policy-helpers";
import type { PolicyContext, PolicyMatcher, PolicyResult } from "./policy-types";
import type { HookEventType, IntegrationType } from "./types";

export const TYPED_INPUT_GUARD_NAME = "failproofai/typed-shell-input-readable";

export const TYPED_INPUT_GUARD_DESCRIPTION =
  "Refuse text typed into a running shell that failproofai cannot read as whole command lines.";

export const TYPED_INPUT_GUARD_MATCH: PolicyMatcher = {
  events: ["PreToolUse"],
  toolNames: ["Bash"],
};

/** The raw tool names that type into a running shell, and the field each sends its text in. */
const TYPING_TOOLS: Partial<Record<IntegrationType, Record<string, string>>> = {
  codex: { write_stdin: "chars" },
  copilot: { write_bash: "input", write_powershell: "input" },
};

/** What a typing call's text gives the shell policies to read. */
export type TypedInput =
  /** Lines to judge as a command (`""` when there is nothing to judge). */
  | { kind: "command"; command: string }
  /** Text that cannot be read as whole command lines: refused. */
  | { kind: "unreadable"; why: string };

/**
 * The field a call types its text in, or undefined for a call that types
 * nothing. Known by the raw tool name, and by shape for a name the CLI already
 * reports as `Bash`: a text field beside a shell id, and no `command`.
 */
function typedTextField(cli: IntegrationType, rawToolName: string | undefined, input: Record<string, unknown>): string | undefined {
  const byName = rawToolName === undefined ? undefined : TYPING_TOOLS[cli]?.[rawToolName];
  if (byName !== undefined) return byName;
  if (input.command !== undefined) return undefined;
  if (cli === "codex" && "chars" in input && "session_id" in input) return "chars";
  if (cli === "copilot" && "input" in input && "shellId" in input) return "input";
  return undefined;
}

// A terminal escape sequence: CSI (`ESC [ … final`), SS3 (`ESC O x`), or ESC and one key.
const ESCAPE_SEQUENCE_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|[\s\S])?/g;
// A control character other than a line ending.
const EDITING_KEY_RE = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/;

/** How `text`, typed into a running shell, reads; see the module comment. */
export function readTypedText(text: unknown): TypedInput {
  if (typeof text !== "string") return { kind: "unreadable", why: "its text is not a string" };
  if (text === "") return { kind: "command", command: "" };
  const withoutEscapes = text.replace(ESCAPE_SEQUENCE_RE, "");
  const visible = withoutEscapes.replace(/[\x00-\x1f\x7f]/g, "");
  if (visible.trim() === "") return { kind: "command", command: "" };
  if (withoutEscapes !== text || EDITING_KEY_RE.test(withoutEscapes)) {
    return { kind: "unreadable", why: "it mixes text with editing keys, so the line the shell runs is not the text sent" };
  }
  const lines = withoutEscapes.replace(/\r\n?/g, "\n");
  if (!lines.endsWith("\n")) {
    return { kind: "unreadable", why: "it does not end its line, so the shell would run it with whatever is typed next" };
  }
  const command = lines.slice(0, -1);
  if (continuesPastWrite(command)) {
    return { kind: "unreadable", why: "its command continues onto a later write, which would be judged without it" };
  }
  return { kind: "command", command };
}

/**
 * Whether the shell is still reading the same command when this text ends: a
 * trailing backslash, an unclosed quote, or a heredoc whose closing line has
 * not been sent. Its rest then arrives in a later write, judged on its own
 * (`cp source \` now, `hook` and Enter next).
 */
function continuesPastWrite(command: string): boolean {
  let quote: "'" | '"' | null = null;
  const heredocs: string[] = [];
  const lines = command.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (quote === null && heredocs.length > 0) {
      if (line.replace(/^\t+/, "") === heredocs[0]) heredocs.shift();
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote === "'") {
        if (ch === "'") quote = null;
      } else if (ch === "\\") {
        if (i === line.length - 1) return true;
        i++;
      } else if (quote === '"') {
        if (ch === '"') quote = null;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        break;
      } else if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
        const m = /^<<-?\s*(['"]?)([^\s'"<>;&|()]+)\1/.exec(line.slice(i));
        if (m) {
          heredocs.push(m[2]);
          i += m[0].length - 1;
        }
      }
    }
  }
  return quote !== null || heredocs.length > 0;
}

/**
 * For a call that types into a running shell: what its text reads as.
 * Undefined for any other call, which is left exactly as it came.
 */
export function typedShellInput(
  cli: IntegrationType,
  rawToolName: string | undefined,
  canonicalToolName: string | undefined,
  toolInput: unknown,
): TypedInput | undefined {
  if (canonicalToolName !== "Bash" || !toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return undefined;
  const input = toolInput as Record<string, unknown>;
  const field = typedTextField(cli, rawToolName, input);
  if (field === undefined) return undefined;
  return readTypedText(input[field]);
}

/**
 * Lifted by a pause, which is the way through when an agent CLI changes how it
 * sends typed text, unless an enforcing Cloud policy is deployed: a pause does
 * not suspend those, and they could not read this text either. Same rule as
 * `antigravityPathGuardActive`.
 */
export function typedInputGuardActive(paused: boolean, cloudPolicies: ReadonlyArray<{ effect?: string }>): boolean {
  return !paused || cloudPolicies.some((p) => p.effect !== "observe");
}

/** The guard for one call `handler.ts` found unreadable, saying why. */
export function typedInputGuardFor(why: string): (ctx: PolicyContext) => PolicyResult {
  return (ctx) => {
    if ((ctx.eventType as HookEventType | string) !== "PreToolUse") return allow();
    return deny(
      `failproofai refused this input to a running shell because ${why}. ` +
        "Send whole command lines ending in a newline, with no editing keys.",
    );
  };
}
