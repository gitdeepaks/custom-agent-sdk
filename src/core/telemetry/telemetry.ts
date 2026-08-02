import {
  SpanStatusCode,
  context as otelContext,
  metrics,
  trace,
  type Attributes,
  type Counter,
  type Context,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { AgentSdkError } from "../errors/errors";
import type {
  LanguageModel,
  ModelRequest,
  ModelResponse,
  ModelStreamPart,
  Usage,
} from "../model/types";
import type { Cost } from "../generation/orchestration";
import type {
  LanguageModelMiddleware,
  LanguageModelMiddlewareContext,
} from "../middleware/middleware";

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Readonly<
  Record<string, TelemetryAttributeValue>
>;

export interface TelemetryOptions {
  readonly enabled?: boolean | undefined;
  readonly tracer?: Tracer | undefined;
  readonly meter?: Meter | undefined;
  readonly attributes?: TelemetryAttributes | undefined;
  readonly recordInputs?: boolean | undefined;
  readonly recordOutputs?: boolean | undefined;
  readonly recordToolInputs?: boolean | undefined;
  readonly recordToolOutputs?: boolean | undefined;
  readonly redact?: ((value: string) => string) | undefined;
}

interface MetricSet {
  readonly runDuration: Histogram;
  readonly modelDuration: Histogram;
  readonly firstChunkDuration: Histogram;
  readonly chunkInterval: Histogram;
  readonly toolDuration: Histogram;
  readonly retryDelay: Histogram;
  readonly tokenUsage: Histogram;
  readonly retryCount: Counter;
  readonly cost: Counter;
}

export interface TelemetryScope {
  endSuccess(attributes?: TelemetryAttributes): void;
  endError(error: unknown): void;
}

export interface TelemetryToolScope extends TelemetryScope {
  readonly span?: Span | undefined;
}

const noopScope = (): TelemetryScope => ({
  endSuccess() {},
  endError() {},
});

const errorType = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error)
    return typeof error.code === "string" ? error.code : "unknown";
  return error instanceof Error ? error.name : typeof error;
};

const safe = (operation: () => void): void => {
  try {
    operation();
  } catch {
    // Observability must never alter application behavior.
  }
};

const metricAttributes = (
  operation: string,
  provider?: string,
  modelId?: string,
): Attributes => ({
  "gen_ai.operation.name": operation,
  "gen_ai.provider.name": provider,
  "gen_ai.request.model": modelId,
});

const recordUsage = (
  metricsSet: MetricSet,
  usage: Usage,
  attributes: Attributes,
): void => {
  const record = (type: string, value: number | undefined): void => {
    if (value !== undefined)
      metricsSet.tokenUsage.record(value, { ...attributes, "gen_ai.token.type": type });
  };
  record("input", usage.inputTokens);
  record("output", usage.outputTokens);
  record("cached_input", usage.cachedInputTokens);
  record("reasoning", usage.reasoningTokens);
};

export class TelemetryRuntime {
  private readonly tracer: Tracer;
  private readonly metrics: MetricSet;
  private readonly commonAttributes: TelemetryAttributes;
  private readonly options: TelemetryOptions;
  private runContext: Context | undefined;
  private runSpan: Span | undefined;

  constructor(options: TelemetryOptions) {
    this.options = options;
    this.tracer = options.tracer ?? trace.getTracer("@open-agent/sdk");
    const meter = options.meter ?? metrics.getMeter("@open-agent/sdk");
    this.commonAttributes = options.attributes ?? {};
    this.metrics = {
      runDuration: meter.createHistogram("open_agent.run.duration", { unit: "s" }),
      modelDuration: meter.createHistogram("gen_ai.client.operation.duration", {
        unit: "s",
      }),
      firstChunkDuration: meter.createHistogram(
        "open_agent.model.first_chunk.duration",
        { unit: "s" },
      ),
      chunkInterval: meter.createHistogram("open_agent.model.chunk.interval", {
        unit: "s",
      }),
      toolDuration: meter.createHistogram("open_agent.tool.duration", { unit: "s" }),
      retryDelay: meter.createHistogram("open_agent.retry.delay", { unit: "s" }),
      tokenUsage: meter.createHistogram("gen_ai.client.token.usage", {
        unit: "{token}",
      }),
      retryCount: meter.createCounter("open_agent.retry.count", {
        unit: "{retry}",
      }),
      cost: meter.createCounter("open_agent.cost", { unit: "{currency}" }),
    };
  }

