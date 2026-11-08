import { ERROR_HTTP_STATUS, failureEnvelope, type ErrorCode } from "@chat/contracts";

/**
 * HTTP helpers (P1-05). Thin adapters over the shared contracts envelope;
 * the contracts package owns the code/status map so web, API, and tests
 * share one table (DEC-023 §8.3).
 */
export { ERROR_HTTP_STATUS, failureEnvelope };

export function errorResponseBody(
  code: ErrorCode,
  message: string,
  retryable: boolean,
  requestId?: string,
) {
  return failureEnvelope(code, message, retryable, requestId);
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}
