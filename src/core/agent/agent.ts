import {
  generateText,
  type GenerateTextOptions,
  type GenerateTextResult,
  type Prompt,
  type RetryOptions,
  type TimeoutOptions,
} from "../generation/generate-text";
import { streamText, type StreamTextResult } from "../generation/stream-text";
import {
  generateObjectInternal,
  streamObjectInternal,
  type ArrayOutputOptions,
  type EnumOutputOptions,
  type GenerateObjectResult,
  type JsonOutputOptions,
  type ObjectOutputOptions,
  type OutputRepair,
  type StreamObjectResult,
} from "../generation/generate-object";
import { AgentSdkError } from "../errors/errors";
import type { AnyTool, ToolSet } from "../tools/tool";
import type { LanguageModel } from "../model/types";
import type { TelemetryOptions } from "../telemetry/telemetry";
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
  readonly telemetry?: TelemetryOptions | undefined;
}

export type AgentRunOptions = Prompt & {
  readonly abortSignal?: AbortSignal | undefined;
  readonly runId?: string | undefined;
  readonly context?: unknown;
};

type AgentStructuredRunOptions = AgentRunOptions & {
  readonly repair?: OutputRepair | undefined;
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

  runObject<Output>(
    options: AgentStructuredRunOptions & ObjectOutputOptions<Output>,
  ): Promise<GenerateObjectResult<Output>>;
  runObject<Element>(
    options: AgentStructuredRunOptions & ArrayOutputOptions<Element>,
  ): Promise<GenerateObjectResult<readonly Element[]>>;
  runObject<const Values extends readonly string[]>(
    options: AgentStructuredRunOptions & EnumOutputOptions<Values>,
  ): Promise<GenerateObjectResult<Values[number]>>;
  runObject(
    options: AgentStructuredRunOptions & JsonOutputOptions,
  ): Promise<GenerateObjectResult<import("../model/types").JsonValue>>;
  runObject(
    options: AgentStructuredRunOptions &
      (
        | ObjectOutputOptions<unknown>
        | ArrayOutputOptions<unknown>
        | EnumOutputOptions<readonly string[]>
        | JsonOutputOptions
      ),
  ): Promise<GenerateObjectResult<unknown>> {
    return generateObjectInternal(this.toGenerateOptions(options), options);
  }

  streamObject<Output>(
    options: AgentStructuredRunOptions & ObjectOutputOptions<Output>,
  ): StreamObjectResult<Output>;
  streamObject<Element>(
    options: AgentStructuredRunOptions & ArrayOutputOptions<Element>,
  ): StreamObjectResult<readonly Element[]>;
  streamObject<const Values extends readonly string[]>(
    options: AgentStructuredRunOptions & EnumOutputOptions<Values>,
  ): StreamObjectResult<Values[number]>;
  streamObject(
    options: AgentStructuredRunOptions & JsonOutputOptions,
  ): StreamObjectResult<import("../model/types").JsonValue>;
  streamObject(
    options: AgentStructuredRunOptions &
      (
        | ObjectOutputOptions<unknown>
        | ArrayOutputOptions<unknown>
        | EnumOutputOptions<readonly string[]>
        | JsonOutputOptions
      ),
  ): StreamObjectResult<unknown> {
    return streamObjectInternal(this.toGenerateOptions(options), options);
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
      telemetry: this.settings.telemetry,
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
