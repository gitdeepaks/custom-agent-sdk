import { AgentSdkError, OutputValidationError } from "../errors/errors";
import type { JsonValue, ModelOutputFormat } from "../model/types";
import type { Schema, ToolSet } from "../tools/tool";
import {
  generateTextInternal,
  type GenerateTextOptions,
  type GenerateTextResult,
} from "./generate-text";
import { streamTextInternal } from "./stream-text";

export interface ObjectOutputOptions<Output> {
  readonly mode?: "object" | undefined;
  readonly schema: Schema<Output>;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

export interface ArrayOutputOptions<Element> {
  readonly mode: "array";
  readonly schema: Schema<Element>;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

export interface EnumOutputOptions<Values extends readonly string[]> {
  readonly mode: "enum";
  readonly values: Values;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

export interface JsonOutputOptions {
  readonly mode: "json";
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

export interface OutputRepairContext {
  readonly text: string;
  readonly error: OutputValidationError;
}

export type OutputRepair = (
  context: OutputRepairContext,
) => string | Promise<string>;

interface RepairOption {
  readonly repair?: OutputRepair | undefined;
}

export type GenerateObjectOptions<
  Output,
  Tools extends ToolSet = ToolSet,
> = GenerateTextOptions<Tools> & ObjectOutputOptions<Output> & RepairOption;

export interface GenerateObjectResult<Output> extends GenerateTextResult {
  readonly object: Output;
}

export interface StreamObjectResult<Output> {
  /** Incremental, valid JSON snapshots. Only result.object has passed final schema validation. */
  readonly partialObjectStream: ReadableStream<JsonValue>;
  readonly result: Promise<GenerateObjectResult<Output>>;
}

type RuntimeOutputOptions =
  | (ObjectOutputOptions<unknown> & RepairOption)
  | (ArrayOutputOptions<unknown> & RepairOption)
  | (EnumOutputOptions<readonly string[]> & RepairOption)
  | (JsonOutputOptions & RepairOption);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const validationError = (
  message: string,
  cause?: unknown,
): OutputValidationError => new OutputValidationError({ message, cause });

const validateConfiguration = (options: RuntimeOutputOptions): void => {
  if (options.name !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.name))
      throw new AgentSdkError({
        code: "INVALID_ARGUMENT",
        message:
          "Structured output name must contain 1-64 letters, numbers, underscores, or hyphens",
      });
  }
  if (
    options.description !== undefined &&
    (typeof options.description !== "string" ||
      options.description.length === 0)
  )
    throw new AgentSdkError({
      code: "INVALID_ARGUMENT",
      message: "Structured output description must be a non-empty string",
    });
  if (options.mode === "enum") {
    if (
      options.values.length === 0 ||
      options.values.some((value) => typeof value !== "string") ||
      new Set(options.values).size !== options.values.length
    )
      throw new AgentSdkError({
        code: "INVALID_ARGUMENT",
        message:
          "Structured enum values must be a non-empty list of unique strings",
      });
  } else if (options.mode !== "json") {
    if (
      typeof options.schema !== "object" ||
      options.schema === null ||
      typeof options.schema.parse !== "function" ||
      !isJsonValue(options.schema.jsonSchema)
    )
      throw new AgentSdkError({
        code: "INVALID_ARGUMENT",
        message: "Structured output schema is malformed",
      });
  }
};

const outputFormat = (options: RuntimeOutputOptions): ModelOutputFormat => {
  const shared = {
    type: "json" as const,
    name: options.name ?? "structured_output",
    description: options.description,
  };
  if (options.mode === "json") return shared;
  if (options.mode === "enum")
    return { ...shared, schema: { type: "string", enum: [...options.values] } };
  if (options.mode === "array")
    return {
      ...shared,
      schema: { type: "array", items: options.schema.jsonSchema },
    };
  return { ...shared, schema: options.schema.jsonSchema };
};

const parseJson = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (cause) {
    throw validationError("The model returned malformed JSON", cause);
  }
};

const parseOutput = (text: string, options: RuntimeOutputOptions): unknown => {
  const value = parseJson(text);
  if (!isJsonValue(value))
    throw validationError("The model returned a value that is not valid JSON");
  if (options.mode === "json") return value;
  if (options.mode === "enum") {
    if (typeof value !== "string" || !options.values.includes(value))
      throw validationError(
        "The model returned a value outside the configured enum",
      );
    return value;
  }
  if (options.mode === "array") {
    if (!Array.isArray(value))
      throw validationError("The model returned JSON that is not an array");
    try {
      return value.map((element) => options.schema.parse(element));
    } catch (cause) {
      throw validationError(
        "The model returned an array with invalid elements",
        cause,
      );
    }
  }
  if (!isRecord(value))
    throw validationError("The model returned JSON that is not an object");
  try {
    return options.schema.parse(value);
  } catch (cause) {
    throw validationError(
      "The model returned an object that failed schema validation",
      cause,
    );
  }
};

const parseWithRepair = async (
  text: string,
  options: RuntimeOutputOptions,
  generation: GenerateTextResult,
): Promise<unknown> => {
  try {
    return parseOutput(text, options);
  } catch (cause) {
    const original =
      cause instanceof OutputValidationError
        ? cause
        : validationError("The model output failed validation", cause);
    if (!options.repair) throw original.withPartialResult(generation);
    let repaired: string;
    try {
      repaired = await options.repair({ text, error: original });
    } catch (repairCause) {
      throw validationError(
        "The structured output repair callback failed",
        repairCause,
      ).withPartialResult(generation);
    }
    if (typeof repaired !== "string")
      throw validationError(
        "The structured output repair callback must return a string",
      ).withPartialResult(generation);
    try {
      return parseOutput(repaired, options);
    } catch (repairError) {
      throw validationError(
        "The repaired model output failed validation",
        repairError,
      ).withPartialResult(generation);
    }
  }
};

const completePartialJson = (source: string): string | undefined => {
  const trimmed = source.trim();
  if (trimmed.length === 0) return undefined;
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of trimmed) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") closers.push("}");
    else if (character === "[") closers.push("]");
    else if (character === "}" || character === "]") {
      const expected = closers.pop();
      if (expected !== character) return undefined;
    }
  }
  if (escaped) return undefined;
  return `${trimmed}${inString ? '"' : ""}${closers.reverse().join("")}`;
};

