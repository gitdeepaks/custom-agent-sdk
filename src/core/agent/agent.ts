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
}

export type AgentRunOptions = Prompt & {
  readonly abortSignal?: AbortSignal | undefined;
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
