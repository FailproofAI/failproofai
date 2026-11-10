import { describe, expect, it } from "vitest";
import { OTEL_ORG_OFF } from "../../src/hooks/otel-cli";
import { otelReportLines } from "../../src/hooks/otel-output";

describe("OTEL screen language", () => {
  it("uses state dots for status, including external and managed agents", () => {
    expect(otelReportLines("status", { exitCode: 0, lines: [
      "Org OTEL ingest: on",
      "Claude Code: on by failproofai · destination: Cloud",
      "Codex: on, not managed · destination: Cloud",
      "Codex: off · destination: none · org: on",
      "Copilot (VS Code): unreadable settings · destination: none",
      "Relay: listening on 127.0.0.1 · last upload: none",
    ] })).toEqual([
      "● Org OTEL ingest: on",
      "● Claude Code: on by failproofai · destination: Cloud",
      "● Codex: on, not managed · destination: Cloud",
      "○ Codex: off · destination: none · org: on",
      "▲ Copilot (VS Code): unreadable settings · destination: none",
      "● Relay: listening on 127.0.0.1 · last upload: none",
    ]);
  });

  it("marks enable/disable side effects and keeps details underneath", () => {
    expect(otelReportLines("enable", { exitCode: 0, lines: [
      "Claude Code OTEL enabled → Cloud.",
      "The daemon picks this up within seconds.",
      OTEL_ORG_OFF,
    ] })).toEqual([
      "✓ Claude Code OTEL enabled → Cloud.",
      "  The daemon picks this up within seconds.",
      "▲ OTEL ingest is off for your org.",
      "  An admin can turn it on in Settings → OpenTelemetry.",
    ]);
    expect(otelReportLines("disable", { exitCode: 0, lines: ["Codex OTEL disabled; previous settings restored."] })[0]).toMatch(/^✓ /);
  });

  it("gives a skipped Copilot a fix line", () => {
    expect(otelReportLines("enable", { exitCode: 0, lines: ["VS Code not found — skipping copilot"] })).toEqual([
      "▲ VS Code not found — skipping copilot",
      "  Install VS Code or its Copilot extension, then run `failproofai otel enable copilot`.",
    ]);
  });

  it("leaves shell output and failures to their existing renderers", () => {
    const lines = ["export OTEL_SERVICE_NAME='my-agent'"];
    expect(otelReportLines("env", { exitCode: 0, lines })).toBe(lines);
    const failure = ["No Cloud API key configured. Run `failproofai config` first."];
    expect(otelReportLines("enable", { exitCode: 1, lines: failure })).toBe(failure);
  });
});
