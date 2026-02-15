import { describe, expect, it, vi, afterEach } from "vitest";

import { GeminiProvider, GroqProvider, ProviderError } from "./index.js";

describe("provider adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  it("maps provider rate limit responses to retryable errors", async () => {
    process.env.GEMINI_API_KEY = "test";
    const provider = new GeminiProvider("gemini-test");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "quota exceeded"
      })
    );

    await expect(provider.generate("hello")).rejects.toMatchObject<Partial<ProviderError>>({
      code: "RATE_LIMIT",
      retryable: true,
      provider: "gemini"
    });
  });

  it("parses groq tool call payload", async () => {
    process.env.GROQ_API_KEY = "test";
    const provider = new GroqProvider("groq-test");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok", tool_calls: [{ function: { name: "run", arguments: '{"cmd":"echo hi"}' } }] } }]
        })
      })
    );

    const result = await provider.toolCall({
      prompt: "run command",
      tools: [{ name: "run", parameters: { type: "object" } }]
    });

    expect(result).toEqual({ toolName: "run", arguments: { cmd: "echo hi" }, rawText: "ok" });
  });
});
