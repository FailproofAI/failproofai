// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseLogContent } from "@/lib/log-entries";
import { parseCodexLog } from "@/lib/codex-sessions";
import { parseCopilotLog } from "@/lib/copilot-sessions";
import { parseCursorLog } from "@/lib/cursor-sessions";
import { parsePiLog } from "@/lib/pi-sessions";
import { hermesRowsToLogEntries } from "@/lib/hermes-sessions";
import { openclawLinesToLogEntries } from "@/lib/openclaw-sessions";
import { factoryLinesToLogEntries } from "@/lib/factory-sessions";
import { antigravityLinesToLogEntries } from "@/lib/antigravity-sessions";
import { devinRowsToLogEntries } from "@/lib/devin-sessions";
import { gooseRowsToLogEntries, type GooseMessageRow } from "@/lib/goose-sessions";
import { logEntriesToEvents } from "@/src/audit/cli-adapters/shared";
import { ADAPTERS } from "@/src/audit/cli-adapters";
import { findSecrets, flattenToolInput } from "@/src/audit/leak-scan";
import { INTEGRATION_TYPES, type IntegrationType } from "@/src/hooks/types";
import type { LogEntry } from "@/lib/log-entries";

const INPUT_SECRET = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
const RESULT_SECRET = `sk-proj-${"a".repeat(40)}`;
const T0 = "2026-09-09T00:00:00.000Z";
const T1 = "2026-09-09T00:00:01.000Z";

function jsonl(...lines: Record<string, unknown>[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

function assertLeakContract(cli: IntegrationType, entries: LogEntry[]): void {
  const events = logEntriesToEvents(entries, {
    cli,
    sessionId: `${cli}-session`,
    transcriptPath: `${cli}://session`,
    cwd: "/repo",
  });
  expect(events, `${cli} must preserve its tool call`).toHaveLength(1);
  expect(events[0].cli).toBe(cli);
  expect(findSecrets(flattenToolInput(events[0].toolInput)).map((m) => m.value))
    .toContain(INPUT_SECRET);
  expect(findSecrets(events[0].toolResultText ?? "").map((m) => m.value))
    .toContain(RESULT_SECRET);
}

describe("credential leakage parser contract", () => {
  it("registers an audit adapter for every supported CLI", () => {
    expect(Object.keys(ADAPTERS)).toEqual([...INTEGRATION_TYPES]);
  });

  it("detects tool-input and tool-output credentials in Claude", async () => {
    const entries = await parseLogContent(jsonl(
      { type: "assistant", timestamp: T0, message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: `echo ${INPUT_SECRET}` } }] } },
      { type: "user", timestamp: T1, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: RESULT_SECRET }] } },
    ));
    assertLeakContract("claude", entries);
  });

  it("detects tool-input and tool-output credentials in Codex", async () => {
    const { entries } = await parseCodexLog(jsonl(
      { type: "response_item", timestamp: T0, payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: JSON.stringify({ cmd: `echo ${INPUT_SECRET}` }) } },
      { type: "response_item", timestamp: T1, payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: RESULT_SECRET }] } },
    ));
    assertLeakContract("codex", entries);
  });

  it("detects tool-input and model-visible tool-output credentials in Copilot", async () => {
    const { entries } = await parseCopilotLog(jsonl(
      { type: "tool.execution_start", timestamp: T0, data: { toolCallId: "c1", toolName: "bash", arguments: { command: `echo ${INPUT_SECRET}` } } },
      { type: "hook.start", timestamp: T1, data: { hookType: "postToolUse", input: { toolResult: { textResultForLlm: RESULT_SECRET } } } },
    ));
    assertLeakContract("copilot", entries);
  });

  it("detects tool-input and tool-output credentials in Cursor's current format", async () => {
    const { entries } = await parseCursorLog(jsonl(
      { role: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Shell", input: { command: `echo ${INPUT_SECRET}` } }] } },
      { role: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: RESULT_SECRET }] } },
    ));
    assertLeakContract("cursor", entries);
  });

  it("detects tool-input and tool-output credentials in Pi", async () => {
    const { entries } = await parsePiLog(jsonl(
      { type: "message", timestamp: T0, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: `echo ${INPUT_SECRET}` } }] } },
      { type: "message", timestamp: T1, message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: RESULT_SECRET }] } },
    ));
    assertLeakContract("pi", entries);
  });

  it("detects tool-input and tool-output credentials in Hermes", () => {
    const entries = hermesRowsToLogEntries([
      { role: "assistant", timestamp: T0, tool_calls: JSON.stringify([{ id: "c1", function: { name: "terminal", arguments: JSON.stringify({ command: `echo ${INPUT_SECRET}` }) } }]) },
      { role: "tool", timestamp: T1, tool_call_id: "c1", content: RESULT_SECRET },
    ]);
    assertLeakContract("hermes", entries);
  });

  it("detects tool-input and tool-output credentials in OpenClaw", () => {
    const entries = openclawLinesToLogEntries([
      { type: "message", id: "a1", timestamp: T0, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "exec", arguments: { command: `echo ${INPUT_SECRET}` } }] } },
      { type: "message", id: "r1", timestamp: T1, message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: RESULT_SECRET }] } },
    ]);
    assertLeakContract("openclaw", entries);
  });

  it("detects tool-input and tool-output credentials in Factory", () => {
    const entries = factoryLinesToLogEntries([
      { type: "message", id: "a1", timestamp: T0, message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "Execute", input: { command: `echo ${INPUT_SECRET}` } }] } },
      { type: "message", id: "r1", timestamp: T1, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: RESULT_SECRET }] }] } },
    ]);
    assertLeakContract("factory", entries);
  });

  it("detects tool-input and tool-output credentials in Antigravity", () => {
    const entries = antigravityLinesToLogEntries([
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: T0, tool_calls: [{ name: "run_command", args: { CommandLine: `echo ${INPUT_SECRET}`, Cwd: "/repo" } }] },
      { step_index: 2, type: "RUN_COMMAND", created_at: T1, content: RESULT_SECRET },
    ]);
    assertLeakContract("antigravity", entries);
  });

  it("detects tool-input and tool-output credentials in Devin", () => {
    const entries = devinRowsToLogEntries([
      { role: "assistant", _created_at: 1_788_912_000, tool_calls: [{ id: "c1", name: "exec", arguments: { command: `echo ${INPUT_SECRET}` } }] },
      { role: "tool", _created_at: 1_788_912_001, tool_call_id: "c1", content: RESULT_SECRET },
    ]);
    assertLeakContract("devin", entries);
  });

  it("detects tool-input and tool-output credentials in Goose", () => {
    const rows: GooseMessageRow[] = [
      { role: "assistant", created_timestamp: 1_788_912_000_000, content_json: JSON.stringify([{ type: "toolRequest", id: "c1", toolCall: { value: { name: "shell", arguments: { command: `echo ${INPUT_SECRET}` } } } }]) },
      { role: "user", created_timestamp: 1_788_912_001_000, content_json: JSON.stringify([{ type: "toolResponse", id: "c1", toolResult: { value: { content: [{ type: "text", text: RESULT_SECRET }] } } }]) },
    ];
    assertLeakContract("goose", gooseRowsToLogEntries(rows));
  });
});
