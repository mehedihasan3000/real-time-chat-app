import {
  isRequestId,
  validateMessageNewEvent,
  type ErrorCode,
  type MessageNewEvent,
} from "@chat/contracts";
import {
  decryptReceivedEnvelope,
  type DecryptCapableDevice,
  type OlmErrorCode,
  type OlmFailureState,
} from "@chat/crypto";

import type { MessageKey } from "../../i18n/catalog";
import type { MessageParams } from "../../i18n/core";

/**
 * Client receive/decrypt timeline & inert display view-models (`P2-06`, `DEC-018`,
 * `FR-CHAT-005`, `FR-CHAT-013`, `FR-CHAT-014`, `NFR-REC-002`, `FR-SEC-013`,
 * `DATA-013`, `ERR-002`, `ERR-003`).
 *
 * Security & privacy invariants:
 * - Decrypted plaintext exists strictly in memory; never written to `localStorage`,
 *   `sessionStorage`, IndexedDB, cookies, or logs (`DATA-013`).
 * - Decrypted UTF-8 text is preserved verbatim (zero normalization or mutation) so
 *   Bengali combining sequences, emoji, and mixed scripts round-trip intact (`TC-CHAT-008`),
 *   while React text-node rendering keeps HTML/script-like content strictly inert (`FR-SEC-013`).
 * - Decryption failures (`missing-key`, `tampered-envelope`, `unsupported-version`,
 *   `replayed-message`, `session-rollback`, `peer-key-blocked`, `invalid-payload`,
 *   `crypto-unavailable`) render explicit localized placeholders, preserve message identity,
 *   and mark `canEmitDeliveryReceipt` / `canEmitReadReceipt` strictly `false` (`FR-CHAT-014`).
 * - Context/account switching bumps an internal epoch so stale async decryptions cannot
 *   mutate a new conversation or account view (`ERR-003`).
 */

export type ParseMessageNewResult =
  | { ok: true; requestId: string; event: MessageNewEvent }
  | { ok: false; code: ErrorCode; message: string };

export function parseMessageNewEventEnvelope(raw: unknown): ParseMessageNewResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Socket message:new envelope must be an object.",
    };
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope.ok !== true) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Socket message:new envelope must have ok: true.",
    };
  }
  if (!isRequestId(envelope.requestId)) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Socket message:new envelope must include a valid server requestId.",
    };
  }
  const validated = validateMessageNewEvent(envelope.data);
  if (!validated.ok) {
    return { ok: false, code: validated.code, message: validated.message };
  }
  return {
    ok: true,
    requestId: envelope.requestId,
    event: validated.value,
  };
}

export interface DecryptedTimelineMessage {
  kind: "decrypted";
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId?: string;
  committedAt: string;
  protocolVersion: string;
  /** Exact UTF-8 decrypted text. Untrusted display input — render via inert text nodes only. */
  plaintext: string;
  sessionId: string;
  messageIndex: number;
  canEmitDeliveryReceipt: true;
  canEmitReadReceipt: true;
}

export interface FailedTimelineMessage {
  kind: "decryption_failed";
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId?: string;
  committedAt: string;
  protocolVersion: string;
  failureState: OlmFailureState;
  code: OlmErrorCode;
  recoverable: boolean;
  canEmitDeliveryReceipt: false;
  canEmitReadReceipt: false;
}

export type ReceivedTimelineMessage = DecryptedTimelineMessage | FailedTimelineMessage;

export type IngestMessageOutcome =
  | { applied: true; item: ReceivedTimelineMessage }
  | {
      applied: false;
      reason: "invalid_envelope" | "wrong_conversation" | "duplicate" | "stale_context";
      item?: ReceivedTimelineMessage;
    };

export interface ReceiveMessageTimelineOptions {
  accountId: string;
  conversationId: string;
  device: DecryptCapableDevice | null;
  expectedPeerIdentityKey?: string;
  expectedPeerSenderKey?: string;
}

export type ReceiveTimelineListener = (items: readonly ReceivedTimelineMessage[]) => void;

export class ReceiveMessageTimeline {
  private accountId: string;
  private conversationId: string;
  private device: DecryptCapableDevice | null;
  private expectedPeerIdentityKey?: string;
  private expectedPeerSenderKey?: string;
  private epoch = 0;
  private disposed = false;
  private readonly itemsById = new Map<string, ReceivedTimelineMessage>();
  private readonly listeners = new Set<ReceiveTimelineListener>();

  constructor(options: ReceiveMessageTimelineOptions) {
    this.accountId = options.accountId;
    this.conversationId = options.conversationId;
    this.device = options.device;
    this.expectedPeerIdentityKey = options.expectedPeerIdentityKey;
    this.expectedPeerSenderKey = options.expectedPeerSenderKey;
  }

  get currentAccountId(): string {
    return this.accountId;
  }

  get currentConversationId(): string {
    return this.conversationId;
  }

