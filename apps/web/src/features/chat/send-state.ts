import type { Locale } from "@chat/contracts";
import type { MessageKey } from "../../i18n/catalog";
import { formatDuration, type MessageParams } from "../../i18n/core";
import { errorCopyFor } from "../../i18n/errors";
import {
  OUTBOX_MAX_AUTO_ATTEMPTS,
  isManualRetryAllowed,
  type OutboxRecord,
  type OutboxSnapshot,
  type SendOutboxStatus,
} from "../../lib/outbox/index";

export type OutboxActionKind =
  "retry_now" | "manual_retry" | "sign_in" | "re_enroll_device" | "discard";

export type SendBadgeTone = "neutral" | "progress" | "warning" | "success" | "danger";

export interface SendStateActionViewModel {
  kind: OutboxActionKind;
  labelKey: MessageKey;
}

export interface SendStateItemViewModel {
  clientMessageId: string;
  shortSendId: string;
  status: SendOutboxStatus;
  badgeTone: SendBadgeTone;
  statusLabelKey: MessageKey;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  descriptionParams?: MessageParams;
  attemptCount: number;
  isIndeterminate: boolean;
  committedSeq: number | null;
  actions: SendStateActionViewModel[];
}

export interface SendStateBannerViewModel {
  kind: "disconnected" | "error";
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}

const STATUS_LABEL_KEYS: Record<SendOutboxStatus, MessageKey> = {
  queued: "sendState.status.queued",
  sending: "sendState.status.sending",
  unknown: "sendState.status.unknown",
  sent: "sendState.status.sent",
  failed: "sendState.status.failed",
};

const STATUS_BADGE_TONES: Record<SendOutboxStatus, SendBadgeTone> = {
  queued: "neutral",
  sending: "progress",
  unknown: "warning",
  sent: "success",
  failed: "danger",
};

function shortId(clientMessageId: string): string {
  return clientMessageId.length > 8 ? clientMessageId.slice(0, 8) : clientMessageId;
}

export function buildSendStateBanners(snapshot: OutboxSnapshot): SendStateBannerViewModel[] {
  const banners: SendStateBannerViewModel[] = [];
  if (!snapshot.online) {
    banners.push({
      kind: "disconnected",
      titleKey: "sendState.banner.offlineTitle",
      descriptionKey: "sendState.banner.offlineDescription",
    });
  }
  if (!snapshot.storageAvailable || snapshot.storageNoticeCode === "STORAGE_UNAVAILABLE") {
    banners.push({
      kind: "error",
      titleKey: "states.errorTitle",
      descriptionKey: "sendState.detail.storageUnavailable",
    });
  } else if (snapshot.storageNoticeCode === "STORAGE_CLEARED") {
    banners.push({
      kind: "error",
      titleKey: "states.keyRecoveryTitle",
      descriptionKey: "sendState.detail.storageCleared",
    });
  }
  return banners;
}

/**
 * Map a persisted/in-memory `OutboxRecord` into a strictly localized view model
 * (`FR-CHAT-007`, `ERR-002`). Never renders raw provider errors and never
 * marks an unacknowledged message as `sent`.
 */
