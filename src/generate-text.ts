import { AgentSdkError, ToolError, getErrorMessage } from "./errors";
import { toModelTools, type AnyTool, type ToolSet } from "./tool";
import {
  addUsage,
  zeroUsage,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
  type ModelResponse,
  type ToolCall,
  type Usage,
} from "./types";

export type Prompt =
  | { readonly prompt: string; readonly messages?: never }
  | { readonly messages: readonly ModelMessage[]; readonly prompt?: never };

export interface StepResult {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly toolResults: readonly ModelMessage[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
}

export interface GenerateTextResult {
  readonly text: string;
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  readonly steps: readonly StepResult[];
  readonly responseMessages: readonly ModelMessage[];
}

export type GenerateTextOptions<Tools extends ToolSet = ToolSet> = Prompt & {
  readonly model: LanguageModel;
  readonly system?: string | undefined;
  readonly tools?: Tools | undefined;
  readonly maxSteps?: number | undefined;
  readonly maxRetries?: number | undefined;
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly onStepFinish?: ((step: StepResult) => void | Promise<void>) | undefined;
};

export const createMessages = (options: Prompt & { readonly system?: string | undefined }): ModelMessage[] => {
  const messages: ModelMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  if (options.prompt !== undefined) messages.push({ role: "user", content: options.prompt });
  else messages.push(...options.messages);
  return messages;
};

const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export const callModel = async (
  model: LanguageModel,
  request: Parameters<LanguageModel["generate"]>[0],
  maxRetries: number,
): Promise<ModelResponse> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (request.abortSignal?.aborted) {
      throw new AgentSdkError({ code: "ABORTED", message: "Generation was aborted", cause: request.abortSignal.reason });
    }
    try {
      return await model.generate(request);
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      await sleep(100 * 2 ** attempt, request.abortSignal);
    }
  }
  throw new AgentSdkError({
    code: "MODEL_ERROR",
    message: `Model request failed: ${getErrorMessage(lastError)}`,
    cause: lastError,
    retryable: true,
  });
};

export const executeTool = async (
  call: ToolCall,
  definition: AnyTool | undefined,
  abortSignal?: AbortSignal,
): Promise<ModelMessage> => {
  if (!definition) {
    throw new ToolError({
      code: "TOOL_NOT_FOUND",
      message: `Model requested unknown tool "${call.toolName}"`,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
    });
  }
  try {
    const output = await definition.invoke(call.input, { toolCallId: call.toolCallId, abortSignal });
    return { role: "tool", toolCallId: call.toolCallId, toolName: call.toolName, output };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const code = error instanceof AgentSdkError && error.code === "TOOL_INPUT_INVALID"
      ? "TOOL_INPUT_INVALID"
      : "TOOL_EXECUTION_FAILED";
    throw new ToolError({
      code,
      message: `Tool "${call.toolName}" failed: ${getErrorMessage(error)}`,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      cause: error,
    });
  }
};

export const generateText = async <Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools>,
): Promise<GenerateTextResult> => {
  const maxSteps = options.maxSteps ?? 1;
  const maxRetries = options.maxRetries ?? 2;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new AgentSdkError({ code: "INVALID_ARGUMENT", message: "maxSteps must be a positive integer" });
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new AgentSdkError({ code: "INVALID_ARGUMENT", message: "maxRetries must be a non-negative integer" });
  }

  const messages = createMessages(options);
  const responseMessages: ModelMessage[] = [];
  const steps: StepResult[] = [];
  let usage = zeroUsage();

  for (let index = 0; index < maxSteps; index += 1) {
    const response = await callModel(options.model, {
      messages: [...messages],
      tools: toModelTools(options.tools),
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: options.abortSignal,
      headers: options.headers,
    }, maxRetries);

    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
    };
    messages.push(assistantMessage);
    responseMessages.push(assistantMessage);

    const toolResults = await Promise.all(
      response.toolCalls.map((call) => executeTool(call, options.tools?.[call.toolName], options.abortSignal)),
    );
    messages.push(...toolResults);
    responseMessages.push(...toolResults);
    usage = addUsage(usage, response.usage);

    const step: StepResult = {
      text: response.text,
      toolCalls: response.toolCalls,
      toolResults,
      finishReason: response.finishReason,
      usage: response.usage,
    };
    steps.push(step);
    await options.onStepFinish?.(step);

    if (response.toolCalls.length === 0) {
      return {
        text: response.text,
        finishReason: response.finishReason,
        usage,
        steps,
        responseMessages,
      };
    }
  }

  throw new AgentSdkError({
    code: "MAX_STEPS_EXCEEDED",
    message: `Generation did not finish within ${maxSteps} step${maxSteps === 1 ? "" : "s"}`,
  });
};
