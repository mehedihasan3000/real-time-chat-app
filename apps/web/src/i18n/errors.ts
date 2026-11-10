import { isErrorCode, type ErrorCode } from "@chat/contracts";

import type { MessageKey } from "./catalog";

export type ErrorCopy = {
  code: ErrorCode | null;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
};

const errorCopy: Record<ErrorCode, Omit<ErrorCopy, "code">> = {
  INVALID_REQUEST: {
    titleKey: "errors.INVALID_REQUEST.title",
    descriptionKey: "errors.INVALID_REQUEST.description",
  },
  INVALID_CURSOR: {
    titleKey: "errors.INVALID_CURSOR.title",
    descriptionKey: "errors.INVALID_CURSOR.description",
  },
  UNAUTHENTICATED: {
    titleKey: "errors.UNAUTHENTICATED.title",
    descriptionKey: "errors.UNAUTHENTICATED.description",
  },
  SESSION_REVOKED: {
    titleKey: "errors.SESSION_REVOKED.title",
    descriptionKey: "errors.SESSION_REVOKED.description",
  },
  FORBIDDEN: {
    titleKey: "errors.FORBIDDEN.title",
    descriptionKey: "errors.FORBIDDEN.description",
  },
  DEVICE_REVOKED: {
    titleKey: "errors.DEVICE_REVOKED.title",
    descriptionKey: "errors.DEVICE_REVOKED.description",
  },
  NOT_FOUND: {
    titleKey: "errors.NOT_FOUND.title",
    descriptionKey: "errors.NOT_FOUND.description",
  },
  IDEMPOTENCY_CONFLICT: {
    titleKey: "errors.IDEMPOTENCY_CONFLICT.title",
    descriptionKey: "errors.IDEMPOTENCY_CONFLICT.description",
  },
  DEVICE_REPLACEMENT_REQUIRED: {
    titleKey: "errors.DEVICE_REPLACEMENT_REQUIRED.title",
    descriptionKey: "errors.DEVICE_REPLACEMENT_REQUIRED.description",
  },
  PAYLOAD_TOO_LARGE: {
    titleKey: "errors.PAYLOAD_TOO_LARGE.title",
    descriptionKey: "errors.PAYLOAD_TOO_LARGE.description",
  },
  RATE_LIMITED: {
    titleKey: "errors.RATE_LIMITED.title",
    descriptionKey: "errors.RATE_LIMITED.description",
  },
  UNSUPPORTED_SCHEMA_VERSION: {
    titleKey: "errors.UNSUPPORTED_SCHEMA_VERSION.title",
    descriptionKey: "errors.UNSUPPORTED_SCHEMA_VERSION.description",
  },
  CLIENT_UPGRADE_REQUIRED: {
    titleKey: "errors.CLIENT_UPGRADE_REQUIRED.title",
    descriptionKey: "errors.CLIENT_UPGRADE_REQUIRED.description",
  },
  TEMPORARILY_UNAVAILABLE: {
    titleKey: "errors.TEMPORARILY_UNAVAILABLE.title",
    descriptionKey: "errors.TEMPORARILY_UNAVAILABLE.description",
  },
  INTERNAL_ERROR: {
    titleKey: "errors.INTERNAL_ERROR.title",
    descriptionKey: "errors.INTERNAL_ERROR.description",
  },
};

/**
 * Maps a stable server error code to reviewed copy. Unknown codes, raw
 * provider messages, and arbitrary strings all fall back to the generic
 * message; provider text is never returned for display.
 */
export function errorCopyFor(value: unknown): ErrorCopy {
  if (isErrorCode(value)) {
    return { code: value, ...errorCopy[value] };
  }

  return {
    code: null,
    titleKey: "errors.unknown.title",
    descriptionKey: "errors.unknown.description",
  };
}

export function isKnownErrorCode(value: unknown): value is ErrorCode {
  return isErrorCode(value);
}
