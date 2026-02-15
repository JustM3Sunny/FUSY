export type ProviderName = "gemini" | "groq";

export type LLMErrorCode =
  | "RATE_LIMIT"
  | "AUTH"
  | "TIMEOUT"
  | "NETWORK"
  | "TRANSIENT"
  | "INVALID_REQUEST"
  | "UNKNOWN";

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly code: LLMErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(params: {
    provider: ProviderName;
    code: LLMErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = "ProviderError";
    this.provider = params.provider;
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable ?? false;
    this.cause = params.cause;
  }
}

export interface LLMCapabilities {
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly maxContextTokens: number;
  readonly preferredForLowLatency: boolean;
  readonly preferredForLowCost: boolean;
}

export interface LLMGenerateOptions {
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface LLMToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
}

export interface LLMToolCallRequest {
  readonly prompt: string;
  readonly tools: readonly LLMToolDefinition[];
  readonly timeoutMs?: number;
}

export interface LLMToolCallResult {
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly rawText: string;
}

export interface LLMStructuredOutputRequest {
  readonly prompt: string;
  readonly schema: Record<string, unknown>;
  readonly timeoutMs?: number;
}

export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  readonly capabilities: LLMCapabilities;
  generate(prompt: string, options?: LLMGenerateOptions): Promise<string>;
  stream(
    prompt: string,
    options?: LLMGenerateOptions
  ): AsyncGenerator<string, void, undefined>;
  toolCall(request: LLMToolCallRequest): Promise<LLMToolCallResult>;
  structuredOutput<T>(request: LLMStructuredOutputRequest): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

const normalizeProviderError = (
  provider: ProviderName,
  error: unknown,
  status?: number
): ProviderError => {
  if (error instanceof ProviderError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Unknown provider error";

  if (message.toLowerCase().includes("aborted") || message.toLowerCase().includes("timeout")) {
    return new ProviderError({
      provider,
      code: "TIMEOUT",
      message: `Request timed out for ${provider}: ${message}`,
      status,
      retryable: true,
      cause: error
    });
  }

  if (status === 401 || status === 403) {
    return new ProviderError({
      provider,
      code: "AUTH",
      message: `Authentication failed for ${provider}`,
      status,
      retryable: false,
      cause: error
    });
  }

  if (status === 429) {
    return new ProviderError({
      provider,
      code: "RATE_LIMIT",
      message: `${provider} rate limit exceeded`,
      status,
      retryable: true,
      cause: error
    });
  }

  if (status !== undefined && status >= 500) {
    return new ProviderError({
      provider,
      code: "TRANSIENT",
      message: `${provider} temporary server failure (${status})`,
      status,
      retryable: true,
      cause: error
    });
  }

  if (message.toLowerCase().includes("fetch") || message.toLowerCase().includes("network")) {
    return new ProviderError({
      provider,
      code: "NETWORK",
      message: `${provider} network failure: ${message}`,
      status,
      retryable: true,
      cause: error
    });
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return new ProviderError({
      provider,
      code: "INVALID_REQUEST",
      message: `${provider} rejected request (${status})`,
      status,
      retryable: false,
      cause: error
    });
  }

  return new ProviderError({
    provider,
    code: "UNKNOWN",
    message: `${provider} request failed: ${message}`,
    status,
    retryable: false,
    cause: error
  });
};

const parseJsonText = (value: string): Record<string, unknown> => {
  const trimmed = value.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const body = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  return JSON.parse(body) as Record<string, unknown>;
};

abstract class BaseHttpProvider implements LLMProvider {
  abstract readonly name: ProviderName;
  abstract readonly model: string;
  abstract readonly capabilities: LLMCapabilities;
  protected abstract readonly apiKeyEnv: string;

  protected get apiKey(): string {
    const key = process.env[this.apiKeyEnv];
    if (!key) {
      throw new ProviderError({
        provider: this.name,
        code: "AUTH",
        message: `${this.apiKeyEnv} is not set`,
        retryable: false
      });
    }
    return key;
  }

  protected async fetchJson<T>(
    url: string,
    init: RequestInit,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      });

      if (!response.ok) {
        const responseBody = await response.text();
        throw normalizeProviderError(this.name, new Error(responseBody), response.status);
      }

      return (await response.json()) as T;
    } catch (error) {
      throw normalizeProviderError(this.name, error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(
    prompt: string,
    options?: LLMGenerateOptions
  ): AsyncGenerator<string, void, undefined> {
    const generated = await this.generate(prompt, options);
    const tokens = generated.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      yield `${token} `;
    }
  }

  async structuredOutput<T>(request: LLMStructuredOutputRequest): Promise<T> {
    const schema = JSON.stringify(request.schema);
    const response = await this.generate(
      `${request.prompt}\n\nReturn a strict JSON object matching this schema: ${schema}`,
      { timeoutMs: request.timeoutMs }
    );

    try {
      return parseJsonText(response) as T;
    } catch (error) {
      throw normalizeProviderError(this.name, error);
    }
  }

  abstract generate(prompt: string, options?: LLMGenerateOptions): Promise<string>;
  abstract toolCall(request: LLMToolCallRequest): Promise<LLMToolCallResult>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }> };
  }>;
}

