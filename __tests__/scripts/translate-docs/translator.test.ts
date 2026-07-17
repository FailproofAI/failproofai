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

import {
  translateContent,
  translateValidated,
} from "@/scripts/translate-docs/translator";

/** Configure the next `.finalMessage()` resolution (sticky — same value forever). */
function mockFinalMessage(message: unknown): void {
  streamMock.mockReturnValue({ finalMessage: async () => message });
}

/** Queue ONE `end_turn` response with the given text; call once per attempt. */
function queueFinalMessage(
  text: string,
  usage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 10,
    output_tokens: 20,
  },
): void {
  streamMock.mockReturnValueOnce({
    finalMessage: async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage,
    }),
  });
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

describe("translateValidated", () => {
  const base = {
    source: "# Doc",
    lang: "de",
    langName: "German",
    label: "doc [de]",
    render: (raw: string) => raw,
  };
  /** Reject any rendered output that still contains the marker `BAD`. */
  const rejectBad = async (bytes: string): Promise<string | null> =>
    bytes.includes("BAD") ? "the output still contains BAD" : null;

  beforeEach(() => {
    streamMock.mockReset();
    // Silence the per-attempt retry warnings so test output stays readable.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("makes exactly one model call when the first translation is valid", async () => {
    queueFinalMessage("clean body");

    const result = await translateValidated({
      ...base,
      validate: async () => null,
    });

    expect(result.rendered).toBe("clean body");
    expect(result.attempts).toBe(1);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("retries with the validation error and returns the corrected translation", async () => {
    queueFinalMessage("BAD body");
    queueFinalMessage("good body");

    const result = await translateValidated({ ...base, validate: rejectBad });

    expect(result.rendered).toBe("good body");
    expect(result.attempts).toBe(2);
    expect(streamMock).toHaveBeenCalledTimes(2);
  });

  it("appends the retry feedback to the user turn and leaves the system prompt untouched", async () => {
    queueFinalMessage("BAD body");
    queueFinalMessage("good body");

    await translateValidated({
      ...base,
      validate: async (bytes) =>
        bytes.includes("BAD") ? "the frontmatter is broken on line 2" : null,
    });

    const first = streamMock.mock.calls[0][0] as {
      system: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    const second = streamMock.mock.calls[1][0] as {
      system: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    // First attempt carries no repair note.
    expect(first.messages[0].content).not.toContain("REJECTED");
    // The retry feeds the validation error back in the same user turn...
    expect(second.messages[0].content).toContain(
      "the frontmatter is broken on line 2",
    );
    expect(second.messages[0].content).toContain("Retry 2 of 3");
    // ...and never mutates the (cached) system prompt.
    expect(second.system).toEqual(first.system);
  });

  it("retries an empty translation instead of returning it", async () => {
    queueFinalMessage("   "); // whitespace-only counts as empty
    queueFinalMessage("good body");

    const result = await translateValidated({
      ...base,
      validate: async () => null,
    });

    expect(result.rendered).toBe("good body");
    expect(result.attempts).toBe(2);
  });

  it("throws after TRANSLATE_MAX_ATTEMPTS invalid translations", async () => {
    mockFinalMessage({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "BAD body" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    await expect(
      translateValidated({ ...base, validate: rejectBad }),
    ).rejects.toThrow(/still fails validation after 3 attempt/);
  });

  it("stops calling the model once the attempt cap is reached", async () => {
    mockFinalMessage({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "BAD" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await expect(
      translateValidated({ ...base, validate: rejectBad }),
    ).rejects.toThrow();
    expect(streamMock).toHaveBeenCalledTimes(3);
  });

  it("sums input and output tokens across attempts", async () => {
    queueFinalMessage("BAD body", { input_tokens: 100, output_tokens: 200 });
    queueFinalMessage("good body", { input_tokens: 50, output_tokens: 60 });

    const result = await translateValidated({ ...base, validate: rejectBad });

    expect(result.inputTokens).toBe(150);
    expect(result.outputTokens).toBe(260);
    expect(result.attempts).toBe(2);
  });

  it("does not retry a response truncated at max_tokens", async () => {
    // translateContent throws on max_tokens before returning; that is not a
    // validity failure, so translateValidated must let it propagate uncaught.
    mockFinalMessage({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "partial…" }],
      usage: { input_tokens: 1, output_tokens: 64000 },
    });

    await expect(
      translateValidated({
        ...base,
        lang: "he",
        langName: "Hebrew",
        validate: async () => null,
      }),
    ).rejects.toThrow(/truncated at max_tokens/);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the request itself throws", async () => {
    streamMock.mockReturnValue({
      finalMessage: async () => {
        throw new Error("Connection error.");
      },
    });

    await expect(
      translateValidated({ ...base, validate: async () => null }),
    ).rejects.toThrow(/Connection error/);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });
});
