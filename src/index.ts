import { Agent } from "./core/agent/agent";
import { AgentSdkError, ToolError } from "./core/errors/errors";
import { generateText } from "./core/generation/generate-text";
import { streamText } from "./core/generation/stream-text";
import { defineSchema, tool } from "./core/tools/tool";

export {
  Agent,
  AgentSdkError,
  ToolError,
  defineSchema,
  generateText,
  streamText,
  tool,
};
export * from "./core/index";

export const VERSION = "0.1.0";

export const sdk = Object.freeze({
  Agent,
  AgentSdkError,
  ToolError,
  defineSchema,
  generateText,
  streamText,
  tool,
});
