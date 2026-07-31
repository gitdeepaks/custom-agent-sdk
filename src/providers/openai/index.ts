import { AgentSdkError, type Provider } from "../../core/index";
import {
  OpenAIResponsesLanguageModel,
  type OpenAIModelSettings,
} from "./openai-responses-language-model";

export type { OpenAIModelSettings } from "./openai-responses-language-model";

export interface OpenAIConfig {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetch?: OpenAIFetch | undefined;
}

export type OpenAIFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAIProvider extends Provider {
  readonly provider: "openai";
  languageModel(
    modelId: string,
    settings?: OpenAIModelSettings,
  ): OpenAIResponsesLanguageModel;
}

export const createOpenAI = (config: OpenAIConfig): OpenAIProvider => {
  if (
    !config ||
    typeof config.apiKey !== "string" ||
    config.apiKey.trim() === ""
  ) {
    throw new AgentSdkError({
      code: "INVALID_ARGUMENT",
      message: "OpenAI apiKey must be a non-empty string",
      provider: "openai",
    });
  }

  const baseURL = config.baseURL ?? "https://api.openai.com/v1";
  let responsesURL: string;
  try {
    const normalizedBaseURL = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
    responsesURL = new URL("responses", normalizedBaseURL).toString();
  } catch (cause) {
    throw new AgentSdkError({
      code: "INVALID_ARGUMENT",
      message: "OpenAI baseURL must be a valid absolute URL",
      provider: "openai",
      cause,
    });
  }

  const fetchImplementation = config.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new AgentSdkError({
      code: "INVALID_ARGUMENT",
      message: "A fetch implementation is required",
      provider: "openai",
    });
  }

  return {
    provider: "openai",
    languageModel(modelId, settings) {
      if (typeof modelId !== "string" || modelId.trim() === "") {
        throw new AgentSdkError({
          code: "INVALID_ARGUMENT",
          message: "OpenAI modelId must be a non-empty string",
          provider: "openai",
        });
      }
      return new OpenAIResponsesLanguageModel({
        apiKey: config.apiKey,
        responsesURL,
        headers: config.headers,
        fetch: fetchImplementation,
        modelId,
        settings,
      });
    },
  };
};
