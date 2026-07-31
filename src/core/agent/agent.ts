import {
  generateText,
  type GenerateTextOptions,
  type GenerateTextResult,
  type Prompt,
  type RetryOptions,
  type TimeoutOptions,
} from "../generation/generate-text";
import { streamText, type StreamTextResult } from "../generation/stream-text";
import { AgentSdkError } from "../errors/errors";
import type { AnyTool, ToolSet } from "../tools/tool";
import type { LanguageModel } from "../model/types";
import type {
  ContextManager,
  LifecycleCallbacks,
  PrepareStep,
  RequestToolApproval,
  RunBudget,
  StopCondition,
  ToolExecutionPolicy,
} from "../generation/orchestration";

export interface AgentSettings<Tools extends ToolSet> {
  readonly model: LanguageModel;
  readonly instructions?: string | undefined;
  readonly tools?: Tools | undefined;
  readonly maxSteps?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly retry?: RetryOptions | undefined;
  readonly timeouts?: TimeoutOptions | undefined;
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly activeTools?: readonly (keyof Tools & string)[] | undefined;
  readonly prepareStep?: PrepareStep | undefined;
  readonly stopWhen?: StopCondition | readonly StopCondition[] | undefined;
  readonly toolExecution?: ToolExecutionPolicy | undefined;
  readonly requestToolApproval?: RequestToolApproval | undefined;
  readonly budget?: RunBudget | undefined;
  readonly contextManager?: ContextManager | undefined;
  readonly callbacks?: LifecycleCallbacks | undefined;
}

export type AgentRunOptions = Prompt & {
  readonly abortSignal?: AbortSignal | undefined;
  readonly runId?: string | undefined;
  readonly context?: unknown;
};

export class Agent<Tools extends ToolSet = ToolSet> {
  readonly settings: AgentSettings<Tools>;

  static builder(model?: LanguageModel): AgentBuilder {
    return new AgentBuilder(model);
  }

  constructor(settings: AgentSettings<Tools>) {
    this.settings = settings;
  }

  run(options: AgentRunOptions): Promise<GenerateTextResult> {
    return generateText(this.toGenerateOptions(options));
  }

  stream(options: AgentRunOptions): StreamTextResult {
    return streamText(this.toGenerateOptions(options));
  }

  private toGenerateOptions(
    options: AgentRunOptions,
  ): GenerateTextOptions<Tools> {
    const shared = {
      model: this.settings.model,
      system: this.settings.instructions,
      tools: this.settings.tools,
      maxSteps: this.settings.maxSteps,
      maxRetries: this.settings.maxRetries,
      retry: this.settings.retry,
      timeouts: this.settings.timeouts,
      temperature: this.settings.temperature,
      maxOutputTokens: this.settings.maxOutputTokens,
      headers: this.settings.headers,
      abortSignal: options.abortSignal,
      runId: options.runId,
      context: options.context,
      activeTools: this.settings.activeTools,
      prepareStep: this.settings.prepareStep,
      stopWhen: this.settings.stopWhen,
      toolExecution: this.settings.toolExecution,
      requestToolApproval: this.settings.requestToolApproval,
      budget: this.settings.budget,
      contextManager: this.settings.contextManager,
      callbacks: this.settings.callbacks,
    };
    return options.prompt !== undefined
      ? { ...shared, prompt: options.prompt }
      : { ...shared, messages: options.messages };
  }
}

export class AgentBuilder {
  private model: LanguageModel | undefined;
  private instructions: string | undefined;
  private readonly registeredTools = new Map<string, AnyTool>();

  constructor(model?: LanguageModel) {
    this.model = model;
  }

  setModel(model: LanguageModel): this {
    this.model = model;
    return this;
  }

  setInstructions(instructions: string): this {
    this.instructions = instructions;
    return this;
  }

  tool(definition: AnyTool): this {
    if (this.registeredTools.has(definition.name)) {
      throw new AgentSdkError({
        code: "INVALID_ARGUMENT",
        message: `Tool "${definition.name}" is already registered`,
      });
    }
    this.registeredTools.set(definition.name, definition);
    return this;
  }

  toolList(definitions: readonly AnyTool[]): this {
    for (const definition of definitions) this.tool(definition);
    return this;
  }

  build(): Agent {
    if (!this.model) {
      throw new AgentSdkError({
        code: "INVALID_ARGUMENT",
        message: "Agent builder requires a language model",
      });
    }

    return new Agent({
      model: this.model,
      instructions: this.instructions,
      tools: Object.fromEntries(this.registeredTools),
    });
  }
}
