import { LifecycleCallbackError, type AgentSdkError } from "../errors/errors";
import type {
  LanguageModel,
  ModelMessage,
  ProviderOptions,
  ToolCall,
  Usage,
} from "../model/types";
import type { ToolApprovalOutcome, ToolExecutionContext } from "../tools/tool";
import type { StepResult } from "./generate-text";

export type MaybePromise<T> = T | Promise<T>;

export interface RunContext {
  readonly runId: string;
  readonly context?: unknown;
}

export interface StepContext extends RunContext {
  readonly stepNumber: number;
  readonly messages: readonly ModelMessage[];
  readonly steps: readonly StepResult[];
  readonly usage: Usage;
}

export interface PrepareStepResult {
  readonly model?: LanguageModel | undefined;
  readonly activeTools?: readonly string[] | undefined;
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly providerOptions?: ProviderOptions | undefined;
}

export type PrepareStep = (
  context: StepContext,
) => MaybePromise<PrepareStepResult>;

export type StopCondition = (
  context: StepContext & {
    readonly toolCalls: readonly ToolCall[];
  },
) => MaybePromise<boolean>;

export const isStepCount =
  (count: number): StopCondition =>
  ({ stepNumber }) =>
    stepNumber >= count;

export const hasToolCall =
  (toolName: string): StopCondition =>
  ({ toolCalls }) =>
    toolCalls.some((call) => call.toolName === toolName);

export const tokenBudgetExceeded =
  (maximum: number): StopCondition =>
  ({ usage }) =>
    usage.totalTokens >= maximum;

export interface TokenBudget {
  readonly maxInputTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly maxTotalTokens?: number | undefined;
}

export interface Cost {
  readonly amount: number;
  readonly currency: string;
}

export interface CostBudget {
  readonly maximum: Cost;
  readonly calculate: (options: {
    readonly model: LanguageModel;
    readonly usage: Usage;
  }) => Cost;
}

export interface RunBudget {
  readonly tokens?: TokenBudget | undefined;
  readonly cost?: CostBudget | undefined;
}

export interface ToolExecutionPolicy {
  readonly mode?: "sequential" | "parallel" | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly errorMode?: "fail-fast" | "return-errors" | undefined;
}

export interface ToolApprovalRequest extends ToolExecutionContext {
  readonly toolName: string;
  readonly input: unknown;
}

export type RequestToolApproval = (
  request: ToolApprovalRequest,
) => MaybePromise<ToolApprovalOutcome>;

export interface ContextManager {
  readonly prepareMessages?: (
    context: StepContext,
  ) => MaybePromise<readonly ModelMessage[]>;
}

export interface ToolLifecycleEvent extends RunContext {
  readonly stepNumber: number;
  readonly toolCall: ToolCall;
}

export interface ToolLifecycleEndEvent extends ToolLifecycleEvent {
  readonly outcome: "success" | "error" | "denied";
  readonly output?: unknown;
  readonly error?: unknown;
}

export interface LifecycleCallbacks {
  readonly onStart?: (event: RunContext) => MaybePromise<void>;
  readonly onStepStart?: (event: StepContext) => MaybePromise<void>;
  readonly onToolExecutionStart?: (
    event: ToolLifecycleEvent,
  ) => MaybePromise<void>;
  readonly onToolExecutionEnd?: (
    event: ToolLifecycleEndEvent,
  ) => MaybePromise<void>;
  readonly onStepEnd?: (event: StepResult & RunContext) => MaybePromise<void>;
  readonly onFinish?: (
    event: RunContext & {
      readonly steps: readonly StepResult[];
      readonly usage: Usage;
    },
  ) => MaybePromise<void>;
  readonly onError?: (
    event: RunContext & { readonly error: unknown },
  ) => MaybePromise<void>;
  readonly onRetry?: (event: {
    readonly attempt: number;
    readonly maxRetries: number;
    readonly delayMs: number;
    readonly error: AgentSdkError;
  }) => MaybePromise<void>;
}

export const invokeLifecycle = async <Event>(
  callback: ((event: Event) => MaybePromise<void>) | undefined,
  name: keyof LifecycleCallbacks,
  event: Event,
): Promise<void> => {
  if (!callback) return;
  try {
    await callback(event);
  } catch (cause) {
    throw new LifecycleCallbackError({ callback: name, cause });
  }
};
