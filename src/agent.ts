import { generateText, type GenerateTextOptions, type GenerateTextResult, type Prompt } from "./generate-text";
import { streamText, type StreamTextResult } from "./stream-text";
import type { ToolSet } from "./tool";
import type { LanguageModel } from "./types";

export interface AgentSettings<Tools extends ToolSet> {
  readonly model: LanguageModel;
  readonly instructions?: string | undefined;
  readonly tools?: Tools | undefined;
  readonly maxSteps?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export type AgentRunOptions = Prompt & {
  readonly abortSignal?: AbortSignal | undefined;
};

export class Agent<Tools extends ToolSet = ToolSet> {
  readonly settings: AgentSettings<Tools>;

  constructor(settings: AgentSettings<Tools>) {
    this.settings = settings;
  }

  run(options: AgentRunOptions): Promise<GenerateTextResult> {
    return generateText(this.toGenerateOptions(options));
  }

  stream(options: AgentRunOptions): StreamTextResult {
    return streamText(this.toGenerateOptions(options));
  }

  private toGenerateOptions(options: AgentRunOptions): GenerateTextOptions<Tools> {
    const shared = {
      model: this.settings.model,
      system: this.settings.instructions,
      tools: this.settings.tools,
      maxSteps: this.settings.maxSteps,
      maxRetries: this.settings.maxRetries,
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
