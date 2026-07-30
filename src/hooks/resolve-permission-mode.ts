/**
 * Per-CLI permission mode resolver.
 *
 *   • Claude Code: reads `permission_mode` directly from the hook stdin payload.
 *     Possible values per `claude --help`: acceptEdits, auto, bypassPermissions,
 *     default, dontAsk, plan.
 *
 *   • Codex: stdin doesn't carry the permission mode. We walk
 *     ~/.codex/sessions/<YYYY>/<MM>/<DD>/<file containing sessionId>.jsonl
 *     looking for a `turn_context` record whose payload has `approval_policy`,
 *     and map: never → full-auto, on-request → default. Other values pass
 *     through. If the transcript can't be read, falls back to "default".
 *
 *     Transcript discovery (cache → today/yesterday → full tree scan) lives
 *     in `lib/codex-sessions.ts` and is shared with the dashboard's Codex
 *     session viewer. The scan itself reads only a bounded head window — see
 *     CODEX_MODE_SCAN_MAX_BYTES.
 *
 *   • GitHub Copilot CLI: no documented permission-mode equivalent on the
 *     hook payload today; falls back to "default". Revisit when Copilot's
 *     hook protocol exposes one.
 *
 *   • Cursor Agent CLI: no permission-mode field in the hook payload (Cursor's
 *     `loop_limit` is per-hook, not per-session). Falls back to "default" via
 *     the same final branch as Copilot.
 *
 *   • OpenCode: the plugin shim (.opencode/plugins/failproofai.mjs) does not
 *     receive any permission-mode signal from opencode and does not include
 *     one in the JSON it pipes to the failproofai binary. Falls back to
 *     "default" via the same final branch as Copilot/Cursor.
 *
 *   • Pi (pi-coding-agent): no permission-mode concept in the extension API;
 *     `tool_call` handlers always run with the same authority. Falls back to
 *     "default" via the same final branch as Copilot/Cursor.
 *
 */
import { closeSync, openSync, readSync } from "node:fs";
import { findCodexTranscript } from "../../lib/codex-sessions";
import type { IntegrationType } from "./types";

/**
 * Head-window bound for the Codex transcript scan.
 *
 * Phase 1 / Stage 0, P4. This scan sits on the **enforcement deadline path** —
 * it runs before every Codex tool call — and it used to `readFileSync` the
 * whole transcript and `split("\n")` it just to find one record near the top.
 * Codex transcripts are append-only conversation logs that reach megabytes
 * within a day and tens of megabytes over a long session. Reading all of that
 * to answer "what is the approval policy" is unbounded work whose cost grows
 * with session length — the shape of latency bug that only shows up on the
 * sessions users care most about.
 *
 * Why a *head* window is correct rather than a compromise: the scan returns the
 * **first** `turn_context` record, which Codex writes at the start of the first
 * turn — i.e. immediately after the `session_meta` header. Nothing later in the
 * file can change the answer, because the pre-bound code stopped at the first
 * match too.
 *
 * Why 256 KiB: measured across a real `~/.codex/sessions` tree, the first
 * `turn_context` sat at byte 39,620 or 84,250 — line 8 of every transcript
 * (`session_meta` embeds the base instructions, which is what puts it that far
 * in at all) — in files ranging from 115 KB to 2.8 MB. 256 KiB is ~3x the
 * largest observed offset, so a transcript with an unusually large header or a
 * large first user message still resolves, while the read cost becomes a single
 * fixed-size `pread` no matter how big the file grows: on the 2.8 MB sample
 * this took the scan from 3.07 ms to 0.54 ms with an identical verdict. No
 * existing test pins a value here (the only permission-mode coverage was
 * `handler.test.ts`'s Claude cases), so the number comes from the file format
 * rather than from a fixture.
 *
 * Beyond the window the function returns `undefined`, which
 * `resolvePermissionMode` maps to `"default"` — the same value it already
 * returns when the transcript is missing or unreadable. Degrading to the
 * documented fallback is the correct failure mode for a metadata lookup; a
 * throw here would take the whole hook down.
 */
export const CODEX_MODE_SCAN_MAX_BYTES = 256 * 1024;

/**
 * Secondary cap on lines examined inside the head window, bounding parse work
 * if a transcript's head is pathologically many tiny records. The first
 * `turn_context` is line 8 in every real transcript measured, so 2,000 leaves
 * two orders of magnitude of headroom.
 */
export const CODEX_MODE_SCAN_MAX_LINES = 2_000;

export function resolvePermissionMode(
  integration: IntegrationType,
  parsed: Record<string, unknown>,
  sessionId: string | undefined,
): string {
  if (integration === "claude") {
    return (parsed.permission_mode as string | undefined) ?? "default";
  }

  if (integration === "codex" && sessionId) {
    return resolveCodexMode(sessionId) ?? "default";
  }

  // copilot, cursor, opencode, pi, unknown integrations, or codex without a sessionId
  return "default";
}

/**
 * Read at most `maxBytes` from the start of `path`.
 *
 * `truncated` says the file has (or may have) more bytes past the window, in
 * which case the final line in `text` is very likely a fragment — a cut record
 * or even a cut multi-byte character — and the caller must discard it rather
 * than feed it to `JSON.parse`.
 */
function readHead(path: string, maxBytes: number): { text: string; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return {
      text: buf.toString("utf-8", 0, bytesRead),
      truncated: bytesRead >= maxBytes,
    };
  } finally {
    closeSync(fd);
  }
}

function resolveCodexMode(sessionId: string): string | undefined {
  try {
    const path = findCodexTranscript(sessionId);
    if (!path) return undefined;
    const { text, truncated } = readHead(path, CODEX_MODE_SCAN_MAX_BYTES);
    const lines = text.split("\n");
    if (truncated) lines.pop();
    const limit = Math.min(lines.length, CODEX_MODE_SCAN_MAX_LINES);
    for (let i = 0; i < limit; i++) {
      const line = lines[i];
      if (!line.includes("turn_context")) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === "turn_context") {
          const policy = (obj.payload as Record<string, unknown> | undefined)?.approval_policy as
            | string
            | undefined;
          if (policy === "never") return "full-auto";
          if (policy === "on-request") return "default";
          if (policy) return policy;
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // file vanished or permission denied — fall through to undefined
  }
  return undefined;
}
