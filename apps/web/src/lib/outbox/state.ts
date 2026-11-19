import {
  MESSAGE_FORBIDDEN_FIELDS,
  MESSAGE_SCHEMA_VERSION,
  validateMessageSendRequest,
  validateMessageSendResponse,
  type MessageSendInput,
  type MessageSendResponse,
} from "@chat/contracts";

import { MessageSendApiError, type MessageSendClientErrorCode } from "../../features/chat/send";

/**
 * Outbox send-state model and bounded retry schedule (`P2-05`, `FR-CHAT-007`,
 * `ERR-002`–`ERR-003`; `DEC-021` §5–§6).
 *
 * Stores ciphertext envelope + metadata only; plaintext message bodies and
 * private keys never enter outbox records. Unacknowledged sends never transition
 * to `sent`; retries reuse the exact same `(clientMessageId, senderDeviceId,
 * payload.encryptedEnvelope)` identity.
 */

export const OUTBOX_MAX_AUTO_ATTEMPTS = 10;
export const OUTBOX_MAX_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Approved exponential backoff baseline in milliseconds (`DEC-021` §6.3):
 * ~0, 5s, 15s, 60s, 300s, 900s, 3600s, 21600s, 86400s.
 */
export const OUTBOX_BACKOFF_SCHEDULE_MS = [
  0, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000,
] as const;

export const OUTBOX_DEFAULT_JITTER_RATIO = 0.2;

export type SendOutboxStatus = "queued" | "sending" | "unknown" | "sent" | "failed";

export type SendFailureReason =
  | "retryable_network"
  | "retryable_server"
  | "rate_limited"
  | "reauth_required"
  | "device_revoked"
  | "blocked"
  | "unavailable"
  | "conflict"
  | "invalid_payload"
  | "crypto_unavailable"
  | "storage_unavailable"
  | "attempts_exhausted";

export interface OutboxRecord {
  schemaVersion: 1;
  accountId: string;
  conversationId: string;
  clientMessageId: string;
  senderDeviceId: string;
  payload: MessageSendInput;
  payloadHash: string;
  status: SendOutboxStatus;
  failureReason: SendFailureReason | null;
  errorCode: MessageSendClientErrorCode | "CRYPTO_FAILED" | "STORAGE_UNAVAILABLE" | null;
  createdAtMs: number;
  firstAttemptAtMs: number | null;
  lastAttemptAtMs: number | null;
  attemptCount: number;
  autoAttemptsUsed: number;
  nextAttemptAtMs: number | null;
  retryAfterMs: number | null;
  committedMessageId: string | null;
  committedSeq: number | null;
  committedAt: string | null;
  updatedAtMs: number;
}

const OUTBOX_FORBIDDEN_FIELDS = new Set<string>([
  ...MESSAGE_FORBIDDEN_FIELDS,
  "privateKey",
  "private_key",
  "recoveryKey",
  "recovery_key",
  "pickle",
]);

function findForbiddenOutboxKey(value: unknown, seen = new WeakSet<object>()): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findForbiddenOutboxKey(item, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (OUTBOX_FORBIDDEN_FIELDS.has(key)) return key;
    const hit = findForbiddenOutboxKey((value as Record<string, unknown>)[key], seen);
    if (hit) return hit;
  }
  return null;
}

