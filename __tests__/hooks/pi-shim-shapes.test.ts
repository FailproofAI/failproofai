// @vitest-environment node
/**
 * Pi's two PreToolUse-mapped events need DIFFERENT return shapes, and both
 * handlers build the same `hook_event_name: "PreToolUse"` payload — so a
 * search-and-replace across this file can put each return in the other's
 * handler without changing a single line of behaviour that typechecks.
 *
 * That happened. The result was strictly worse than the bug being fixed: the
 * agent's `tool_call` gate (bash/read/write/edit — every tool the model calls)
 * went inert, while `user_bash` stayed inert. Both silently, because
 * `ToolCallEventResult` and `UserBashEventResult` are structurally disjoint and
 * each handler simply returns an object the consumer does not branch on.
 *
 * Vendor types (installed @earendil-works/pi-coding-agent):
 *   ToolCallEventResult  {block?, reason?}        extensions/types.d.ts:766
 *   UserBashEventResult  {operations?, result?}   extensions/types.d.ts:772
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SHIM = readFileSync(path.join(__dirname, "../../pi-extension/index.ts"), "utf8");

/** Source of one `pi.on("<event>", …)` handler, up to the next registration. */
function handler(event: string): string {
  const start = SHIM.indexOf(`pi.on("${event}"`);
  expect(start, `no pi.on("${event}") handler`).toBeGreaterThan(-1);
  const after = SHIM.indexOf("pi.on(", start + 1);
  return SHIM.slice(start, after === -1 ? undefined : after);
}

describe("pi-extension deny shapes are in the right handlers", () => {
  it("tool_call returns ToolCallEventResult {block, reason}", () => {
    const h = handler("tool_call");
    expect(h).toMatch(/return \{ block: true, reason: decision\.reason \}/);
    // The full-replacement bash shape here would leave every agent tool call
    // unguarded — agent-loop only branches on `beforeResult?.block`.
    expect(h).not.toMatch(/result:\s*\{/);
  });

  it("user_bash returns UserBashEventResult {result: BashResult}", () => {
    const h = handler("user_bash");
    expect(h).toMatch(/result:\s*\{/);
    expect(h).toMatch(/exitCode:/);
    // `block` does not exist on UserBashEventResult; returning it runs the command.
    expect(h).not.toMatch(/return \{ block: true/);
  });

  it("input returns InputEventResult, never a block field", () => {
    const h = handler("input");
    expect(h).toMatch(/action: "handled"/);
    expect(h).not.toMatch(/block: true/);
  });
});