  getItems(): ReceivedTimelineMessage[] {
    return Array.from(this.itemsById.values()).sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.messageId.localeCompare(b.messageId);
    });
  }

  subscribe(listener: ReceiveTimelineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.getItems();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  async ingestSocketMessageNew(rawPayload: unknown): Promise<IngestMessageOutcome> {
    const parsed = parseMessageNewEventEnvelope(rawPayload);
    if (!parsed.ok) {
      return { applied: false, reason: "invalid_envelope" };
    }
    return this.ingestMessageEvent(parsed.event);
  }

  async ingestMessageEvent(event: MessageNewEvent): Promise<IngestMessageOutcome> {
    if (this.disposed) {
      return { applied: false, reason: "stale_context" };
    }
    if (event.conversationId !== this.conversationId) {
      return { applied: false, reason: "wrong_conversation" };
    }

    // Deduplicate already-decrypted message IDs before re-invoking Olm so
    // duplicate live deliveries never overwrite valid plaintext with a replay error.
    const existing = this.itemsById.get(event.messageId);
    if (existing && existing.kind === "decrypted") {
      return { applied: false, reason: "duplicate", item: existing };
    }

    const capturedEpoch = this.epoch;
    const capturedAccountId = this.accountId;
    const capturedConversationId = this.conversationId;
    const device = this.device;

    const result = await decryptReceivedEnvelope(device, event, {
      peerUserId: event.senderUserId,
      expectedPeerIdentityKey: this.expectedPeerIdentityKey,
      expectedPeerSenderKey: this.expectedPeerSenderKey,
    });

    // ERR-003 stale completion guard: never mutate a switched or closed context.
    if (
      this.disposed ||
      this.epoch !== capturedEpoch ||
      this.accountId !== capturedAccountId ||
      this.conversationId !== capturedConversationId
    ) {
      return { applied: false, reason: "stale_context" };
    }

    const postAwaitExisting = this.itemsById.get(event.messageId);
    if (postAwaitExisting && postAwaitExisting.kind === "decrypted") {
      return { applied: false, reason: "duplicate", item: postAwaitExisting };
    }

    const item: ReceivedTimelineMessage = result.ok
      ? {
          kind: "decrypted",
          messageId: result.messageId,
          conversationId: result.conversationId,
          seq: result.seq,
          senderUserId: result.senderUserId,
          senderDeviceId: result.senderDeviceId,
          ...(result.clientMessageId !== undefined
            ? { clientMessageId: result.clientMessageId }
            : {}),
          committedAt: result.committedAt,
          protocolVersion: result.protocolVersion,
          plaintext: result.plaintext,
          sessionId: result.sessionId,
          messageIndex: result.messageIndex,
          canEmitDeliveryReceipt: true,
          canEmitReadReceipt: true,
        }
      : {
          kind: "decryption_failed",
          messageId: result.messageId,
          conversationId: result.conversationId,
          seq: result.seq,
          senderUserId: result.senderUserId,
          senderDeviceId: result.senderDeviceId,
          ...(result.clientMessageId !== undefined
            ? { clientMessageId: result.clientMessageId }
            : {}),
          committedAt: result.committedAt,
          protocolVersion: result.protocolVersion,
          failureState: result.failureState,
          code: result.code,
          recoverable: result.recoverable,
          canEmitDeliveryReceipt: false,
          canEmitReadReceipt: false,
        };

    this.itemsById.set(item.messageId, item);
    this.emit();
    return { applied: true, item };
  }

  switchConversation(
    conversationId: string,
    peerKeys?: { expectedPeerIdentityKey?: string; expectedPeerSenderKey?: string },
  ): void {
    this.epoch += 1;
    this.conversationId = conversationId;
    this.expectedPeerIdentityKey = peerKeys?.expectedPeerIdentityKey;
    this.expectedPeerSenderKey = peerKeys?.expectedPeerSenderKey;
    this.itemsById.clear();
    this.emit();
  }

  switchAccount(accountId: string, device: DecryptCapableDevice | null): void {
    this.epoch += 1;
    this.accountId = accountId;
    this.device = device;
    this.itemsById.clear();
    this.emit();
  }

  setDevice(device: DecryptCapableDevice | null): void {
    this.device = device;
  }

  clear(): void {
    this.epoch += 1;
    this.itemsById.clear();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.itemsById.clear();
    this.listeners.clear();
  }
}

export type ReceiveTranslator = (key: MessageKey, params?: MessageParams) => string;
export type ReceiveDateTimeFormatter = (input: Date | string | number) => string;

