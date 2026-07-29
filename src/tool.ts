import { AgentSdkError } from "./errors";
import type { JsonValue, ModelTool } from "./types";

export interface Schema<T> {
  readonly jsonSchema: JsonValue;
  parse(value: unknown): T;
}

export interface ToolExecutionContext {
  readonly toolCallId: string;
  readonly abortSignal?: AbortSignal | undefined;
}

declare const toolInput: unique symbol;
declare const toolOutput: unique symbol;

export interface Tool<Name extends string, Input, Output> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  readonly [toolInput]?: Input;
  readonly [toolOutput]?: Output;
  invoke(value: unknown, context: ToolExecutionContext): Promise<unknown>;
}

export interface AnyTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema<unknown>;
  invoke(value: unknown, context: ToolExecutionContext): Promise<unknown>;
}

export type ToolSet = Readonly<Record<string, AnyTool>>;

export type InferToolInput<ToolType> = ToolType extends Tool<string, infer Input, unknown>
  ? Input
  : never;

export type InferToolOutput<ToolType> = ToolType extends Tool<string, unknown, infer Output>
  ? Output
  : never;

export const tool = <const Name extends string, Input, Output>(options: {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: Schema<Input>;
  readonly execute: (input: Input, context: ToolExecutionContext) => Output | Promise<Output>;
}): Tool<Name, Input, Output> => ({
  name: options.name,
  description: options.description,
  inputSchema: options.inputSchema,
  async invoke(value, context) {
    let input: Input;
    try {
      input = options.inputSchema.parse(value);
    } catch (error) {
      throw new AgentSdkError({
        code: "TOOL_INPUT_INVALID",
        message: `Invalid input for tool "${options.name}"`,
        cause: error,
      });
    }
    return options.execute(input, context);
  },
});

export const toModelTools = (tools: ToolSet | undefined): readonly ModelTool[] =>
  tools
    ? Object.entries(tools).map(([name, definition]) => ({
        name,
        description: definition.description,
        inputSchema: definition.inputSchema.jsonSchema,
      }))
    : [];

export const defineSchema = <T>(options: {
  readonly jsonSchema: JsonValue;
  readonly parse: (value: unknown) => T;
}): Schema<T> => options;