export function assertValidOutboxRecord(record: OutboxRecord): void {
  if (record.schemaVersion !== MESSAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported outbox record schemaVersion: ${String(record.schemaVersion)}.`);
  }
  const forbidden = findForbiddenOutboxKey(record);
  if (forbidden) {
    throw new Error(`Forbidden plaintext or secret key "${forbidden}" is disallowed in outbox.`);
  }
  const check = validateMessageSendRequest(record.payload);
  if (!check.ok) {
    throw new Error(`Outbox payload violates message contract: ${check.message}`);
  }
  if (
    record.payload.clientMessageId !== record.clientMessageId ||
    record.payload.senderDeviceId !== record.senderDeviceId
  ) {
    throw new Error("Outbox metadata does not match envelope identity.");
  }
}

export function cloneOutboxRecord(record: OutboxRecord): OutboxRecord {
  return {
    ...record,
    payload: { ...record.payload },
  };
}

export function createQueuedOutboxEntry(input: {
  accountId: string;
  conversationId: string;
  payload: MessageSendInput;
  payloadHash: string;
  nowMs: number;
}): OutboxRecord {
  const entry: OutboxRecord = {
    schemaVersion: 1,
    accountId: input.accountId,
    conversationId: input.conversationId,
    clientMessageId: input.payload.clientMessageId,
    senderDeviceId: input.payload.senderDeviceId,
    payload: { ...input.payload },
    payloadHash: input.payloadHash,
    status: "queued",
    failureReason: null,
    errorCode: null,
    createdAtMs: input.nowMs,
    firstAttemptAtMs: null,
    lastAttemptAtMs: null,
    attemptCount: 0,
    autoAttemptsUsed: 0,
    nextAttemptAtMs: input.nowMs,
    retryAfterMs: null,
    committedMessageId: null,
    committedSeq: null,
    committedAt: null,
    updatedAtMs: input.nowMs,
  };
  assertValidOutboxRecord(entry);
  return entry;
}

export function computeBackoffDelayMs(input: {
  autoAttemptNumber: number;
  retryAfterSeconds?: number | null;
  jitterRatio?: number;
  randomValue?: number;
}): number {
  const index = Math.max(
    0,
    Math.min(input.autoAttemptNumber - 1, OUTBOX_BACKOFF_SCHEDULE_MS.length - 1),
  );
  const baseDelay = OUTBOX_BACKOFF_SCHEDULE_MS[index] ?? 86_400_000;
  const ratio = input.jitterRatio ?? OUTBOX_DEFAULT_JITTER_RATIO;
  const random = input.randomValue ?? 0.5;
  const clampedRandom = Math.max(0, Math.min(1, random));
  const multiplier = 1 + (clampedRandom * 2 - 1) * ratio;
  const jittered = Math.round(baseDelay * multiplier);
  const serverFloor =
    typeof input.retryAfterSeconds === "number" && input.retryAfterSeconds > 0
      ? input.retryAfterSeconds * 1000
      : 0;
  return Math.max(jittered, serverFloor);
}

export function isRetryWindowExhausted(entry: OutboxRecord, nextAttemptAtMs: number): boolean {
  if (entry.autoAttemptsUsed >= OUTBOX_MAX_AUTO_ATTEMPTS) {
    return true;
  }
  if (
    entry.firstAttemptAtMs !== null &&
    nextAttemptAtMs - entry.firstAttemptAtMs >= OUTBOX_MAX_RETRY_WINDOW_MS
  ) {
    return true;
  }
  return false;
}

export function isManualRetryAllowed(reason: SendFailureReason | null): boolean {
  switch (reason) {
    case "attempts_exhausted":
    case "retryable_network":
    case "retryable_server":
    case "rate_limited":
    case "reauth_required":
    case "unavailable":
    case null:
      return true;
    case "conflict":
    case "invalid_payload":
    case "device_revoked":
    case "blocked":
    case "crypto_unavailable":
    case "storage_unavailable":
      return false;
  }
}

export function classifySendFailure(error: unknown): {
  statusOnRetryable: "unknown" | "queued";
  retryable: boolean;
  reason: SendFailureReason;
  errorCode: MessageSendClientErrorCode;
  retryAfterSeconds: number | null;
} {
  if (error instanceof MessageSendApiError) {
    if (error.disposition === "unauthenticated") {
      return {
        statusOnRetryable: "queued",
        retryable: false,
        reason: "reauth_required",
        errorCode: error.code,
        retryAfterSeconds: null,
      };
    }
    if (error.code === "DEVICE_REVOKED") {
      return {
        statusOnRetryable: "queued",
        retryable: false,
        reason: "device_revoked",
        errorCode: error.code,
        retryAfterSeconds: null,
      };
    }
    if (error.code === "BLOCKED") {
      return {
        statusOnRetryable: "queued",
        retryable: false,
        reason: "blocked",
        errorCode: error.code,
        retryAfterSeconds: null,
      };
    }
    if (error.code === "UNAVAILABLE") {
      return {
        statusOnRetryable: "queued",
        retryable: false,
        reason: "unavailable",
        errorCode: error.code,
        retryAfterSeconds: null,
      };
    }
    if (error.code === "IDEMPOTENCY_CONFLICT") {
      return {
        statusOnRetryable: "queued",
        retryable: false,
        reason: "conflict",
        errorCode: error.code,
        retryAfterSeconds: null,
      };
    }
    if (error.code === "RATE_LIMITED") {
      return {
        statusOnRetryable: "queued",
        retryable: true,
        reason: "rate_limited",
        errorCode: error.code,
        retryAfterSeconds: error.retryAfterSeconds ?? 5,
      };
    }
    if (error.disposition === "unknown") {
      return {
        statusOnRetryable: "unknown",
        retryable: true,
        reason: error.code === "NETWORK_ERROR" ? "retryable_network" : "retryable_server",
        errorCode: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }
    if (error.retryable) {
      return {
        statusOnRetryable: "queued",
        retryable: true,
        reason: "retryable_server",
        errorCode: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }
    return {
      statusOnRetryable: "queued",
      retryable: false,
      reason: "invalid_payload",
      errorCode: error.code,
      retryAfterSeconds: null,
    };
  }

  return {
    statusOnRetryable: "unknown",
    retryable: true,
    reason: "retryable_network",
    errorCode: "NETWORK_ERROR",
    retryAfterSeconds: null,
  };
}

export function markAttemptStarted(
  entry: OutboxRecord,
  nowMs: number,
  countsTowardAutoCap = true,
): OutboxRecord {
  if (entry.status === "sent") {
    return cloneOutboxRecord(entry);
  }
  return {
    ...cloneOutboxRecord(entry),
    status: "sending",
    failureReason: null,
    errorCode: null,
    firstAttemptAtMs: entry.firstAttemptAtMs ?? nowMs,
    lastAttemptAtMs: nowMs,
    attemptCount: entry.attemptCount + 1,
    autoAttemptsUsed: countsTowardAutoCap ? entry.autoAttemptsUsed + 1 : entry.autoAttemptsUsed,
    nextAttemptAtMs: null,
    retryAfterMs: null,
    updatedAtMs: nowMs,
  };
}

export function markAttemptSucceeded(
  entry: OutboxRecord,
  response: MessageSendResponse,
  nowMs: number,
): OutboxRecord {
  const validated = validateMessageSendResponse(response);
  if (!validated.ok) {
    throw new Error(`Invalid send acknowledgment payload: ${validated.message}`);
  }
  const msg = validated.value.message;
  if (
    msg.clientMessageId !== entry.clientMessageId ||
    msg.conversationId !== entry.conversationId ||
    msg.senderDeviceId !== entry.senderDeviceId
  ) {
    throw new Error("Acknowledgment identity does not match pending outbox entry.");
  }

  return {
    ...cloneOutboxRecord(entry),
    status: "sent",
    failureReason: null,
    errorCode: null,
    nextAttemptAtMs: null,
    retryAfterMs: null,
    committedMessageId: msg.messageId,
    committedSeq: msg.seq,
    committedAt: msg.committedAt,
    updatedAtMs: nowMs,
  };
}

export function markAttemptOutcomeFailure(
  entry: OutboxRecord,
  error: unknown,
  options: {
    nowMs: number;
    online?: boolean;
    randomValue?: number;
  },
): OutboxRecord {
  if (entry.status === "sent") {
    return cloneOutboxRecord(entry);
  }

  const classified = classifySendFailure(error);
  const nowMs = options.nowMs;

  if (!classified.retryable) {
    return {
      ...cloneOutboxRecord(entry),
      status: "failed",
      failureReason: classified.reason,
      errorCode: classified.errorCode,
      nextAttemptAtMs: null,
      retryAfterMs: null,
      updatedAtMs: nowMs,
    };
  }

  // Compute the next retry candidate within bounded backoff rules.
  const delayMs = computeBackoffDelayMs({
    autoAttemptNumber: Math.max(1, entry.autoAttemptsUsed),
    retryAfterSeconds: classified.retryAfterSeconds,
    randomValue: options.randomValue,
  });
  const candidateNextAt = nowMs + delayMs;

  if (isRetryWindowExhausted(entry, candidateNextAt)) {
    return {
      ...cloneOutboxRecord(entry),
      status: "failed",
      failureReason: "attempts_exhausted",
      errorCode: classified.errorCode,
      nextAttemptAtMs: null,
      retryAfterMs: null,
      updatedAtMs: nowMs,
    };
  }

  // While offline or after timeout/ack-loss, an unresolved previous attempt
  // stays `unknown` while un-dispatched retryable items remain `queued`.
  const nextStatus: SendOutboxStatus =
    classified.statusOnRetryable === "unknown" ? "unknown" : "queued";

  return {
    ...cloneOutboxRecord(entry),
    status: nextStatus,
    failureReason: classified.reason,
    errorCode: classified.errorCode,
    nextAttemptAtMs: candidateNextAt,
    retryAfterMs: delayMs,
    updatedAtMs: nowMs,
  };
}

export function reconcileOutboxAfterReload(
  records: readonly OutboxRecord[],
  nowMs: number,
): OutboxRecord[] {
  return records.map((raw) => {
    assertValidOutboxRecord(raw);
    const entry = cloneOutboxRecord(raw);

    if (entry.status === "sent") {
      return entry;
    }

    if (entry.status === "sending") {
      // Crash/reload mid-flight: preserve exact logical ID & ciphertext and
      // reconcile as `unknown` rather than emitting a duplicate send or false sent.
      if (isRetryWindowExhausted(entry, nowMs)) {
        return {
          ...entry,
          status: "failed",
          failureReason: "attempts_exhausted",
          nextAttemptAtMs: null,
          retryAfterMs: null,
          updatedAtMs: nowMs,
        };
      }
      return {
        ...entry,
        status: "unknown",
        failureReason: entry.failureReason ?? "retryable_network",
        nextAttemptAtMs: nowMs,
        updatedAtMs: nowMs,
      };
    }

    if (
      (entry.status === "queued" || entry.status === "unknown") &&
      isRetryWindowExhausted(entry, nowMs)
    ) {
      return {
        ...entry,
        status: "failed",
        failureReason: "attempts_exhausted",
        nextAttemptAtMs: null,
        retryAfterMs: null,
        updatedAtMs: nowMs,
      };
    }

    return entry;
  });
}

export function markManualRetry(entry: OutboxRecord, nowMs: number): OutboxRecord {
  if (entry.status === "sent") {
    return cloneOutboxRecord(entry);
  }
  if (!isManualRetryAllowed(entry.failureReason)) {
    throw new Error(
      `Manual retry is not permitted for non-retryable failure reason: ${entry.failureReason}`,
    );
  }
  return {
    ...cloneOutboxRecord(entry),
    status: entry.status === "unknown" ? "unknown" : "queued",
    failureReason: null,
    errorCode: null,
    firstAttemptAtMs: nowMs,
    autoAttemptsUsed: 0,
    nextAttemptAtMs: nowMs,
    retryAfterMs: null,
    updatedAtMs: nowMs,
  };
}

export function markDeviceRevokedFailure(entry: OutboxRecord, nowMs: number): OutboxRecord {
  if (entry.status === "sent") {
    return cloneOutboxRecord(entry);
  }
  return {
    ...cloneOutboxRecord(entry),
    status: "failed",
    failureReason: "device_revoked",
    errorCode: "DEVICE_REVOKED",
    nextAttemptAtMs: null,
    retryAfterMs: null,
    updatedAtMs: nowMs,
  };
}
