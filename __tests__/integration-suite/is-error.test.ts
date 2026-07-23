/**
 * Tripwire for probe-cli.sh's `is_error()`.
 *
 * The canary's three-way verdict hangs on this one regex. It decides whether a probe that
 * produced no deny is reported as ⚠️ ERROR ("vendor broke, we couldn't test") or 🟡
 * INCONCLUSIVE ("the model just never called a tool") — see report.js's statusOf().
 *
 * Its input is the agent's ENTIRE transcript, which is why the negative fixtures matter as
 * much as the positive ones: patterns loose enough to match ordinary model prose ("400
 * tests passed", "that flag is not supported") turn a chatty refusal into a fake vendor
 * outage, inverting exactly what the function exists to signal. An earlier revision of
 * this regex did precisely that with a bare `\b400\b` and a bare `not supported`.
 *
 * The function is read out of the shell script and executed by bash, so this test tracks
 * the real thing rather than a copy that can drift.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROBE_CLI = path.join(__dirname, "../../integration-suite/probe-cli.sh");

/** Pull the one-line `is_error() { ... }` definition straight out of the script. */
function extractIsError(): string {
  const line = readFileSync(PROBE_CLI, "utf8")
    .split("\n")
    .find((l) => l.startsWith("is_error()"));
  if (!line) throw new Error("is_error() not found in probe-cli.sh — was it renamed?");
  return line;
}

/** Run the real shell function against `output`; true ⇒ classified as a vendor ERROR. */
function isError(output: string): boolean {
  const script = `${extractIsError()}\nif is_error "$1"; then echo yes; else echo no; fi`;
  return execFileSync("bash", ["-c", script, "_", output], { encoding: "utf8" }).trim() === "yes";
}

describe("probe-cli.sh is_error()", () => {
  it("is present and self-contained on one line", () => {
    expect(extractIsError()).toMatch(/^is_error\(\) \{.*grep -qiE.*\}$/);
  });

  describe("vendor failures → ERROR", () => {
    // Verbatim from the 2026-07-22 codex regression (see CHANGELOG 0.0.15-beta.0).
    it.each([
      [
        "codex 0.145.0 encrypted-content 400",
        '{"error":{"message":"litellm.BadRequestError: OpenAIException - {\\n \\"error\\": {\\n \\"message\\": \\"Encrypted content is not supported with this model.\\",\\n \\"type\\": \\"invalid_request_error\\",\\n \\"param\\": \\"include\\"\\n}\\n}. Received Model Group=deepseek-v4-pro","code":"400"}}',
      ],
      [
        "model missing codex's toolset",
        "litellm.BadRequestError: OpenAIException - Tool 'tool_search' is not supported with gpt-5.4-nano-2026-03-17.",
      ],
      ["undeployed model", '{"error":{"code":"DeploymentNotFound","message":"The API deployment ..."}}'],
      ["copilot free-tier credits", "You have exceeded your quota. Please upgrade your plan to continue."],
      ["expired vendor login", "Error: not logged in. Run `cursor-agent login` first."],
      ["throttling", "429 Too Many Requests — please retry later"],
      ["bad credential", "401 Unauthorized: invalid api key supplied"],
    ])("%s", (_name, output) => {
      expect(isError(output)).toBe(true);
    });
  });

  describe("ordinary agent output → NOT an error (stays INCONCLUSIVE)", () => {
    // Every one of these was misclassified as ERROR before the patterns were tightened.
    it.each([
      ["a number that happens to be 400", "I ran the suite and 400 tests passed."],
      ["prose about an unsupported flag", "That command-line flag is not supported by this tool."],
      ["explaining an HTTP code", "The endpoint returns 400 when the body is malformed."],
      ["a refusal", "I cannot run that; the operation is not supported here."],
      ["a plain success", "I ran the command and it completed successfully."],
      ["mentioning a rate limiter it read about", "The file describes a limiter, then exits."],
    ])("%s", (_name, output) => {
      expect(isError(output)).toBe(false);
    });
  });
});
