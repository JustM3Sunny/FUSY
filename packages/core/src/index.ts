import {
  type LLMCapabilities,
  type LLMGenerateOptions,
  type LLMProvider,
  type LLMStructuredOutputRequest,
  type LLMToolCallRequest,
  type LLMToolCallResult,
  ProviderError
} from "@fusy/providers";

export interface AgentState {
  id: string;
  status: "idle" | "running" | "failed";
}

export const createInitialState = (id: string): AgentState => ({
  id,
  status: "idle"
});

export type TaskType = "chat" | "reasoning" | "tooling" | "structured";
export type Budget = "low" | "balanced" | "high";

export interface RouteRequest {
  readonly taskType: TaskType;
  readonly budget: Budget;
  readonly maxLatencyMs?: number;
  readonly requiredCapabilities?: Partial<LLMCapabilities>;
  readonly prompt?: string;
}

export interface RoutePlan {
  readonly primary: LLMProvider;
  readonly fallback: readonly LLMProvider[];
}

export const WORKFLOW_STATES = [
  "INTENT_PARSE",
  "PLAN",
  "TOOL_SELECT",
  "TOOL_EXECUTE",
  "OBSERVE",
  "PATCH",
  "VERIFY",
  "SUMMARIZE"
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export interface WorkflowContext {
  intent?: string;
  plan?: string;
  selectedTools?: string[];
  toolResults?: string[];
  observations?: string;
  patch?: string;
  verification?: {
    success: boolean;
    details: string;
  };
  summary?: string;
  [key: string]: unknown;
}

export interface WorkflowCheckpoint {
  state: WorkflowState;
  context: WorkflowContext;
  reason: "manual" | "verify_failed" | "interrupted";
  timestamp: number;
}


export interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallContext {
  cwd: string;
  policy?: {
    allowList?: readonly string[];
    denyList?: readonly string[];
    requireApproval?: boolean;
    approved?: boolean;
  };
}

export type ToolInvoker = (request: ToolCallRequest, context: ToolCallContext) => Promise<unknown>;

export interface WorkflowToolTrace {
  state: WorkflowState;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  timestamp: number;
}

const isCapabilityMatch = (
  provider: LLMProvider,
  requiredCapabilities?: Partial<LLMCapabilities>
): boolean => {
  if (!requiredCapabilities) {
    return true;
  }

  return Object.entries(requiredCapabilities).every(([key, expected]) => {
    const actual = provider.capabilities[key as keyof LLMCapabilities];
    return expected === undefined || actual === expected;
  });
};

const scoreProvider = (provider: LLMProvider, request: RouteRequest): number => {
  let score = 0;

  if (request.budget === "low" && provider.capabilities.preferredForLowCost) {
    score += 4;
  }

  if (
    (request.budget === "balanced" || request.maxLatencyMs !== undefined) &&
    provider.capabilities.preferredForLowLatency
  ) {
    score += 3;
  }

  if (request.taskType === "tooling" && provider.capabilities.toolCalling) {
    score += 3;
  }

  if (request.taskType === "structured" && provider.capabilities.structuredOutput) {
    score += 3;
  }

  if (request.taskType === "reasoning") {
    score += Math.floor(provider.capabilities.maxContextTokens / 100_000);
  }

  return score;
};

export class ProviderRouter {
  private readonly byName: Record<string, LLMProvider>;

  constructor(private readonly providers: readonly LLMProvider[]) {
    this.byName = Object.fromEntries(providers.map((provider) => [provider.name, provider]));
  }

  plan(request: RouteRequest): RoutePlan {
    const candidates = this.providers
      .filter((provider) => isCapabilityMatch(provider, request.requiredCapabilities))
      .sort((left, right) => scoreProvider(right, request) - scoreProvider(left, request));

    if (candidates.length === 0) {
      throw new Error("No providers match requested capabilities");
    }

    const primary = candidates[0];
    const matrix: Record<string, readonly string[]> = {
      gemini: ["groq", "gemini"],
      groq: ["gemini", "groq"]
    };

    const fallback = (matrix[primary.name] ?? [])
      .map((providerName) => this.byName[providerName])
      .filter((provider): provider is LLMProvider => provider !== undefined);

    return { primary, fallback };
  }

  async generateWithFallback(request: RouteRequest, options?: LLMGenerateOptions): Promise<string> {
    const prompt = request.prompt ?? "";
    return this.executeWithFallback(
      request,
      (provider, isReducedContextRetry) =>
        provider.generate(
          isReducedContextRetry ? this.reducePromptContext(prompt) : prompt,
          options
        )
    );
  }

  async toolCallWithFallback(request: RouteRequest, toolRequest: LLMToolCallRequest): Promise<LLMToolCallResult> {
    return this.executeWithFallback(request, (provider) => provider.toolCall(toolRequest));
  }

  async structuredOutputWithFallback<T>(
    request: RouteRequest,
    structuredRequest: LLMStructuredOutputRequest
  ): Promise<T> {
    return this.executeWithFallback(request, (provider) => provider.structuredOutput<T>(structuredRequest));
  }

  private async executeWithFallback<T>(
    request: RouteRequest,
    operation: (provider: LLMProvider, isReducedContextRetry: boolean) => Promise<T>
  ): Promise<T> {
    const plan = this.plan(request);
    const attempts: Array<{ provider: LLMProvider; reducedContextRetry: boolean }> = [
      { provider: plan.primary, reducedContextRetry: false }
    ];

    for (const provider of plan.fallback) {
      const reducedContextRetry = provider.name === "gemini" && attempts.length > 1;
      attempts.push({ provider, reducedContextRetry });
    }

    let lastError: unknown;

    for (const attempt of attempts) {
      try {
        return await operation(attempt.provider, attempt.reducedContextRetry);
      } catch (error) {
        const normalized =
          error instanceof ProviderError
            ? error
            : new ProviderError({
                provider: attempt.provider.name,
                code: "UNKNOWN",
                message: error instanceof Error ? error.message : "Unknown routing error",
                retryable: false,
                cause: error
              });

        lastError = normalized;
        if (!normalized.retryable) {
          break;
        }
      }
    }

    throw lastError;
  }

  private reducePromptContext(prompt: string): string {
    const maxLength = 3_000;
    if (prompt.length <= maxLength) {
      return prompt;
    }

    const head = prompt.slice(0, Math.floor(maxLength * 0.6));
    const tail = prompt.slice(-Math.floor(maxLength * 0.4));
    return `${head}\n...[context trimmed for retry]...\n${tail}`;
  }
}

const NEXT_STATE: Record<WorkflowState, WorkflowState | null> = {
  INTENT_PARSE: "PLAN",
  PLAN: "TOOL_SELECT",
  TOOL_SELECT: "TOOL_EXECUTE",
  TOOL_EXECUTE: "OBSERVE",
  OBSERVE: "PATCH",
  PATCH: "VERIFY",
  VERIFY: "SUMMARIZE",
  SUMMARIZE: null
};

export class WorkflowStateMachine {
  private currentState: WorkflowState = "INTENT_PARSE";
  private readonly history: WorkflowState[] = ["INTENT_PARSE"];
  private readonly checkpoints: WorkflowCheckpoint[] = [];
  private readonly toolTraces: WorkflowToolTrace[] = [];

  constructor(private readonly context: WorkflowContext = {}) {}

  get state(): WorkflowState {
    return this.currentState;
  }

  get snapshot(): WorkflowContext {
    return { ...this.context };
  }

  get checkpointHistory(): readonly WorkflowCheckpoint[] {
    return this.checkpoints;
  }

  get traceHistory(): readonly WorkflowToolTrace[] {
    return this.toolTraces;
  }

  advance(partial: WorkflowContext = {}): WorkflowState {
    Object.assign(this.context, partial);

    if (this.currentState === "VERIFY" && this.context.verification?.success === false) {
      this.createCheckpoint("verify_failed");
      return this.rollbackTo("PATCH");
    }

    const next = NEXT_STATE[this.currentState];
    if (next === null) {
      return this.currentState;
    }

    this.currentState = next;
    this.history.push(next);
    return this.currentState;
  }


  async runTool(request: ToolCallRequest, context: ToolCallContext, invoker: ToolInvoker): Promise<unknown> {
    const result = await invoker(request, context);
    const trace: WorkflowToolTrace = {
      state: this.currentState,
      toolName: request.name,
      args: request.args,
      result,
      timestamp: Date.now()
    };

    this.toolTraces.push(trace);
    return result;
  }

  checkpoint(reason: WorkflowCheckpoint["reason"] = "manual"): WorkflowCheckpoint {
    return this.createCheckpoint(reason);
  }

  rollbackTo(state: WorkflowState): WorkflowState {
    this.currentState = state;
    this.history.push(state);
    return this.currentState;
  }

  rollbackForInterruption(): WorkflowState {
    this.createCheckpoint("interrupted");
    return this.rollbackTo("OBSERVE");
  }

  private createCheckpoint(reason: WorkflowCheckpoint["reason"]): WorkflowCheckpoint {
    const checkpoint: WorkflowCheckpoint = {
      state: this.currentState,
      context: structuredClone(this.context),
      reason,
      timestamp: Date.now()
    };

    this.checkpoints.push(checkpoint);
    return checkpoint;
  }
}
