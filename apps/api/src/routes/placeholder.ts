import type { Response } from "express";

import {
  BODY_MAX_BYTES,
  ERROR_HTTP_STATUS,
  PLACEHOLDER_MESSAGE,
  failureEnvelope,
  successEnvelope,
  type ErrorCode,
  type ValidationResult,
} from "@chat/contracts";

/** Body bound helper (DEC-016): Express is configured with a 32 KiB limit. */
export const BODY_LIMIT_BYTES = BODY_MAX_BYTES;

/** Safe placeholder: documented 503, never mutates a private store. */
export function sendPlaceholder(response: Response): void {
  response
    .status(ERROR_HTTP_STATUS.TEMPORARILY_UNAVAILABLE)
    .json(failureEnvelope("TEMPORARILY_UNAVAILABLE", PLACEHOLDER_MESSAGE, true));
}

/** Documented empty-list success (placeholder reads reveal no private data). */
export function sendEmptyList(response: Response, data: Record<string, unknown>): void {
  response.status(200).json(successEnvelope(data));
}

/** Safe validation failure (INT-001): stable code, no state mutation. */
export function sendValidationFailure<T>(response: Response, result: ValidationResult<T>): void {
  if (result.ok) return;
  response
    .status(ERROR_HTTP_STATUS[result.code as ErrorCode])
    .json(failureEnvelope(result.code as ErrorCode, result.message, result.retryable));
}

export function isValidationFailure<T>(result: ValidationResult<T>): boolean {
  return !result.ok;
}
