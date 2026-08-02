import { AgentSdkError } from "../errors/errors";
import type {
  FinishReason,
  JsonValue,
  LanguageModel,
  ModelRequest,
  ModelResponse,
  ModelStreamPart,
  ProviderOptions,
  Usage,
} from "../model/types";

export interface LanguageModelMiddlewareContext {
  readonly model: LanguageModel;
  readonly provider: string;
  readonly modelId: string;
}

export type GenerateModelNext = (
  request: ModelRequest,
) => Promise<ModelResponse>;

export type StreamModelNext = (
  request: ModelRequest,
) => Promise<ReadableStream<ModelStreamPart>>;

export interface LanguageModelMiddleware {
  generate(
    context: LanguageModelMiddlewareContext,
    request: ModelRequest,
    next: GenerateModelNext,
  ): Promise<ModelResponse>;
  stream(
    context: LanguageModelMiddlewareContext,
    request: ModelRequest,
    next: StreamModelNext,
  ): Promise<ReadableStream<ModelStreamPart>>;
}

export interface WrapLanguageModelOptions {
  readonly model: LanguageModel;
  /** The first middleware is the outermost middleware. */
  readonly middleware: readonly LanguageModelMiddleware[];
}

const composeGenerate = (
  model: LanguageModel,
  middleware: readonly LanguageModelMiddleware[],
): GenerateModelNext => {
  const context: LanguageModelMiddlewareContext = {
    model,
    provider: model.provider,
    modelId: model.modelId,
  };
  let next: GenerateModelNext = (request) => model.generate(request);
  for (let index = middleware.length - 1; index >= 0; index -= 1) {
    const current = middleware[index];
    if (!current) continue;
    const following = next;
    next = (request) => current.generate(context, request, following);
  }
  return next;
};

const composeStream = (
  model: LanguageModel & Required<Pick<LanguageModel, "stream">>,
  middleware: readonly LanguageModelMiddleware[],
): StreamModelNext => {
  const context: LanguageModelMiddlewareContext = {
    model,
    provider: model.provider,
    modelId: model.modelId,
  };
  let next: StreamModelNext = (request) => model.stream(request);
  for (let index = middleware.length - 1; index >= 0; index -= 1) {
    const current = middleware[index];
    if (!current) continue;
    const following = next;
    next = (request) => current.stream(context, request, following);
  }
  return next;
};

const hasNativeStream = (
  model: LanguageModel,
): model is LanguageModel & Required<Pick<LanguageModel, "stream">> =>
  model.stream !== undefined;

export const wrapLanguageModel = ({
  model,
  middleware,
}: WrapLanguageModelOptions): LanguageModel => {
  const generate = composeGenerate(model, middleware);
  if (!hasNativeStream(model)) {
    return {
      specificationVersion: model.specificationVersion,
      provider: model.provider,
      modelId: model.modelId,
      generate,
    };
  }
  const stream = composeStream(model, middleware);
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    generate,
    stream,
  };
};

export interface DefaultModelSettings {
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly providerOptions?: ProviderOptions | undefined;
}

const withDefaults = (
  request: ModelRequest,
  defaults: DefaultModelSettings,
): ModelRequest => ({
  ...request,
  temperature: request.temperature ?? defaults.temperature,
  maxOutputTokens: request.maxOutputTokens ?? defaults.maxOutputTokens,
  headers:
    defaults.headers === undefined && request.headers === undefined
      ? undefined
      : { ...defaults.headers, ...request.headers },
  providerOptions:
    defaults.providerOptions === undefined && request.providerOptions === undefined
      ? undefined
      : { ...defaults.providerOptions, ...request.providerOptions },
});

export const defaultSettingsMiddleware = (
  defaults: DefaultModelSettings,
): LanguageModelMiddleware => ({
  generate: (_context, request, next) => next(withDefaults(request, defaults)),
  stream: (_context, request, next) => next(withDefaults(request, defaults)),
});

export type LanguageModelLogEvent =
  | {
      readonly type: "model-start";
      readonly operation: "generate" | "stream";
      readonly provider: string;
      readonly modelId: string;
      readonly input?: string | undefined;
    }
  | {
      readonly type: "model-finish";
      readonly operation: "generate" | "stream";
      readonly provider: string;
      readonly modelId: string;
      readonly durationMs: number;
      readonly usage: Usage;
      readonly finishReason: FinishReason;
      readonly output?: string | undefined;
    }
  | {
      readonly type: "model-error";
      readonly operation: "generate" | "stream";
      readonly provider: string;
      readonly modelId: string;
      readonly durationMs: number;
      readonly error: { readonly type: string };
    };

