import { ConfigError, type AppConfig } from "../config.js";
import { MockAiProvider } from "./mock.js";
import type { AiProvider } from "./types.js";

export function createAiProvider(config: AppConfig): AiProvider {
  if (config.ai.provider === "mock") {
    return new MockAiProvider(config.ai.model);
  }

  throw new ConfigError([
    `AI_PROVIDER=${config.ai.provider} is not implemented yet; use AI_PROVIDER=mock for local development.`,
  ]);
}