  startRun(operation: string, runId: string): TelemetryScope {
    const started = performance.now();
    let span: Span;
    try {
      span = this.tracer.startSpan(`open_agent.${operation}`, {
        attributes: {
          ...this.commonAttributes,
          "gen_ai.operation.name": operation,
          "open_agent.run.id": runId,
        },
      });
    } catch {
      return noopScope();
    }
    this.runSpan = span;
    this.runContext = trace.setSpan(otelContext.active(), span);
    return this.scope(span, started, (duration) =>
      this.metrics.runDuration.record(duration, { "gen_ai.operation.name": operation }),
    );
  }

  modelMiddleware(stepNumber: number): LanguageModelMiddleware {
    return {
      generate: (context, request, next) =>
        this.generateModel(context, request, next, stepNumber),
      stream: (context, request, next) =>
        this.streamModel(context, request, next, stepNumber),
    };
  }

  startTool(toolName: string, toolCallId: string, input: unknown): TelemetryToolScope {
    const started = performance.now();
    const attributes: Attributes = {
      ...this.commonAttributes,
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolName,
      "open_agent.tool.call.id": toolCallId,
    };
    if (this.options.recordToolInputs)
      attributes["gen_ai.tool.call.arguments"] = this.serialize(input);
    let span: Span;
    try {
      span = this.tracer.startSpan(
        `execute_tool ${toolName}`,
        { attributes },
        this.runContext,
      );
    } catch {
      return { ...noopScope(), span: undefined };
    }
    const scope = this.scope(span, started, (duration) =>
      this.metrics.toolDuration.record(duration, { "gen_ai.tool.name": toolName }),
    );
    return { span, ...scope };
  }

  recordToolOutput(scope: TelemetryToolScope, output: unknown): void {
    const span = scope.span;
    if (this.options.recordToolOutputs && span)
      safe(() =>
        span.setAttribute("gen_ai.tool.call.result", this.serialize(output)),
      );
  }

  recordRetry(event: {
    readonly delayMs: number;
    readonly error: AgentSdkError;
  }): void {
    const attributes: Attributes = { "error.type": event.error.code };
    safe(() => {
      this.metrics.retryCount.add(1, attributes);
      this.metrics.retryDelay.record(event.delayMs / 1_000, attributes);
      this.runSpan?.addEvent("open_agent.retry", {
        "open_agent.retry.delay_ms": event.delayMs,
        "error.type": event.error.code,
      });
    });
  }

  recordCost(cost: Cost, provider: string, modelId: string): void {
    if (!Number.isFinite(cost.amount) || cost.amount < 0) return;
    safe(() =>
      this.metrics.cost.add(cost.amount, {
        "gen_ai.provider.name": provider,
        "gen_ai.request.model": modelId,
        "open_agent.cost.currency": cost.currency,
      }),
    );
  }

  private async generateModel(
    context: LanguageModelMiddlewareContext,
    request: ModelRequest,
    next: (request: ModelRequest) => Promise<ModelResponse>,
    stepNumber: number,
  ): Promise<ModelResponse> {
    const started = performance.now();
    const attributes = this.modelAttributes(context, "chat", stepNumber);
    let span: Span;
    try {
      span = this.tracer.startSpan(
        `chat ${context.modelId}`,
        { attributes },
        this.runContext,
      );
    } catch {
      return next(request);
    }
    if (this.options.recordInputs)
      safe(() => span.setAttribute("gen_ai.input.messages", this.serialize(request.messages)));
    try {
      const response = await next(request);
      const responseId = response.responseId;
      const responseModelId = response.modelId;
      if (responseId)
        safe(() => span.setAttribute("gen_ai.response.id", responseId));
      if (responseModelId)
        safe(() => span.setAttribute("gen_ai.response.model", responseModelId));
      if (this.options.recordOutputs)
        safe(() => span.setAttribute("gen_ai.output.text", this.redact(response.text)));
      this.finishModel(span, started, context, response.usage, response.finishReason);
      return response;
    } catch (error) {
      this.endSpanError(span, error);
      throw error;
    }
  }