export interface ReceivedMessageViewModel {
  messageId: string;
  seq: number;
  senderUserId: string;
  kind: "decrypted" | "decryption_failed";
  /** Exact inert UTF-8 text when `kind === "decrypted"`, otherwise `null`. */
  text: string | null;
  statusBadge: string;
  tone: "neutral" | "warning" | "danger";
  placeholderTitle: string | null;
  placeholderDescription: string | null;
  recoveryLabel: string | null;
  recoveryHref: string | null;
  metaLabel: string;
  formattedTime: string;
  canEmitDeliveryReceipt: boolean;
  canEmitReadReceipt: boolean;
  failureState: OlmFailureState | null;
}

function failureCopyKeys(state: OlmFailureState): {
  badgeKey: MessageKey;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  tone: "warning" | "danger";
  recoveryLabelKey?: MessageKey;
  recoveryHref?: string;
} {
  switch (state) {
    case "missing-key":
      return {
        badgeKey: "receiveMessage.badge.missingKey",
        titleKey: "receiveMessage.failure.missingKeyTitle",
        descriptionKey: "receiveMessage.failure.missingKeyDescription",
        tone: "warning",
        recoveryLabelKey: "receiveMessage.action.reviewKeys",
        recoveryHref: "/settings/encryption",
      };
    case "tampered-envelope":
      return {
        badgeKey: "receiveMessage.badge.tampered",
        titleKey: "receiveMessage.failure.tamperedTitle",
        descriptionKey: "receiveMessage.failure.tamperedDescription",
        tone: "danger",
      };
    case "unsupported-version":
      return {
        badgeKey: "receiveMessage.badge.unsupportedVersion",
        titleKey: "receiveMessage.failure.unsupportedVersionTitle",
        descriptionKey: "receiveMessage.failure.unsupportedVersionDescription",
        tone: "warning",
      };
    case "replayed-message":
      return {
        badgeKey: "receiveMessage.badge.replayed",
        titleKey: "receiveMessage.failure.replayedTitle",
        descriptionKey: "receiveMessage.failure.replayedDescription",
        tone: "danger",
      };
    case "session-rollback":
      return {
        badgeKey: "receiveMessage.badge.rollback",
        titleKey: "receiveMessage.failure.rollbackTitle",
        descriptionKey: "receiveMessage.failure.rollbackDescription",
        tone: "danger",
        recoveryLabelKey: "receiveMessage.action.reviewKeys",
        recoveryHref: "/settings/encryption",
      };
    case "peer-key-blocked":
      return {
        badgeKey: "receiveMessage.badge.peerKeyChanged",
        titleKey: "receiveMessage.failure.peerKeyChangedTitle",
        descriptionKey: "receiveMessage.failure.peerKeyChangedDescription",
        tone: "warning",
        recoveryLabelKey: "receiveMessage.action.verifySafetyNumber",
        recoveryHref: "/settings/encryption",
      };
    case "crypto-unavailable":
      return {
        badgeKey: "receiveMessage.badge.cryptoUnavailable",
        titleKey: "receiveMessage.failure.cryptoUnavailableTitle",
        descriptionKey: "receiveMessage.failure.cryptoUnavailableDescription",
        tone: "danger",
      };
    case "invalid-payload":
    default:
      return {
        badgeKey: "receiveMessage.badge.invalidPayload",
        titleKey: "receiveMessage.failure.invalidPayloadTitle",
        descriptionKey: "receiveMessage.failure.invalidPayloadDescription",
        tone: "danger",
      };
  }
}

export function toReceivedMessageViewModel(
  item: ReceivedTimelineMessage,
  t: ReceiveTranslator,
  formatDateTime: ReceiveDateTimeFormatter,
): ReceivedMessageViewModel {
  const formattedTime = formatDateTime(item.committedAt);
  const metaLabel = t("receiveMessage.meta.seqAndTime", {
    seq: item.seq,
    time: formattedTime,
  });

  if (item.kind === "decrypted") {
    return {
      messageId: item.messageId,
      seq: item.seq,
      senderUserId: item.senderUserId,
      kind: "decrypted",
      text: item.plaintext,
      statusBadge: t("receiveMessage.badge.decrypted"),
      tone: "neutral",
      placeholderTitle: null,
      placeholderDescription: null,
      recoveryLabel: null,
      recoveryHref: null,
      metaLabel,
      formattedTime,
      canEmitDeliveryReceipt: true,
      canEmitReadReceipt: true,
      failureState: null,
    };
  }

  const keys = failureCopyKeys(item.failureState);
  return {
    messageId: item.messageId,
    seq: item.seq,
    senderUserId: item.senderUserId,
    kind: "decryption_failed",
    text: null,
    statusBadge: t(keys.badgeKey),
    tone: keys.tone,
    placeholderTitle: t(keys.titleKey),
    placeholderDescription: t(keys.descriptionKey),
    recoveryLabel: keys.recoveryLabelKey ? t(keys.recoveryLabelKey) : null,
    recoveryHref: keys.recoveryHref ?? null,
    metaLabel,
    formattedTime,
    canEmitDeliveryReceipt: false,
    canEmitReadReceipt: false,
    failureState: item.failureState,
  };
}
