import type { LanguageModel } from "../model/types";

/** A provider creates model instances while owning vendor-specific configuration. */
export interface Provider {
  readonly provider: string;
  languageModel(modelId: string): LanguageModel;
}

export type ProviderFactory<Config> = (config?: Config) => Provider;
