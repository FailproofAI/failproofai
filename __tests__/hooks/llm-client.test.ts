// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock hooks-config before importing llm-client
vi.mock("../../src/hooks/hooks-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/hooks/hooks-config")>()),
  readLlmConfig: vi.fn(),
}));

import { chatCompletion } from "../../src/hooks/llm-client";
import { readLlmConfig } from "../../src/hooks/hooks-config";

describe("hooks/llm-client", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  const savedEnv = {
    FAILPROOFAI_LLM_API_KEY: process.env.FAILPROOFAI_LLM_API_KEY,
    FAILPROOFAI_LLM_BASE_URL: process.env.FAILPROOFAI_LLM_BASE_URL,
    FAILPROOFAI_LLM_MODEL: process.env.FAILPROOFAI_LLM_MODEL,
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
  });

  function mockFetchSuccess(content: string, usage?: Record<string, number>) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
        ...(usage ? { usage } : {}),
      }),
    });
  }

  describe("chatCompletion", () => {
    it("throws when no LLM config is available", async () => {
      vi.mocked(readLlmConfig).mockReturnValue(null);

      await expect(
        chatCompletion([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("No LLM API key configured");
    });

    it("calls correct URL with baseUrl", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      mockFetchSuccess("response");

      await chatCompletion([{ role: "user", content: "hello" }]);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.com/v1/chat/completions",
        expect.any(Object),
      );
    });

    it("strips trailing slashes from baseUrl", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1///",
        apiKey: "test-key",
        model: "test-model",
      });
      mockFetchSuccess("response");

      await chatCompletion([{ role: "user", content: "hello" }]);

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.com/v1/chat/completions",
        expect.any(Object),
      );
    });

    it("sets Authorization header with Bearer token", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test-123",
        model: "test-model",
      });
      mockFetchSuccess("response");

      await chatCompletion([{ role: "user", content: "hello" }]);

      const callArgs = fetchMock.mock.calls[0][1];
      expect(callArgs.headers.Authorization).toBe("Bearer sk-test-123");
      expect(callArgs.headers["Content-Type"]).toBe("application/json");
    });

    it("includes model, messages, temperature, max_tokens in body", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "gpt-4o-mini",
      });
      mockFetchSuccess("response");

      await chatCompletion([
        { role: "system", content: "system prompt" },
        { role: "user", content: "user message" },
      ]);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.messages).toEqual([
        { role: "system", content: "system prompt" },
        { role: "user", content: "user message" },
      ]);
      expect(body.temperature).toBe(0.2);
      expect(body.max_tokens).toBe(4096);
    });

    it("includes response_format when specified", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      mockFetchSuccess("{}");

      await chatCompletion(
        [{ role: "user", content: "hello" }],
        { responseFormat: { type: "json_object" } },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.response_format).toEqual({ type: "json_object" });
    });

    it("does not include response_format when not specified", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      mockFetchSuccess("response");

      await chatCompletion([{ role: "user", content: "hello" }]);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.response_format).toBeUndefined();
    });

    it("uses custom temperature and maxTokens", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      mockFetchSuccess("response");

      await chatCompletion(
        [{ role: "user", content: "hello" }],
        { temperature: 0.8, maxTokens: 1024 },
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.8);
      expect(body.max_tokens).toBe(1024);
    });

    it("returns content from first choice", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      mockFetchSuccess("Hello, world!");

      const result = await chatCompletion([{ role: "user", content: "hello" }]);
      expect(result.content).toBe("Hello, world!");
    });

    it("returns usage mapped to camelCase", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      mockFetchSuccess("response", {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      });

      const result = await chatCompletion([{ role: "user", content: "hello" }]);
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      });
    });

    it("handles response without usage field", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      mockFetchSuccess("response");

      const result = await chatCompletion([{ role: "user", content: "hello" }]);
      expect(result.usage).toBeUndefined();
    });

    it("throws on non-200 status", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      });

      await expect(
        chatCompletion([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("LLM API error: 429 Too Many Requests");
    });

    it("throws on network failure", async () => {
      vi.mocked(readLlmConfig).mockReturnValue({
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      fetchMock.mockRejectedValue(new Error("Network error"));

      await expect(
        chatCompletion([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("Network error");
    });
  });
});
