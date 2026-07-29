import { Agent } from "./agent";
import { AgentSdkError, ToolError } from "./errors";
import { generateText } from "./generate-text";
import { streamText } from "./stream-text";
import { defineSchema, tool } from "./tool";

export { Agent, AgentSdkError, ToolError, generateText, streamText, defineSchema, tool };
export const VERSION = "0.1.0";
export const sdk = Object.freeze({
  Agent,
  AgentSdkError,
  ToolError,
  generateText,
  streamText,
  defineSchema,
  tool,
});
export type { AgentRunOptions, AgentSettings } from "./agent";
export type { AgentSdkErrorCode } from "./errors";
export {
  type GenerateTextOptions,
  type GenerateTextResult,
  type Prompt,
  type StepResult,
} from "./generate-text";
export type { StreamPart, StreamTextResult } from "./stream-text";
export {
  type AnyTool,
  type InferToolInput,
  type InferToolOutput,
  type Schema,
  type Tool,
  type ToolExecutionContext,
  type ToolSet,
} from "./tool";
export type {
  AssistantMessage,
  FinishReason,
  JsonPrimitive,
  JsonValue,
  LanguageModel,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamPart,
  ModelTool,
  SystemMessage,
  ToolCall,
  ToolMessage,
  Usage,
  UserMessage,
} from "./types";