export class GeminiProvider extends BaseHttpProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  readonly capabilities: LLMCapabilities = {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    maxContextTokens: 1_000_000,
    preferredForLowLatency: false,
    preferredForLowCost: true
  };
  protected readonly apiKeyEnv = "GEMINI_API_KEY";

  constructor(model = "gemini-1.5-flash") {
    super();
    this.model = model;
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<string> {
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.maxTokens
      }
    };

    const data = await this.fetchJson<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      },
      options?.timeoutMs
    );

    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    return text.trim();
  }

  async toolCall(request: LLMToolCallRequest): Promise<LLMToolCallResult> {
    const payload = {
      contents: [{ parts: [{ text: request.prompt }] }],
      tools: [{ functionDeclarations: request.tools }]
    };

    const data = await this.fetchJson<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      },
      request.timeoutMs
    );

    const part = data.candidates?.[0]?.content?.parts?.[0];
    const functionCall = part?.functionCall;

    if (!functionCall) {
      throw new ProviderError({
        provider: this.name,
        code: "INVALID_REQUEST",
        message: "No function call returned from Gemini"
      });
    }

    return {
      toolName: functionCall.name,
      arguments: functionCall.args ?? {},
      rawText: part?.text ?? ""
    };
  }
}

interface GroqResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

export class GroqProvider extends BaseHttpProvider {
  readonly name = "groq" as const;
  readonly model: string;
  readonly capabilities: LLMCapabilities = {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    maxContextTokens: 128_000,
    preferredForLowLatency: true,
    preferredForLowCost: false
  };
  protected readonly apiKeyEnv = "GROQ_API_KEY";

  constructor(model = "llama-3.3-70b-versatile") {
    super();
    this.model = model;
  }

  async generate(prompt: string, options?: LLMGenerateOptions): Promise<string> {
    const payload = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: options?.temperature,
      max_tokens: options?.maxTokens
    };

    const data = await this.fetchJson<GroqResponse>(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(payload)
      },
      options?.timeoutMs
    );

    return data.choices?.[0]?.message?.content?.trim() ?? "";
  }

  async toolCall(request: LLMToolCallRequest): Promise<LLMToolCallResult> {
    const payload = {
      model: this.model,
      messages: [{ role: "user", content: request.prompt }],
      tools: request.tools.map((tool) => ({ type: "function", function: tool })),
      tool_choice: "auto"
    };

    const data = await this.fetchJson<GroqResponse>(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(payload)
      },
      request.timeoutMs
    );

    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0]?.function;
    if (!toolCall?.name) {
      throw new ProviderError({
        provider: this.name,
        code: "INVALID_REQUEST",
        message: "No tool call returned from Groq"
      });
    }

    return {
      toolName: toolCall.name,
      arguments: toolCall.arguments ? parseJsonText(toolCall.arguments) : {},
      rawText: data.choices?.[0]?.message?.content ?? ""
    };
  }
}
