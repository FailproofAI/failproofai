import { OTEL_ORG_OFF, type OtelResult } from "./otel-cli";

/** Presentation only: writers and shell-ready `env` output keep their contract. */
export function otelReportLines(verb: string, result: OtelResult): string[] {
  if (result.exitCode !== 0 || verb === "env") return result.lines;
  return result.lines.flatMap(line => {
    if (verb === "status") {
      const glyph = line.includes("unreadable settings") ? "▲" :
        /^[^:]+: (?:on\b|listening\b)/.test(line) ? "●" : "○";
      return [`${glyph} ${line}`];
    }
    if (line === OTEL_ORG_OFF) return [
      "▲ OTEL ingest is off for your org.",
      "  An admin can turn it on in Settings → OpenTelemetry.",
    ];
    if (line.startsWith("VS Code not found")) return [
      `▲ ${line}`,
      "  Install VS Code or its Copilot extension, then run `failproofai otel enable copilot`.",
    ];
    if (/OTEL enabled|OTEL disabled/.test(line)) return [`✓ ${line}`];
    if (/unchanged|no managed OTEL/.test(line)) return [`○ ${line}`];
    return [`  ${line}`];
  });
}