  private async streamModel(
    context: LanguageModelMiddlewareContext,
    request: ModelRequest,
    next: (request: ModelRequest) => Promise<ReadableStream<ModelStreamPart>>,
    stepNumber: number,
  ): Promise<ReadableStream<ModelStreamPart>> {
    const started = performance.now();
    const attributes = this.modelAttributes(context, "chat", stepNumber);
    let span: Span;
    try {
      span = this.tracer.startSpan(
        `chat ${context.modelId}`,
        { attributes },
        this.runContext,
      );
    } catch {
      return next(request);
    }
    if (this.options.recordInputs)
      safe(() => span.setAttribute("gen_ai.input.messages", this.serialize(request.messages)));
    try {
      const source = await next(request);
      const reader = source.getReader();
      let previousChunk = started;
      let first = true;
      let ended = false;
      let output = "";
      return new ReadableStream<ModelStreamPart>({
        pull: async (controller) => {
          try {
            const read = await reader.read();
            if (read.done) {
              if (!ended) this.endSpanError(span, new Error("Stream ended without finish"));
              controller.close();
              reader.releaseLock();
              return;
            }
            const now = performance.now();
            if (first) {
              first = false;
              safe(() =>
                this.metrics.firstChunkDuration.record((now - started) / 1_000, attributes),
              );
            } else {
              safe(() =>
                this.metrics.chunkInterval.record((now - previousChunk) / 1_000, attributes),
              );
            }
            previousChunk = now;
            if (read.value.type === "text-delta") output += read.value.text;
            if (read.value.type === "finish") {
              ended = true;
              if (this.options.recordOutputs)
                safe(() => span.setAttribute("gen_ai.output.text", this.redact(output)));
              this.finishModel(
                span,
                started,
                context,
                read.value.usage,
                read.value.finishReason,
              );
            }
            controller.enqueue(read.value);
          } catch (error) {
            if (!ended) this.endSpanError(span, error);
            controller.error(error);
            reader.releaseLock();
          }
        },
        cancel: async (reason) => {
          if (!ended) this.endSpanError(span, reason);
          await reader.cancel(reason);
          reader.releaseLock();
        },
      });
    } catch (error) {
      this.endSpanError(span, error);
      throw error;
    }
  }

  private modelAttributes(
    context: LanguageModelMiddlewareContext,
    operation: string,
    stepNumber: number,
  ): Attributes {
    return {
      ...this.commonAttributes,
      "gen_ai.operation.name": operation,
      "gen_ai.provider.name": context.provider,
      "gen_ai.request.model": context.modelId,
      "open_agent.step.number": stepNumber,
    };
  }

  private finishModel(
    span: Span,
    started: number,
    context: LanguageModelMiddlewareContext,
    usage: Usage,
    finishReason: string,
  ): void {
    const attributes = metricAttributes("chat", context.provider, context.modelId);
    safe(() => {
      span.setAttributes({
        "gen_ai.response.finish_reasons": [finishReason],
        "gen_ai.usage.input_tokens": usage.inputTokens,
        "gen_ai.usage.output_tokens": usage.outputTokens,
        "open_agent.usage.total_tokens": usage.totalTokens,
        "open_agent.usage.cached_input_tokens": usage.cachedInputTokens,
        "open_agent.usage.reasoning_tokens": usage.reasoningTokens,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      this.metrics.modelDuration.record((performance.now() - started) / 1_000, attributes);
      recordUsage(this.metrics, usage, attributes);
    });
  }

  private scope(
    span: Span,
    started: number,
    recordDuration: (durationSeconds: number) => void,
  ): TelemetryScope {
    let ended = false;
    return {
      endSuccess: (attributes = {}) => {
        if (ended) return;
        ended = true;
        safe(() => {
          span.setAttributes(attributes);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          recordDuration((performance.now() - started) / 1_000);
        });
      },
      endError: (error) => {
        if (ended) return;
        ended = true;
        safe(() => {
          span.setAttribute("error.type", errorType(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
          recordDuration((performance.now() - started) / 1_000);
        });
      },
    };
  }

  private endSpanError(span: Span, error: unknown): void {
    safe(() => {
      span.setAttribute("error.type", errorType(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });
  }

  private serialize(value: unknown): string {
    try {
      return this.redact(JSON.stringify(value));
    } catch {
      return "[unserializable]";
    }
  }

  private redact(value: string): string {
    try {
      return this.options.redact?.(value) ?? value;
    } catch {
      return "[redaction-failed]";
    }
  }
}

export const createTelemetryRuntime = (
  options: TelemetryOptions | undefined,
): TelemetryRuntime | undefined => {
  if (options === undefined || options.enabled === false) return undefined;
  try {
    return new TelemetryRuntime(options);
  } catch {
    return undefined;
  }
};

export const telemetryMiddleware = (
  options: TelemetryOptions,
): LanguageModelMiddleware => {
  const runtime = createTelemetryRuntime(options);
  return (
    runtime?.modelMiddleware(1) ?? {
      generate: (_context, request, next) => next(request),
      stream: (_context, request, next) => next(request),
    }
  );
};

export const modelCost = (
  model: LanguageModel,
  usage: Usage,
  calculate: ((options: { readonly model: LanguageModel; readonly usage: Usage }) => Cost) | undefined,
): Cost | undefined => calculate?.({ model, usage });
