import { failureEnvelope, newRequestId, type FailureEnvelope } from "@chat/contracts";

/**
 * Safe error mapping v0 (P1-12, ERR-001/ERR-003).
 *
 * Unknown throwables are ALWAYS mapped to a generic
 * `INTERNAL_ERROR` envelope. The raw message, stack, and any
 * provider/database text are dropped — fixture failures therefore
 * reveal no secrets, stack traces, or resource existence, even when
 * the original error contained a synthetic secret marker.
 */
export function toSafeError(_error: unknown, requestId?: string): FailureEnvelope {
  return failureEnvelope("INTERNAL_ERROR", "Internal error.", true, requestId ?? newRequestId());
}
