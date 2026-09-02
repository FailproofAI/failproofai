/**
 * Every non-Claude session store the dashboard can read, in the order it tries
 * them. Lives here rather than in the session page so a test can assert its
 * COVERAGE against INTEGRATION_TYPES — see __tests__/lib/session-stores.test.ts.
 */
import type { LogEntry } from "./log-entries";
import { getCachedCodexSessionLog } from "./codex-sessions";
import { getCachedCopilotSessionLog } from "./copilot-sessions";
import { getCachedCursorSessionLog } from "./cursor-sessions";
import { getCachedOpenCodeSessionLog } from "./opencode-sessions";
import { getCachedPiSessionLog } from "./pi-sessions";
import { getCachedHermesSessionLog } from "./hermes-sessions";
import { getCachedOpenClawSessionLog } from "./openclaw-sessions";
import { getCachedFactorySessionLog } from "./factory-sessions";
import { getCachedDevinSessionLog } from "./devin-sessions";
import { getCachedAntigravitySessionLog } from "./antigravity-sessions";
import { getCachedGooseSessionLog } from "./goose-sessions";
import { getCachedGrokSessionLog } from "./grok-sessions";
import { getCachedQwenSessionLog } from "./qwen-sessions";
import { getCachedOriSessionLog } from "./ori-sessions";
import { getCachedClineSessionLog } from "./cline-sessions";

export type SessionCli =
  | "claude" | "codex" | "copilot" | "cursor" | "opencode" | "pi" | "hermes"
  | "openclaw" | "factory" | "devin" | "antigravity" | "goose" | "grok"
  | "qwen" | "ori" | "cline";

export interface ExternalSessionLog {
  entries: LogEntry[];
  rawLines?: Record<string, unknown>[] | null;
  cwd?: string;
}

/**
 * Every non-Claude session store, tried in order.
 *
 * This is a TABLE and not the nested if/else chain it replaces, for a reason
 * worth keeping: that chain reached TWELVE levels deep, and four integrations
 * (grok, qwen, ori, cline) were added without anyone extending it. Because the
 * innermost `else` set "Session log file not found." and `cli` defaulted to
 * "claude", every session from those four rendered with a CLAUDE CODE badge and
 * no log — the store was never consulted. A missing row here is now one line
 * missing from a list, not a level missing from a pyramid.
 */
export const EXTERNAL_SESSION_STORES: ReadonlyArray<{
  cli: Exclude<SessionCli, "claude">;
  label: string;
  load: (sessionId: string) => Promise<ExternalSessionLog | null | undefined>;
}> = [
  { cli: "codex", label: "OpenAI Codex", load: getCachedCodexSessionLog },
  { cli: "copilot", label: "GitHub Copilot", load: getCachedCopilotSessionLog },
  { cli: "cursor", label: "Cursor Agent", load: getCachedCursorSessionLog },
  { cli: "opencode", label: "OpenCode", load: getCachedOpenCodeSessionLog },
  { cli: "pi", label: "Pi", load: getCachedPiSessionLog },
  { cli: "hermes", label: "Hermes", load: getCachedHermesSessionLog },
  { cli: "openclaw", label: "OpenClaw", load: getCachedOpenClawSessionLog },
  { cli: "factory", label: "Factory Droid", load: getCachedFactorySessionLog },
  { cli: "devin", label: "Devin CLI", load: getCachedDevinSessionLog },
  { cli: "antigravity", label: "Antigravity CLI", load: getCachedAntigravitySessionLog },
  { cli: "goose", label: "Goose", load: getCachedGooseSessionLog },
  { cli: "grok", label: "grok CLI", load: getCachedGrokSessionLog },
  { cli: "qwen", label: "Qwen Code", load: getCachedQwenSessionLog },
  { cli: "ori", label: "Ori", load: getCachedOriSessionLog },
  { cli: "cline", label: "Cline", load: getCachedClineSessionLog },
];
