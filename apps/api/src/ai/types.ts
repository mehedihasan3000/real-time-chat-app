/**
 * Provider-neutral AI boundary for local development.
 *
 * The real AI feature contracts are release-gated by DEC-023/DEC-024 and land
 * with the tasks that implement them. This interface is intentionally narrow:
 * it exists so local development can exercise the adapter boundary without a
 * provider key or a network request.
 */
export interface AiRequest {
  operation: string;
  input: string;
}

export interface AiResult {
  provider: string;
  model: string;
  text: string;
  synthetic: boolean;
}

export interface AiProvider {
  readonly id: string;
  complete(request: AiRequest): Promise<AiResult>;
}
