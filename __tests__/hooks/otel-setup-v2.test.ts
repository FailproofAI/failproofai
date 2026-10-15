import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("OTEL collector restack contract", () => {
  it("keeps raw OTLP tasks outside the selected transcript lane", () => {
    const main = readFileSync(resolve(__dirname, "../../crates/failproofaid/src/main.rs"), "utf8");
    const selected = main.indexOf("selection: &cfg.agents");
    const transcriptFilter = main.indexOf("tasks.retain(|task|");
    const otlp = main.indexOf("tasks.extend(otlp_tasks)");
    expect(selected).toBeGreaterThan(0);
    expect(transcriptFilter).toBeGreaterThan(selected);
    expect(otlp).toBeGreaterThan(transcriptFilter);
    expect(main.slice(transcriptFilter, otlp)).toContain("cfg.settings.sessions_for(source)");
  });
});
