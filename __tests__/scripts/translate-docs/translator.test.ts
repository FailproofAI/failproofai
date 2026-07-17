// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anthropic SDK so no real network call is made. `messages.stream(...)`
// returns an object with `.finalMessage()`, matching the shape translator.ts
// consumes. `streamMock` is hoisted so the vi.mock factory can close over it.
const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { stream: streamMock };
  },
}));

import { translateContent } from "@/scripts/translate-docs/translator";

/** Configure the next `.finalMessage()` resolution. */
function mockFinalMessage(message: unknown): void {
  streamMock.mockReturnValue({ finalMessage: async () => message });
}

describe("translateContent", () => {
  beforeEach(() => {
    streamMock.mockReset();
  });

  it("throws when the model truncates the output at max_tokens", async () => {
    // A truncated response leaves malformed MDX (unbalanced braces) that would
    // otherwise be written to disk and cached, then fail `mintlify validate`.
    mockFinalMessage({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "# partially translated…" }],
      usage: { input_tokens: 18000, output_tokens: 64000 },
    });

    await expect(
      translateContent("# A very large document", "he", "Hebrew"),
    ).rejects.toThrow(/truncated at max_tokens/);
  });

  it("returns translated text and token counts on a complete response", async () => {
    mockFinalMessage({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "translated body" }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const result = await translateContent("# Doc", "es", "Spanish");

    expect(result.translated).toBe("translated body");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(200);
  });

  it("requests a max_tokens ceiling well above the legacy 16384 cap", async () => {
    // Regression guard: the 16384 cap was the truncation root cause. The
    // largest docs need far more headroom, so the request must ask for it.
    mockFinalMessage({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await translateContent("# Doc", "fr", "French");

    expect(streamMock).toHaveBeenCalledTimes(1);
    const requestArgs = streamMock.mock.calls[0][0] as { max_tokens: number };
    expect(requestArgs.max_tokens).toBeGreaterThan(16384);
    expect(requestArgs.max_tokens).toBe(64000);
  });
});
