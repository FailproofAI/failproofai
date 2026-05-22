import type { Detector, DetectorSessionState } from "../types";

const STATE_KEY = "rereadAfterEdit";
const WINDOW = 5;

interface RereadState {
  /** Map of file_path → number of remaining tool-calls in which a Read should
   *  trigger this detector. Decremented every tool event; deleted at 0. */
  countdown: Map<string, number>;
}

function getState(state: DetectorSessionState): RereadState {
  let s = state[STATE_KEY] as RereadState | undefined;
  if (!s) {
    s = { countdown: new Map() };
    state[STATE_KEY] = s;
  }
  return s;
}

/** When Edit or Write lands on file_path, then a subsequent Read of the same
 *  file_path within N tool calls is wasteful — the editor already returned the
 *  updated content. Explicitly called out in the Claude system prompt. */
export const rereadAfterEdit: Detector = {
  name: "reread-after-edit",
  description: "Read of a file that was just Edit'd or Write'n in the same session.",
  category: "Wasteful",
  severity: "info",
  detect(event, sessionState) {
    const state = getState(sessionState);
    const filePath = (event.toolInput as { file_path?: unknown }).file_path;
    const pathStr = typeof filePath === "string" ? filePath : null;

    // Tick down every existing countdown.
    for (const [key, n] of state.countdown) {
      if (n <= 1) state.countdown.delete(key);
      else state.countdown.set(key, n - 1);
    }

    if (!pathStr) return null;

    if (event.toolName === "Edit" || event.toolName === "Write") {
      state.countdown.set(pathStr, WINDOW);
      return null;
    }

    if (event.toolName === "Read") {
      if (state.countdown.has(pathStr)) {
        state.countdown.delete(pathStr); // count once per edit-then-read pair
        return { example: `Read ${pathStr} immediately after Edit/Write` };
      }
    }

    return null;
  },
};