export interface LanguageModelLogger {
  log(event: LanguageModelLogEvent): void | Promise<void>;
}

export interface LoggingMiddlewareOptions {
  readonly logger: LanguageModelLogger;
  readonly recordInputs?: boolean | undefined;
  readonly recordOutputs?: boolean | undefined;
  readonly redact?: ((value: string) => string) | undefined;
}

const safeLog = async (
  logger: LanguageModelLogger,
  event: LanguageModelLogEvent,
): Promise<void> => {
  try {
    await logger.log(event);
  } catch {
    // Diagnostics must never alter a model result.
  }
};

const serializeLogValue = (
  value: unknown,
  redact: ((value: string) => string) | undefined,
): string => {
  try {
    return redact?.(JSON.stringify(value)) ?? JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

const logError = (error: unknown): { readonly type: string } => ({
  type:
    typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.name
        : typeof error,
});

export const loggingMiddleware = (
  options: LoggingMiddlewareOptions,
): LanguageModelMiddleware => ({
  async generate(context, request, next) {
    const started = performance.now();
    await safeLog(options.logger, {
      type: "model-start",
      operation: "generate",
      provider: context.provider,
      modelId: context.modelId,
      input: options.recordInputs
        ? serializeLogValue(request.messages, options.redact)
        : undefined,
    });
    try {
      const response = await next(request);
      await safeLog(options.logger, {
        type: "model-finish",
        operation: "generate",
        provider: context.provider,
        modelId: context.modelId,
        durationMs: performance.now() - started,
        usage: response.usage,
        finishReason: response.finishReason,
        output: options.recordOutputs
          ? (options.redact?.(response.text) ?? response.text)
          : undefined,
      });
      return response;
    } catch (error) {
      await safeLog(options.logger, {
        type: "model-error",
        operation: "generate",
        provider: context.provider,
        modelId: context.modelId,
        durationMs: performance.now() - started,
        error: logError(error),
      });
      throw error;
    }
  },
  async stream(context, request, next) {
    const started = performance.now();
    await safeLog(options.logger, {
      type: "model-start",
      operation: "stream",
      provider: context.provider,
      modelId: context.modelId,
      input: options.recordInputs
        ? serializeLogValue(request.messages, options.redact)
        : undefined,
    });
    try {
      const source = await next(request);
      const reader = source.getReader();
      let output = "";
      let finished = false;
      return new ReadableStream<ModelStreamPart>({
        async pull(controller) {
          try {
            const read = await reader.read();
            if (read.done) {
              if (!finished)
                throw new Error("Model stream ended without a finish event");
              controller.close();
              reader.releaseLock();
              return;
            }
            if (read.value.type === "text-delta") output += read.value.text;
            if (read.value.type === "finish") {
              finished = true;
              await safeLog(options.logger, {
                type: "model-finish",
                operation: "stream",
                provider: context.provider,
                modelId: context.modelId,
                durationMs: performance.now() - started,
                usage: read.value.usage,
                finishReason: read.value.finishReason,
                output: options.recordOutputs
                  ? (options.redact?.(output) ?? output)
                  : undefined,
              });
            }
            controller.enqueue(read.value);
          } catch (error) {
            await safeLog(options.logger, {
              type: "model-error",
              operation: "stream",
              provider: context.provider,
              modelId: context.modelId,
              durationMs: performance.now() - started,
              error: logError(error),
            });
            controller.error(error);
            reader.releaseLock();
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
          reader.releaseLock();
        },
      });
    } catch (error) {
      await safeLog(options.logger, {
        type: "model-error",
        operation: "stream",
        provider: context.provider,
        modelId: context.modelId,
        durationMs: performance.now() - started,
        error: logError(error),
      });
      throw error;
    }
  },
});

export type LanguageModelCacheEntry =
  | {
      readonly operation: "generate";
      readonly response: ModelResponse;
      readonly expiresAt?: number | undefined;
    }
  | {
      readonly operation: "stream";
      readonly parts: readonly ModelStreamPart[];
      readonly expiresAt?: number | undefined;
    };

export interface LanguageModelCache {
  get(key: string): Promise<LanguageModelCacheEntry | undefined>;
  set(key: string, entry: LanguageModelCacheEntry): Promise<void>;
  delete?(key: string): Promise<void>;
}

export class MemoryLanguageModelCache implements LanguageModelCache {
  private readonly entries = new Map<string, LanguageModelCacheEntry>();

  async get(key: string): Promise<LanguageModelCacheEntry | undefined> {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async set(key: string, entry: LanguageModelCacheEntry): Promise<void> {
    this.entries.set(key, structuredClone(entry));
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export interface CacheKeyContext {
  readonly operation: "generate" | "stream";
  readonly provider: string;
  readonly modelId: string;
  readonly request: ModelRequest;
}

export interface CacheMiddlewareOptions {
  readonly cache: LanguageModelCache;
  readonly ttlMs?: number | undefined;
  readonly key?:
    | ((context: CacheKeyContext) => string | undefined | Promise<string | undefined>)
    | undefined;
  readonly maxStreamParts?: number | undefined;
}

const toCanonicalValue = (
  value: unknown,
  seen: Set<object>,
): JsonValue | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (value instanceof URL) return { $url: value.href };
  if (value instanceof Uint8Array)
    return { $bytes: Array.from(value).map((byte) => byte.toString(16).padStart(2, "0")).join("") };
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const canonical = toCanonicalValue(item, seen);
      if (canonical === undefined) return undefined;
      result.push(canonical);
    }
    seen.delete(value);
    return result;
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "abortSignal") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const canonical = toCanonicalValue(descriptor.value, seen);
    if (canonical === undefined && descriptor.value !== undefined) return undefined;
    if (canonical !== undefined) result[key] = canonical;
  }
  seen.delete(value);
  return result;
};

const defaultCacheKey = async (context: CacheKeyContext): Promise<string | undefined> => {
  const canonical = toCanonicalValue(
    {
      operation: context.operation,
      provider: context.provider,
      modelId: context.modelId,
      request: context.request,
    },
    new Set(),
  );
  if (canonical === undefined) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const readCache = async (
  cache: LanguageModelCache,
  key: string,
): Promise<LanguageModelCacheEntry | undefined> => {
  try {
    return await cache.get(key);
  } catch {
    return undefined;
  }
};

const writeCache = async (
  cache: LanguageModelCache,
  key: string,
  entry: LanguageModelCacheEntry,
): Promise<void> => {
  try {
    await cache.set(key, entry);
  } catch {
    // Cache availability must not affect model availability.
  }
};

export const cacheMiddleware = (
  options: CacheMiddlewareOptions,
): LanguageModelMiddleware => {
  if (
    options.ttlMs !== undefined &&
    (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
  )
    throw new AgentSdkError({
      code: "INVALID_ARGUMENT",
      message: "cache ttlMs must be a positive finite number",
    });
  if (
    options.maxStreamParts !== undefined &&
    (!Number.isInteger(options.maxStreamParts) || options.maxStreamParts < 1)
  )
    throw new AgentSdkError({
      code: "INVALID_ARGUMENT",
      message: "cache maxStreamParts must be a positive integer",
    });
  const getKey = options.key ?? defaultCacheKey;
  const expiresAt = (): number | undefined =>
    options.ttlMs === undefined ? undefined : Date.now() + options.ttlMs;
  return {
    async generate(context, request, next) {
      const key = await getKey({
        operation: "generate",
        provider: context.provider,
        modelId: context.modelId,
        request,
      });
      if (key === undefined) return next(request);
      const cached = await readCache(options.cache, key);
      if (cached?.operation === "generate") return structuredClone(cached.response);
      const response = await next(request);
      await writeCache(options.cache, key, {
        operation: "generate",
        response,
        expiresAt: expiresAt(),
      });
      return response;
    },
    async stream(context, request, next) {
      const key = await getKey({
        operation: "stream",
        provider: context.provider,
        modelId: context.modelId,
        request,
      });
      if (key === undefined) return next(request);
      const cached = await readCache(options.cache, key);
      if (cached?.operation === "stream") {
        let index = 0;
        return new ReadableStream<ModelStreamPart>({
          pull(controller) {
            const part = cached.parts[index];
            if (part === undefined) {
              controller.close();
              return;
            }
            index += 1;
            controller.enqueue(structuredClone(part));
          },
        });
      }
      const source = await next(request);
      const reader = source.getReader();
      const parts: ModelStreamPart[] = [];
      const maximum = options.maxStreamParts ?? 10_000;
      let cacheable = true;
      let finished = false;
      return new ReadableStream<ModelStreamPart>({
        async pull(controller) {
          try {
            const read = await reader.read();
            if (read.done) {
              if (cacheable && finished)
                await writeCache(options.cache, key, {
                  operation: "stream",
                  parts,
                  expiresAt: expiresAt(),
                });
              controller.close();
              reader.releaseLock();
              return;
            }
            if (cacheable) {
              if (parts.length >= maximum) cacheable = false;
              else parts.push(structuredClone(read.value));
            }
            if (read.value.type === "finish") finished = true;
            controller.enqueue(read.value);
          } catch (error) {
            controller.error(error);
            reader.releaseLock();
          }
        },
        async cancel(reason) {
          cacheable = false;
          await reader.cancel(reason);
          reader.releaseLock();
        },
      });
    },
  };
};

export interface RetryMiddlewareOptions {
  readonly maxRetries?: number | undefined;
  readonly initialDelayMs?: number | undefined;
  readonly maxDelayMs?: number | undefined;
  readonly backoffFactor?: number | undefined;
  readonly jitter?: number | undefined;
  readonly shouldRetry?:
    | ((error: unknown, operation: "generate" | "stream", attempt: number) => boolean | Promise<boolean>)
    | undefined;
  readonly onRetry?:
    | ((event: {
        readonly operation: "generate" | "stream";
        readonly attempt: number;
        readonly delayMs: number;
        readonly error: unknown;
      }) => void | Promise<void>)
    | undefined;
}

const isRetryable = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return error instanceof TypeError;
  if ("retryable" in error && error.retryable === true) return true;
  if ("status" in error && typeof error.status === "number")
    return error.status === 408 || error.status === 429 || error.status >= 500;
  if ("statusCode" in error && typeof error.statusCode === "number")
    return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
  return error instanceof TypeError;
};

const retryOperation = async <Result>(
  operation: "generate" | "stream",
  request: ModelRequest,
  next: (request: ModelRequest) => Promise<Result>,
  options: RetryMiddlewareOptions,
): Promise<Result> => {
  const maximum = options.maxRetries ?? 2;
  for (let attempt = 0; attempt <= maximum; attempt += 1) {
    try {
      return await next(request);
    } catch (error) {
      const retry = options.shouldRetry
        ? await options.shouldRetry(error, operation, attempt + 1)
        : isRetryable(error);
      if (!retry || attempt === maximum || request.abortSignal?.aborted) throw error;
      const delayMs = Math.min(
        options.maxDelayMs ?? 10_000,
        Math.max(
          typeof error === "object" &&
            error !== null &&
            "retryAfterMs" in error &&
            typeof error.retryAfterMs === "number" &&
            Number.isFinite(error.retryAfterMs)
            ? error.retryAfterMs
            : 0,
          Math.round(
            (options.initialDelayMs ?? 100) *
              (options.backoffFactor ?? 2) ** attempt *
              (1 - (options.jitter ?? 0.2) + Math.random() * (options.jitter ?? 0.2) * 2),
          ),
        ),
      );
      await options.onRetry?.({ operation, attempt: attempt + 1, delayMs, error });
      await new Promise<void>((resolve, reject) => {
        const signal = request.abortSignal;
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, delayMs);
        const abort = (): void => {
          clearTimeout(timer);
          reject(signal?.reason ?? new DOMException("Operation aborted", "AbortError"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  throw new Error("Retry middleware terminated unexpectedly");
};

export const retryMiddleware = (
  options: RetryMiddlewareOptions = {},
): LanguageModelMiddleware => {
  const maxRetries = options.maxRetries ?? 2;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10)
    throw new AgentSdkError({
      code: "INVALID_ARGUMENT",
      message: "retry maxRetries must be an integer between 0 and 10",
    });
  const delays: readonly (readonly [string, number | undefined])[] = [
    ["initialDelayMs", options.initialDelayMs],
    ["maxDelayMs", options.maxDelayMs],
  ];
  for (const [name, value] of delays) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new AgentSdkError({
        code: "INVALID_ARGUMENT",
        message: `retry ${name} must be a non-negative finite number`,
      });
  }
  if (
    options.backoffFactor !== undefined &&
    (!Number.isFinite(options.backoffFactor) ||
      options.backoffFactor < 1 ||
      options.backoffFactor > 10)
  )
    throw new AgentSdkError({
      code: "INVALID_ARGUMENT",
      message: "retry backoffFactor must be between 1 and 10",
    });
  if (
    options.jitter !== undefined &&
    (!Number.isFinite(options.jitter) || options.jitter < 0 || options.jitter > 1)
  )
    throw new AgentSdkError({
      code: "INVALID_ARGUMENT",
      message: "retry jitter must be between 0 and 1",
    });
  return {
    generate: (_context, request, next) =>
      retryOperation("generate", request, next, options),
    stream: (_context, request, next) =>
      retryOperation("stream", request, next, options),
  };
};
