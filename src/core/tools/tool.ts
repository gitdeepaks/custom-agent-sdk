import { AgentSdkError } from "../errors/errors";
import type { JsonValue, ModelTool } from "../model/types";

export interface Schema<T> {
  readonly jsonSchema: JsonValue;
  parse(value: unknown): T;
}

export interface ToolExecutionContext {
  readonly runId: string;
  readonly stepNumber: number;
  readonly toolCallId: string;
  readonly idempotencyKey: string;
  readonly context?: unknown;
  readonly abortSignal?: AbortSignal | undefined;
}

export type ToolApprovalOutcome =
  "approved" | "denied" | "user-approval" | "not-applicable";

declare const toolInput: unique symbol;
declare const toolOutput: unique symbol;

export interface Tool<Name extends string, Input, Output> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema?: Schema<Output> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly needsApproval?:
    | boolean
    | ((
        input: Input,
        context: ToolExecutionContext,
      ) => boolean | Promise<boolean>)
    | undefined;
  readonly [toolInput]?: Input;
  readonly [toolOutput]?: Output;
  invoke(value: unknown, context: ToolExecutionContext): Promise<unknown>;
  requiresApproval(
    value: unknown,
    context: ToolExecutionContext,
  ): Promise<boolean>;
}

export interface AnyTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema<unknown>;
  readonly outputSchema?: Schema<unknown> | undefined;
  readonly timeoutMs?: number | undefined;
  invoke(value: unknown, context: ToolExecutionContext): Promise<unknown>;
  requiresApproval(
    value: unknown,
    context: ToolExecutionContext,
  ): Promise<boolean>;
}

export type ITool = AnyTool;

export type ToolSet = Readonly<Record<string, AnyTool>>;

export type InferToolInput<ToolType> =
  ToolType extends Tool<string, infer Input, unknown> ? Input : never;

export type InferToolOutput<ToolType> =
  ToolType extends Tool<string, unknown, infer Output> ? Output : never;

export const tool = <const Name extends string, Input, Output>(options: {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  readonly outputSchema?: Schema<Output> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly needsApproval?:
    | boolean
    | ((
        input: Input,
        context: ToolExecutionContext,
      ) => boolean | Promise<boolean>)
    | undefined;
  readonly execute: (
    input: Input,
    context: ToolExecutionContext,
  ) => Output | Promise<Output>;
}): Tool<Name, Input, Output> => ({
  name: options.name,
  description: options.description,
  inputSchema: options.inputSchema,
  outputSchema: options.outputSchema,
  timeoutMs: options.timeoutMs,
  async requiresApproval(value, context) {
    if (options.needsApproval === undefined) return false;
    if (typeof options.needsApproval === "boolean")
      return options.needsApproval;
    const input = parseToolInput(options.name, options.inputSchema, value);
    return options.needsApproval(input, context);
  },
  async invoke(value, context) {
    const input = parseToolInput(options.name, options.inputSchema, value);
    const output = await options.execute(input, context);
    if (!options.outputSchema) return output;
    try {
      return options.outputSchema.parse(output);
    } catch (error) {
      throw new AgentSdkError({
        code: "TOOL_OUTPUT_INVALID",
        message: `Invalid output from tool "${options.name}"`,
        cause: error,
      });
    }
  },
});

const parseToolInput = <Input>(
  name: string,
  schema: Schema<Input>,
  value: unknown,
): Input => {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new AgentSdkError({
      code: "TOOL_INPUT_INVALID",
      message: `Invalid input for tool "${name}"`,
      cause: error,
    });
  }
};

export interface NormalizedToolRegistry {
  readonly tools: ToolSet;
  readonly names: readonly string[];
}

export const normalizeToolRegistry = (
  tools: ToolSet | undefined,
): NormalizedToolRegistry => {
  if (!tools) return { tools: Object.freeze({}), names: [] };
  const normalized: Record<string, AnyTool> = Object.create(null);
  const names: string[] = [];
  for (const [key, definition] of Object.entries(tools)) {
    if (
      typeof definition !== "object" ||
      definition === null ||
      typeof definition.name !== "string" ||
      definition.name.trim().length === 0 ||
      typeof definition.description !== "string" ||
      typeof definition.inputSchema?.parse !== "function" ||
      (definition.outputSchema !== undefined &&
        typeof definition.outputSchema.parse !== "function") ||
      (definition.timeoutMs !== undefined &&
        (!Number.isInteger(definition.timeoutMs) ||
          definition.timeoutMs < 1 ||
          definition.timeoutMs > 86_400_000)) ||
      typeof definition.invoke !== "function" ||
      typeof definition.requiresApproval !== "function"
    ) {
      throw new AgentSdkError({
        code: "INVALID_ARGUMENT",
        message: `Tool registry entry "${key}" is malformed`,
      });
    }
    if (key !== definition.name)
      throw new AgentSdkError({
        code: "INVALID_ARGUMENT",
        message: `Tool registry key "${key}" does not match declared name "${definition.name}"`,
      });
    normalized[key] = definition;
    names.push(key);
  }
  return { tools: Object.freeze(normalized), names: Object.freeze(names) };
};

export const toModelTools = (
  tools: ToolSet | undefined,
): readonly ModelTool[] =>
  tools
    ? Object.entries(tools).map(([name, definition]) => ({
        name,
        description: definition.description,
        inputSchema: definition.inputSchema.jsonSchema,
      }))
    : [];

export const getTool = (
  tools: ToolSet | undefined,
  name: string,
): AnyTool | undefined => {
  if (!tools || !Object.hasOwn(tools, name)) return undefined;
  return tools[name];
};

export const defineSchema = <T>(options: {
  readonly jsonSchema: JsonValue;
  readonly parse: (value: unknown) => T;
}): Schema<T> => options;
