import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_MAX_PLAINTEXT_CODE_POINTS,
  MESSAGE_SCHEMA_VERSION,
  isDeviceId,
  isErrorCode,
  isOpaqueId,
  validateMessageSendRequest,
  validateMessageSendResponse,
  type Envelope,
  type ErrorCode,
  type MessageSendInput,
  type MessageSendResponse,
} from "@chat/contracts";
import {
  OlmCryptoError,
  assertValidPlaintext,
  olmFailure,
  type OlmAccountDevice,
  type OlmOperationFailure,
  type OlmPeerTarget,
} from "@chat/crypto";

import { errorCopyFor, type ErrorCopy } from "../../i18n/errors.js";

/**
 * Encrypted outbound send pipeline v0 (P2-04, FR-CHAT-002..004, FR-SEC-001,
 * FR-SEC-028, INT-005, ERR-001..003; DEC-018, DEC-021).
 *
 * Provisional under Release-gated DEC-023:
 * - Encrypts message plaintext locally via `OlmAccountDevice.encryptForPeer`
 *   before creating any HTTP payload (fail-closed; no plaintext fallback).
 * - Submits strictly via canonical HTTP `POST /api/v1/conversations/:id/messages`
 *   with `Bearer` auth and `credentials: "omit"`.
 * - Preserves `{ conversationId, payload }` (same `clientMessageId` + exact same
 *   `encryptedEnvelope`) so transient/ack-loss retries never re-encrypt and
 *   always resolve to one durable logical record without `409 IDEMPOTENCY_CONFLICT`.
 * - Never marks a message `sent` prior to validated `200`/`201` server commit ack.
 */
export type MessageSendClientErrorCode = ErrorCode | "INVALID_RESPONSE" | "NETWORK_ERROR";

export type MessageFailureDisposition =
  "unknown" | "retryable_rejected" | "unauthenticated" | "failed";

