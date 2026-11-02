import type { AiProvider, AiRequest, AiResult } from "../../apps/api/src/ai/types.js";

/**
 * Deterministic, network-free provider doubles.
 *
 * A provider double may demonstrate adapter wiring; it does not satisfy a
 * real-provider acceptance requirement. Every response is marked synthetic and
 * every failure carries a stable, non-sensitive code rather than raw provider
 * text.
 */
export type SyntheticProviderFailureCode = "RATE_LIMITED" | "TEMPORARILY_UNAVAILABLE";

export type SyntheticProviderFailure = {
  readonly code: SyntheticProviderFailureCode;
  readonly retryable: boolean;
};

export class SyntheticProviderError extends Error {
  readonly synthetic = true;

  constructor(readonly failure: SyntheticProviderFailure) {
    super(failure.code);
    this.name = "SyntheticProviderError";
  }
}

export class SyntheticAiProvider implements AiProvider {
  readonly id = "synthetic-mock";
  readonly requests: AiRequest[] = [];

  constructor(
    private readonly options: {
      readonly model?: string;
      readonly failWith?: SyntheticProviderFailure;
    } = {},
  ) {}

  async complete(request: AiRequest): Promise<AiResult> {
    this.requests.push({ operation: request.operation, input: request.input });

    if (this.options.failWith) {
      throw new SyntheticProviderError(this.options.failWith);
    }

    return {
      provider: this.id,
      model: this.options.model ?? "synthetic-model",
      text: `[synthetic:${request.operation}] Deterministic fixture response.`,
      synthetic: true,
    };
  }
}

export type SyntheticEmail = {
  readonly to: string;
  readonly template: "verification" | "password-reset" | "security-notice";
  readonly synthetic: true;
};

/**
 * In-memory email double. It records only the minimum routing metadata and
 * never stores a message body, token, or link.
 */
export class SyntheticEmailProvider {
  readonly sent: SyntheticEmail[] = [];

  async send(email: Omit<SyntheticEmail, "synthetic">): Promise<{ accepted: true }> {
    this.sent.push({ ...email, synthetic: true });
    return { accepted: true };
  }
}

export function createProviderMocks(options?: {
  readonly model?: string;
  readonly failWith?: SyntheticProviderFailure;
}) {
  return {
    ai: new SyntheticAiProvider(options),
    email: new SyntheticEmailProvider(),
  } as const;
}
