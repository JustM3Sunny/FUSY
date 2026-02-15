import { describe, expect, it, vi } from "vitest";

import { ProviderRouter } from "./index.js";
import type { LLMProvider } from "@fusy/providers";
import { ProviderError } from "@fusy/providers";

const makeProvider = (name: "gemini" | "groq", overrides: Partial<LLMProvider> = {}): LLMProvider => ({
  name,
  model: `${name}-test`,
  capabilities: {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    maxContextTokens: name === "gemini" ? 1_000_000 : 128_000,
    preferredForLowLatency: name === "groq",
    preferredForLowCost: name === "gemini"
  },
  generate: vi.fn(async (prompt: string) => prompt),
  stream: async function* stream() {},
  toolCall: vi.fn(),
  structuredOutput: vi.fn(),
  ...overrides
});

describe("provider router", () => {
  it("selects low-cost provider for low budget", () => {
    const router = new ProviderRouter([makeProvider("gemini"), makeProvider("groq")]);
    const plan = router.plan({ taskType: "chat", budget: "low" });
    expect(plan.primary.name).toBe("gemini");
  });

  it("falls back on retryable errors", async () => {
    const failing = makeProvider("groq", {
      generate: vi.fn(async () => {
        throw new ProviderError({ provider: "groq", code: "TRANSIENT", message: "fail", retryable: true });
      })
    });
    const succeeding = makeProvider("gemini", { generate: vi.fn(async () => "ok") });

    const router = new ProviderRouter([failing, succeeding]);
    const output = await router.generateWithFallback({ taskType: "chat", budget: "balanced", prompt: "hello" });

    expect(output).toBe("ok");
    expect(failing.generate).toHaveBeenCalledTimes(1);
    expect(succeeding.generate).toHaveBeenCalledTimes(1);
  });
});
