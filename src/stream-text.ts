import { AgentSdkError, getErrorMessage } from "./errors";
import {
  createMessages,
  executeTool,
  generateText,
  type GenerateTextOptions,
  type GenerateTextResult,
  type StepResult,
} from "./generate-text";
import { toModelTools, type ToolSet } from "./tool";
import { addUsage, zeroUsage, type ModelMessage, type ModelStreamPart, type ToolCall } from "./types";

export type StreamPart =
  | ModelStreamPart
  | { readonly type: "step-finish"; readonly step: number }
  | { readonly type: "error"; readonly error: AgentSdkError };

export interface StreamTextResult {
  readonly fullStream: ReadableStream<StreamPart>;
  readonly textStream: ReadableStream<string>;
  readonly result: Promise<GenerateTextResult>;
}

const streamWithProvider = async <Tools extends ToolSet>(
  options: GenerateTextOptions<Tools>,
  controller: ReadableStreamDefaultController<StreamPart>,
): Promise<GenerateTextResult> => {
  const stream = options.model.stream;
  if (!stream) {
    return generateText({
      ...options,
      onStepFinish: async (step) => {
        if (step.text.length > 0) controller.enqueue({ type: "text-delta", text: step.text });
        for (const toolCall of step.toolCalls) controller.enqueue({ type: "tool-call", toolCall });
        controller.enqueue({ type: "finish", finishReason: step.finishReason, usage: step.usage });
        controller.enqueue({ type: "step-finish", step: step.toolResults.length });
        await options.onStepFinish?.(step);
      },
    });
  }

  const maxSteps = options.maxSteps ?? 1;
  const messages = createMessages(options);
  const responseMessages: ModelMessage[] = [];
  const steps: StepResult[] = [];
  let totalUsage = zeroUsage();

  for (let index = 0; index < maxSteps; index += 1) {
    if (options.abortSignal?.aborted) {
      throw new AgentSdkError({ code: "ABORTED", message: "Generation was aborted", cause: options.abortSignal.reason });
    }

    const modelStream = await stream({
      messages: [...messages],
      tools: toModelTools(options.tools),
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: options.abortSignal,
      headers: options.headers,
    });
    const reader = modelStream.getReader();
    const toolCalls: ToolCall[] = [];
    let text = "";
    let finish: Extract<ModelStreamPart, { readonly type: "finish" }> | undefined;

    while (true) {
      const read = await reader.read();
      if (read.done) break;
      const part = read.value;
      controller.enqueue(part);
      if (part.type === "text-delta") text += part.text;
      if (part.type === "tool-call") toolCalls.push(part.toolCall);
      if (part.type === "finish") finish = part;
    }

    if (!finish) {
      throw new AgentSdkError({ code: "MODEL_ERROR", message: "Model stream ended without a finish event" });
    }

    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    messages.push(assistantMessage);
    responseMessages.push(assistantMessage);

    const toolResults = await Promise.all(
      toolCalls.map((call) => executeTool(call, options.tools?.[call.toolName], options.abortSignal)),
    );
    messages.push(...toolResults);
    responseMessages.push(...toolResults);
    totalUsage = addUsage(totalUsage, finish.usage);

    const step: StepResult = {
      text,
      toolCalls,
      toolResults,
      finishReason: finish.finishReason,
      usage: finish.usage,
    };
    steps.push(step);
    controller.enqueue({ type: "step-finish", step: index + 1 });
    await options.onStepFinish?.(step);

    if (toolCalls.length === 0) {
      return {
        text,
        finishReason: finish.finishReason,
        usage: totalUsage,
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

export const streamText = <Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools>,
): StreamTextResult => {
  let resolveResult: (result: GenerateTextResult) => void = () => undefined;
  let rejectResult: (error: unknown) => void = () => undefined;
  const result = new Promise<GenerateTextResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const source = new ReadableStream<StreamPart>({
    start(controller) {
      void streamWithProvider(options, controller).then(
        (value) => {
          resolveResult(value);
          controller.close();
        },
        (error) => {
          const sdkError = error instanceof AgentSdkError
            ? error
            : new AgentSdkError({ code: "MODEL_ERROR", message: getErrorMessage(error), cause: error });
          controller.enqueue({ type: "error", error: sdkError });
          rejectResult(sdkError);
          controller.close();
        },
      );
    },
  });

  const [fullStream, textSource] = source.tee();
  const textStream = textSource.pipeThrough(new TransformStream<StreamPart, string>({
    transform(part, controller) {
      if (part.type === "text-delta") controller.enqueue(part.text);
    },
  }));

  return { fullStream, textStream, result };
};
