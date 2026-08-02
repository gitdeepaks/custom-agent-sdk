import { Agent } from "./core/agent/agent";
import { AgentSdkError, ToolError } from "./core/errors/errors";
import { generateText } from "./core/generation/generate-text";
import {
  generateObject,
  streamObject,
} from "./core/generation/generate-object";
import { streamText } from "./core/generation/stream-text";
import { defineSchema, tool } from "./core/tools/tool";

export {
  Agent,
  AgentSdkError,
  ToolError,
  defineSchema,
  generateText,
  generateObject,
  streamObject,
  streamText,
  tool,
};
export * from "./core/index";
export { VERSION } from "./version";

export const sdk = Object.freeze({
  Agent,
  AgentSdkError,
  ToolError,
  defineSchema,
  generateText,
  generateObject,
  streamObject,
  streamText,
  tool,
});