export class MessageSendApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: MessageSendClientErrorCode,
    public readonly retryable: boolean,
    public readonly disposition: MessageFailureDisposition,
    public readonly requestId: string | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Message send error (${code})`);
    this.name = "MessageSendApiError";
  }
}

export interface PreparedEncryptedSend {
  conversationId: string;
  payload: MessageSendInput;
}

export type PrepareEncryptedSendResult =
  { ok: true; prepared: PreparedEncryptedSend } | { ok: false; failure: OlmOperationFailure };

export interface PrepareEncryptedSendInput {
  conversationId: string;
  senderDevice: Pick<OlmAccountDevice, "encryptForPeer" | "deviceId">;
  peerTarget: OlmPeerTarget;
  plaintext: string;
  clientMessageId?: string;
}

function invalidPayloadFailure(
  code: "INVALID_ENVELOPE" | "PAYLOAD_TOO_LARGE",
  message: string,
): PrepareEncryptedSendResult {
  return {
    ok: false,
    failure: olmFailure(new OlmCryptoError(code, message, false)),
  };
}

/**
 * Step 1 of the canonical send pipeline: validate compose bounds (<= 8,000
 * code points), encrypt plaintext endpoint-to-endpoint using vodozemac Olm,
 * and produce an immutable HTTP send payload (`DEC-021` §3.1, `FR-SEC-001`,
 * `FR-SEC-028`). Returns explicit failure without plaintext fallback on error.
 */
export async function prepareEncryptedSend(
  input: PrepareEncryptedSendInput,
): Promise<PrepareEncryptedSendResult> {
  if (!isOpaqueId(input.conversationId)) {
    return invalidPayloadFailure(
      "INVALID_ENVELOPE",
      "Valid conversationId is required before encrypting a message.",
    );
  }

  try {
    assertValidPlaintext(input.plaintext);
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "PAYLOAD_TOO_LARGE"
        ? ("PAYLOAD_TOO_LARGE" as const)
        : ("INVALID_ENVELOPE" as const);
    return invalidPayloadFailure(
      code,
      code === "PAYLOAD_TOO_LARGE"
        ? `Message exceeds ${MESSAGE_MAX_PLAINTEXT_CODE_POINTS} Unicode code points.`
        : "Message text must be a string.",
    );
  }

  const encrypted = await input.senderDevice.encryptForPeer(input.peerTarget, input.plaintext);
  if (!encrypted.ok) {
    return { ok: false, failure: encrypted };
  }

  const clientMessageId = input.clientMessageId ?? globalThis.crypto.randomUUID();
  const payloadCandidate: MessageSendInput = {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    clientMessageId,
    senderDeviceId: encrypted.value.senderDeviceId,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope: encrypted.value.encryptedEnvelope,
  };

  const validated = validateMessageSendRequest(payloadCandidate);
  if (!validated.ok) {
    return invalidPayloadFailure(
      validated.code === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "INVALID_ENVELOPE",
      validated.message,
    );
  }

  return {
    ok: true,
    prepared: {
      conversationId: input.conversationId,
      payload: validated.value.request,
    },
  };
}

export interface MessageSendClientOptions {
  apiOrigin: string;
  expectedUserId: string;
  expectedDeviceId: string;
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}

export type MessageSendState =
  | { status: "sending"; clientMessageId: string }
  | { status: "sent"; response: MessageSendResponse; clientMessageId: string }
  | {
      status: "unknown";
      clientMessageId: string;
      code: MessageSendClientErrorCode;
      retryAfterSeconds: number | null;
      copy: ErrorCopy;
    }
  | {
      status: "unauthenticated";
      clientMessageId: string;
      code: "UNAUTHENTICATED" | "SESSION_REVOKED";
      copy: ErrorCopy;
    }
  | {
      status: "failed";
      clientMessageId: string;
      code: ErrorCode | "CRYPTO_FAILED";
      retryable: boolean;
      retryAfterSeconds: number | null;
      copy: ErrorCopy;
    };

function assertExactOrigin(apiOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(apiOrigin);
  } catch {
    throw new MessageSendApiError(0, "INVALID_REQUEST", false, "failed");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new MessageSendApiError(0, "INVALID_REQUEST", false, "failed");
  }
  return parsed.origin;
}

function classifyFailure(
  status: number,
  code: MessageSendClientErrorCode,
): MessageFailureDisposition {
  if (code === "UNAUTHENTICATED" || code === "SESSION_REVOKED") return "unauthenticated";
  if (code === "RATE_LIMITED") return "retryable_rejected";
  if (
    code === "NETWORK_ERROR" ||
    code === "INVALID_RESPONSE" ||
    code === "TEMPORARILY_UNAVAILABLE" ||
    code === "INTERNAL_ERROR" ||
    status >= 500 ||
    status === 0
  ) {
    return "unknown";
  }
  return "failed";
}

/**
 * Canonical HTTP client for `POST /api/v1/conversations/:id/messages`.
 * Never uses Socket.IO for writes and never mutates a `PreparedEncryptedSend`
 * on retry (`DEC-021` §3.1 / §5.2).
 */
export class MessageSendClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MessageSendClientOptions) {
    if (!isOpaqueId(options.expectedUserId) || !isDeviceId(options.expectedDeviceId)) {
      throw new MessageSendApiError(0, "INVALID_REQUEST", false, "failed");
    }
    this.origin = assertExactOrigin(options.apiOrigin);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async sendPrepared(prepared: PreparedEncryptedSend): Promise<MessageSendResponse> {
    if (!isOpaqueId(prepared.conversationId)) {
      throw new MessageSendApiError(400, "INVALID_REQUEST", false, "failed");
    }
    if (prepared.payload.senderDeviceId !== this.options.expectedDeviceId) {
      throw new MessageSendApiError(403, "FORBIDDEN", false, "failed");
    }
    const payloadCheck = validateMessageSendRequest(prepared.payload);
    if (!payloadCheck.ok) {
      throw new MessageSendApiError(400, payloadCheck.code, false, "failed");
    }

    const token = await this.options.getToken();
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.origin}/api/v1/conversations/${encodeURIComponent(prepared.conversationId)}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payloadCheck.value.request),
          credentials: "omit",
        },
      );
    } catch {
      throw new MessageSendApiError(0, "NETWORK_ERROR", true, "unknown");
    }

    const retryHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryHeader && /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader.trim()) : null;

    let body: Envelope<unknown> | null = null;
    try {
      body = (await response.json()) as Envelope<unknown>;
    } catch {
      throw new MessageSendApiError(
        response.status,
        "INVALID_RESPONSE",
        response.status >= 500,
        "unknown",
        null,
        retryAfterSeconds,
      );
    }

    if (!body || typeof body !== "object") {
      throw new MessageSendApiError(
        response.status,
        "INVALID_RESPONSE",
        response.status >= 500,
        "unknown",
        null,
        retryAfterSeconds,
      );
    }

    const requestId = typeof body.requestId === "string" ? body.requestId : null;
    if (!response.ok || !body.ok) {
      const code: MessageSendClientErrorCode =
        !body.ok && body.error && isErrorCode(body.error.code)
          ? body.error.code
          : response.status === 401
            ? "UNAUTHENTICATED"
            : "INTERNAL_ERROR";
      const retryable =
        !body.ok && body.error && typeof body.error.retryable === "boolean"
          ? body.error.retryable
          : response.status === 429 || response.status >= 500;
      throw new MessageSendApiError(
        response.status,
        code,
        retryable,
        classifyFailure(response.status, code),
        requestId,
        retryAfterSeconds,
      );
    }

    const validated = validateMessageSendResponse(body.data);
    if (!validated.ok) {
      throw new MessageSendApiError(502, "INVALID_RESPONSE", true, "unknown", requestId);
    }

    const msg = validated.value.message;
    if (
      msg.conversationId !== prepared.conversationId ||
      msg.senderUserId !== this.options.expectedUserId ||
      msg.senderDeviceId !== this.options.expectedDeviceId ||
      msg.clientMessageId !== prepared.payload.clientMessageId
    ) {
      throw new MessageSendApiError(502, "INVALID_RESPONSE", true, "unknown", requestId);
    }

    return validated.value;
  }

  /**
   * Convenience helper returning `prepared` even on `unknown`/retryable errors
   * so callers/outbox layers can safely retry without re-encrypting (`FR-CHAT-004`).
   */
  async composeEncryptAndSend(input: {
    conversationId: string;
    senderDevice: Pick<OlmAccountDevice, "encryptForPeer" | "deviceId">;
    peerTarget: OlmPeerTarget;
    plaintext: string;
    clientMessageId?: string;
  }): Promise<
    | {
        ok: true;
        state: Extract<MessageSendState, { status: "sent" }>;
        prepared: PreparedEncryptedSend;
      }
    | {
        ok: false;
        state: Exclude<MessageSendState, { status: "sending" | "sent" }>;
        prepared?: PreparedEncryptedSend;
      }
  > {
    const prep = await prepareEncryptedSend(input);
    if (!prep.ok) {
      return {
        ok: false,
        state: mapEncryptFailureToState(input.clientMessageId ?? "", prep.failure),
      };
    }

    try {
      const response = await this.sendPrepared(prep.prepared);
      return {
        ok: true,
        prepared: prep.prepared,
        state: {
          status: "sent",
          response,
          clientMessageId: prep.prepared.payload.clientMessageId,
        },
      };
    } catch (error) {
      return {
        ok: false,
        prepared: prep.prepared,
        state: mapSendErrorToState(prep.prepared.payload.clientMessageId, error),
      };
    }
  }
}

export function mapEncryptFailureToState(
  clientMessageId: string,
  failure: OlmOperationFailure,
): Extract<MessageSendState, { status: "failed" }> {
  const mappedCode: ErrorCode | "CRYPTO_FAILED" =
    failure.code === "PAYLOAD_TOO_LARGE"
      ? "PAYLOAD_TOO_LARGE"
      : failure.code === "UNSUPPORTED_PROTOCOL_VERSION"
        ? "UNSUPPORTED_SCHEMA_VERSION"
        : "CRYPTO_FAILED";
  return {
    status: "failed",
    clientMessageId,
    code: mappedCode,
    retryable: failure.retryable,
    retryAfterSeconds: null,
    copy: errorCopyFor(mappedCode === "CRYPTO_FAILED" ? null : mappedCode),
  };
}

export function mapSendErrorToState(
  clientMessageId: string,
  error: unknown,
): Exclude<MessageSendState, { status: "sending" | "sent" }> {
  if (error instanceof MessageSendApiError) {
    if (error.disposition === "unauthenticated") {
      const authCode = error.code === "SESSION_REVOKED" ? "SESSION_REVOKED" : "UNAUTHENTICATED";
      return {
        status: "unauthenticated",
        clientMessageId,
        code: authCode,
        copy: errorCopyFor(authCode),
      };
    }
    if (error.disposition === "unknown") {
      const copyCode =
        error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE"
          ? "TEMPORARILY_UNAVAILABLE"
          : error.code;
      return {
        status: "unknown",
        clientMessageId,
        code: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
        copy: errorCopyFor(copyCode),
      };
    }
    const safeCode =
      error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE"
        ? "INTERNAL_ERROR"
        : error.code;
    return {
      status: "failed",
      clientMessageId,
      code: safeCode,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      copy: errorCopyFor(safeCode),
    };
  }

  return {
    status: "unknown",
    clientMessageId,
    code: "NETWORK_ERROR",
    retryAfterSeconds: null,
    copy: errorCopyFor("TEMPORARILY_UNAVAILABLE"),
  };
}
