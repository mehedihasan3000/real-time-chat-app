import type { AiProvider, AiRequest, AiResult } from "./types.js";

/**
 * Deterministic, network-free AI provider for local development.
 *
 * The output is always marked synthetic so it cannot be mistaken for a real
 * provider response. No prompt text is persisted or logged.
 */
export class MockAiProvider implements AiProvider {
  readonly id = "mock";

  constructor(private readonly model: string = "mock") {}

  async complete(request: AiRequest): Promise<AiResult> {
    return {
      provider: this.id,
      model: this.model,
      text: `[mock:${request.operation}] Synthetic local development response.`,
      synthetic: true,
    };
  }
}