export function toSendStateItemViewModel(
  record: OutboxRecord,
  options: { online: boolean; locale: Locale; nowMs?: number },
): SendStateItemViewModel {
  const statusLabelKey = STATUS_LABEL_KEYS[record.status];
  const badgeTone = STATUS_BADGE_TONES[record.status];
  const base = {
    clientMessageId: record.clientMessageId,
    shortSendId: shortId(record.clientMessageId),
    status: record.status,
    badgeTone,
    statusLabelKey,
    attemptCount: record.attemptCount,
    isIndeterminate:
      record.status === "queued" || record.status === "sending" || record.status === "unknown",
    committedSeq: record.committedSeq,
  };

  if (record.status === "sent") {
    return {
      ...base,
      titleKey: statusLabelKey,
      descriptionKey: "sendState.detail.sent",
      descriptionParams: { seq: record.committedSeq ?? 0 },
      actions: [],
    };
  }

  if (record.status === "sending") {
    return {
      ...base,
      titleKey: statusLabelKey,
      descriptionKey: "sendState.detail.sending",
      actions: [],
    };
  }

  if (record.status === "unknown") {
    return {
      ...base,
      titleKey: statusLabelKey,
      descriptionKey: options.online
        ? "sendState.detail.unknown"
        : "sendState.detail.unknownOffline",
      actions: [
        ...(options.online
          ? [{ kind: "retry_now" as const, labelKey: "sendState.action.retryNow" as const }]
          : []),
        { kind: "discard" as const, labelKey: "sendState.action.discard" as const },
      ],
    };
  }

  if (record.status === "queued") {
    if (!options.online) {
      return {
        ...base,
        titleKey: statusLabelKey,
        descriptionKey: "sendState.detail.queuedOffline",
        actions: [{ kind: "discard", labelKey: "sendState.action.discard" }],
      };
    }

    const remainingMs = Math.max(
      1_000,
      record.nextAttemptAtMs !== null && typeof options.nowMs === "number"
        ? record.nextAttemptAtMs - options.nowMs
        : (record.retryAfterMs ?? 5_000),
    );
    const delay = formatDuration(Math.max(1, Math.ceil(remainingMs / 1000)), options.locale);
    return {
      ...base,
      titleKey: statusLabelKey,
      descriptionKey: "sendState.detail.queuedRetry",
      descriptionParams: {
        delay,
        attempt: Math.min(OUTBOX_MAX_AUTO_ATTEMPTS, record.autoAttemptsUsed + 1),
        max: OUTBOX_MAX_AUTO_ATTEMPTS,
      },
      actions: [
        { kind: "retry_now", labelKey: "sendState.action.retryNow" },
        { kind: "discard", labelKey: "sendState.action.discard" },
      ],
    };
  }

  // `failed` status: map deterministically to actionable recovery guidance (ERR-002).
  switch (record.failureReason) {
    case "attempts_exhausted":
      return {
        ...base,
        titleKey: statusLabelKey,
        descriptionKey: "sendState.detail.attemptsExhausted",
        descriptionParams: { max: OUTBOX_MAX_AUTO_ATTEMPTS },
        actions: [
          { kind: "manual_retry", labelKey: "sendState.action.manualRetry" },
          { kind: "discard", labelKey: "sendState.action.discard" },
        ],
      };
    case "reauth_required": {
      const copy = errorCopyFor(record.errorCode ?? "UNAUTHENTICATED");
      return {
        ...base,
        titleKey: copy.titleKey,
        descriptionKey: copy.descriptionKey,
        actions: [
          { kind: "sign_in", labelKey: "sendState.action.signIn" },
          { kind: "discard", labelKey: "sendState.action.discard" },
        ],
      };
    }
    case "device_revoked": {
      const copy = errorCopyFor("DEVICE_REVOKED");
      return {
        ...base,
        titleKey: copy.titleKey,
        descriptionKey: copy.descriptionKey,
        actions: [
          { kind: "re_enroll_device", labelKey: "sendState.action.reEnroll" },
          { kind: "discard", labelKey: "sendState.action.discard" },
        ],
      };
    }
    case "crypto_unavailable":
      return {
        ...base,
        titleKey: statusLabelKey,
        descriptionKey: "sendState.detail.cryptoUnavailable",
        actions: [{ kind: "discard", labelKey: "sendState.action.discard" }],
      };
    case "storage_unavailable":
      return {
        ...base,
        titleKey: statusLabelKey,
        descriptionKey: "sendState.detail.storageUnavailable",
        actions: [{ kind: "discard", labelKey: "sendState.action.discard" }],
      };
    default: {
      const copy = errorCopyFor(record.errorCode);
      const actions: SendStateActionViewModel[] = [];
      if (isManualRetryAllowed(record.failureReason)) {
        actions.push({ kind: "manual_retry", labelKey: "sendState.action.manualRetry" });
      }
      actions.push({ kind: "discard", labelKey: "sendState.action.discard" });
      return {
        ...base,
        titleKey: copy.titleKey,
        descriptionKey: copy.descriptionKey,
        actions,
      };
    }
  }
}