const partialJsonValue = (text: string): JsonValue | undefined => {
  const candidate = completePartialJson(text);
  if (candidate === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(candidate);
    return isJsonValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const runStructuredGeneration = async (
  generation: Promise<GenerateTextResult>,
  options: RuntimeOutputOptions,
): Promise<GenerateObjectResult<unknown>> => {
  const result = await generation;
  const object = await parseWithRepair(result.text, options, result);
  return { ...result, object };
};

export function generateObject<Output, Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools> &
    ObjectOutputOptions<Output> &
    RepairOption,
): Promise<GenerateObjectResult<Output>>;
export function generateObject<Element, Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools> &
    ArrayOutputOptions<Element> &
    RepairOption,
): Promise<GenerateObjectResult<readonly Element[]>>;
export function generateObject<
  const Values extends readonly string[],
  Tools extends ToolSet = ToolSet,
>(
  options: GenerateTextOptions<Tools> &
    EnumOutputOptions<Values> &
    RepairOption,
): Promise<GenerateObjectResult<Values[number]>>;
export function generateObject<Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools> & JsonOutputOptions & RepairOption,
): Promise<GenerateObjectResult<JsonValue>>;
export function generateObject(
  options: GenerateTextOptions & RuntimeOutputOptions,
): Promise<GenerateObjectResult<unknown>> {
  return generateObjectInternal(options, options);
}

export const generateObjectInternal = (
  generationOptions: GenerateTextOptions,
  outputOptions: RuntimeOutputOptions,
): Promise<GenerateObjectResult<unknown>> => {
  validateConfiguration(outputOptions);
  return runStructuredGeneration(
    generateTextInternal(generationOptions, outputFormat(outputOptions)),
    outputOptions,
  );
};

const createPartialStream = (
  source: ReadableStream<string>,
): ReadableStream<JsonValue> => {
  const reader = source.getReader();
  let text = "";
  let previous: string | undefined;
  return new ReadableStream<JsonValue>(
    {
      async pull(controller) {
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              reader.releaseLock();
              return;
            }
            text += next.value;
            const value = partialJsonValue(text);
            if (value === undefined) continue;
            const serialized = JSON.stringify(value);
            if (serialized === previous) continue;
            previous = serialized;
            controller.enqueue(value);
            return;
          }
        } catch (error) {
          try {
            reader.releaseLock();
          } catch {
            // The source may already have released its reader after failure.
          }
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
};

export function streamObject<Output, Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools> &
    ObjectOutputOptions<Output> &
    RepairOption,
): StreamObjectResult<Output>;
export function streamObject<Element, Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools> &
    ArrayOutputOptions<Element> &
    RepairOption,
): StreamObjectResult<readonly Element[]>;
export function streamObject<
  const Values extends readonly string[],
  Tools extends ToolSet = ToolSet,
>(
  options: GenerateTextOptions<Tools> &
    EnumOutputOptions<Values> &
    RepairOption,
): StreamObjectResult<Values[number]>;
export function streamObject<Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools> & JsonOutputOptions & RepairOption,
): StreamObjectResult<JsonValue>;
export function streamObject(
  options: GenerateTextOptions & RuntimeOutputOptions,
): StreamObjectResult<unknown> {
  return streamObjectInternal(options, options);
}

export const streamObjectInternal = (
  generationOptions: GenerateTextOptions,
  outputOptions: RuntimeOutputOptions,
): StreamObjectResult<unknown> => {
  validateConfiguration(outputOptions);
  const streamed = streamTextInternal(
    generationOptions,
    outputFormat(outputOptions),
  );
  const result = runStructuredGeneration(streamed.result, outputOptions);
  void result.catch(() => undefined);
  return {
    partialObjectStream: createPartialStream(streamed.textStream),
    result,
  };
};
