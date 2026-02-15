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

    await expect(provider.generate("hello")).rejects.toMatchObject({
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

  it("repairs malformed JSON once and returns structured data", async () => {
    process.env.GROQ_API_KEY = "test";
    const provider = new GroqProvider("groq-test");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '{"name": ' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '{"name":"alice"}' } }] }) });

    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.structuredOutput<{ name: string }>({
      prompt: "return a user",
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false
      }
    });

    expect(result).toEqual({ name: "alice" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const repairRequest = JSON.parse(fetchMock.mock.calls[1][1].body as string) as { messages: Array<{ content: string }> };
    expect(repairRequest.messages[0].content).toContain("Return corrected JSON only");
  });

  it("returns rich metadata for partial JSON when retries are exhausted", async () => {
    process.env.GROQ_API_KEY = "test";
    const provider = new GroqProvider("groq-test");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"name":"alice"' } }] })
      })
    );

    await expect(
      provider.structuredOutput<{ name: string }>({
        prompt: "return a user",
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false
        },
        repairRetries: 0
      })
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      validationErrors: [{ path: "$", expected: "valid JSON object", received: '{"name":"alice"' }]
    });
  });

  it("returns rich metadata for schema-incompatible JSON", async () => {
    process.env.GROQ_API_KEY = "test";
    const provider = new GroqProvider("groq-test");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"age":"old"}' } }] })
      })
    );

    await expect(
      provider.structuredOutput<{ age: number }>({
        prompt: "return an age",
        schema: {
          type: "object",
          properties: { age: { type: "number" } },
          required: ["age"],
          additionalProperties: false
        },
        repairRetries: 0
      })
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      validationErrors: [{ path: "$.age", expected: "type number", received: "old" }]
    });
  });
});
